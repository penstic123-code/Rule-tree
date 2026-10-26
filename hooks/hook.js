#!/usr/bin/env node
'use strict';
// Claude Code hook（都在后台运行，不让 AI 等）。规则怎么到 AI 手上交给原生的 .claude/rules（规则文件就是需求树），这里只做原生没有的事：
// - PostToolUse（Edit/Write）：记下 AI 改了哪个需求的文件（面板显示「AI 正在改」）；改的是规则文件，就对照快照记一条改动（面板上可以撤销）
// - InstructionsLoaded：记下这个会话往上下文里加载了哪个规则文件、多少字（上下文用量表）；加载的是说明书时，顺便把旧版本换成新的
const fs = require('fs');
const path = require('path');
const store = require('../src/store');
const T = require('../src/tree');
const { ensureGuide } = require('../src/guide');
const { EDIT_TOOLS, findProjectUp, projectRel, appendTmpLog } = require('../src/common');

const RULES_PREFIX = store.RULES_DIR.split(path.sep).join('/') + '/';
const posix = p => p.split(path.sep).join('/');

// 真实路径：项目经过符号链接打开时，cwd 和文件路径可能一个走链接、一个不走。文件可能已经不在了：解析它所在的文件夹
function realPath(p) {
  try { return fs.realpathSync.native(p); } catch {}
  const parent = path.dirname(p);
  return parent === p ? p : path.join(realPath(parent), path.basename(p));
}
// 规则文件在面板上怎么显示：项目里的用相对路径，项目外的（如 ~/.claude/CLAUDE.md）用绝对路径
const showPath = (file, dir) => {
  const rel = path.relative(dir, file);
  return posix(rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file);
};

// AI 这次改之前，文件是什么样：Claude Code 的 tool_response 里有 originalFile 就用它（新建的文件是 create），
// 没有就从 Edit 的 old_string / new_string 倒推（new_string 在文件里只出现一次，或者 replace_all）。推不出返回 undefined
const count = (s, sub) => (sub ? s.split(sub).length - 1 : 0);
function priorText(input, after) {
  const res = input.tool_response;
  if (res && typeof res === 'object') {
    if (res.type === 'create') return null;
    if (typeof res.originalFile === 'string') return res.originalFile;
  }
  const ti = input.tool_input || {};
  const edits = input.tool_name === 'MultiEdit' ? ti.edits : input.tool_name === 'Edit' ? [ti] : null;
  if (!Array.isArray(edits) || after == null) return undefined;
  let t = after;
  for (const e of [...edits].reverse()) {
    if (!e || typeof e.new_string !== 'string' || typeof e.old_string !== 'string' || !e.new_string) return undefined;
    if (e.replace_all) t = t.split(e.new_string).join(e.old_string);
    else if (count(t, e.new_string) === 1) t = t.replace(e.new_string, () => e.old_string);
    else return undefined;
  }
  return t;
}

function onEdit(input, dir, trace) {
  if (!EDIT_TOOLS.has(input.tool_name)) return;
  const ti = input.tool_input || {};
  const f0 = ti.file_path || ti.notebook_path;
  if (!f0) return;
  const file = realPath(path.resolve(input.cwd || dir, f0));
  const main = posix(path.relative(dir, file));
  const rel = projectRel(dir, file); // 在 worktree 里的按那个 worktree 的根算
  if (rel.startsWith('..') || path.isAbsolute(rel)) return;
  const base = { file: rel, time: Date.now(), session: input.session_id || null, agent: input.agent_id || null };
  if (rel.startsWith(RULES_PREFIX)) {
    const name = rel.slice(RULES_PREFIX.length);
    if (name.includes('/') || !T.isRuleFile(name)) return;
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch {}
    const id = T.parseFile(name, text || '').id;
    // 主仓库里的规则文件：记一条改动。worktree 里的那份合并回来时再记。
    // 知道改之前的样子，就只把 AI 改的那部分算成 AI 的；快照和改之前对不上的（git pull、别处手改）单独记成「其他」
    if (main === rel) {
      const prior = priorText(input, text);
      const e = store.syncFiles(dir, [name], 'AI', prior === undefined ? {} : { known: new Map([[name, prior]]) });
      trace.change = e && e.id;
    }
    store.appendActivity(dir, { ...base, node: id, rule: true });
    trace.node = id;
    return;
  }
  if (/^\.(ruletree|claude)\//.test(rel)) return;
  const node = T.nodeForFile(store.readTree(dir), rel);
  store.appendActivity(dir, { ...base, node: node ? node.id : null });
  trace.node = node && node.id;
  if (node) try { store.touch(dir, [node.id]); } catch (e) { trace.touchError = e.message; }
}

// 一次规则加载记成一行 context.jsonl。Claude Code 对 CLAUDE.md 和 .claude/rules/*.md 触发这个事件，都记下来，
// 用户才能比较谁占了上下文。字数按字符算（中文一个字是 3 个字节）
function onLoad(input, dir) {
  if (!input.file_path) return;
  const file = realPath(path.resolve(input.cwd || dir, input.file_path));
  let text = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  const shown = showPath(file, dir);
  const name = path.posix.basename(shown);
  const ours = shown.startsWith(RULES_PREFIX) && !shown.slice(RULES_PREFIX.length).includes('/');
  const source = ours ? 'ruletree' : /^CLAUDE(\.local)?\.md$/i.test(name) ? 'claude-md' : /(^|\/)\.claude\/rules\//.test(shown) ? 'rules' : 'other';
  const opt = p => (p ? showPath(realPath(path.resolve(input.cwd || dir, p)), dir) : null);
  store.appendContext(dir, {
    session: input.session_id || null, agent: input.agent_id || null, file: shown, chars: text == null ? null : [...text].length,
    reason: input.load_reason || null, memory: input.memory_type || null, source,
    node: ours && T.isRuleFile(name) ? T.parseFile(name, text || '').id : null,
    trigger: opt(input.trigger_file_path), parent: opt(input.parent_file_path), time: Date.now(),
  });
  // 会话开始时加载说明书：说明书是旧版本就换新（这个会话已经读了旧的，下个会话起生效）；日志太长就截短
  if (ours && name === T.GUIDE_FILE) {
    ensureGuide(dir);
    for (const n of ['activity.jsonl', 'context.jsonl']) store.trimLog(dir, n);
    store.trimChanges(dir);
  }
}

function main(input, trace) {
  // 项目目录和改的文件都解析成真实路径，两边才对得上（项目可能经过目录联接、符号链接打开）
  const found = findProjectUp(realPath(input.cwd || process.cwd()));
  const dir = found && realPath(found);
  trace.project = !!dir;
  if (!dir) return;
  if (input.hook_event_name === 'PostToolUse') onEdit(input, dir, trace);
  else if (input.hook_event_name === 'InstructionsLoaded') onLoad(input, dir);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { buf += d; });
process.stdin.on('end', () => {
  // hook 出错时不能挡住 Claude 干活：吞掉异常，记进临时目录的 hook.log
  const trace = {};
  let input = {};
  try { input = JSON.parse(buf || '{}'); main(input, trace); } catch (e) { trace.error = e.stack; }
  const ti = input.tool_input || {};
  appendTmpLog('hook.log', JSON.stringify({ t: new Date().toISOString(), ev: input.hook_event_name, tool: input.tool_name, agent: input.agent_id, session: (input.session_id || '').slice(0, 8), file: ti.file_path || input.file_path, ...trace }));
});
