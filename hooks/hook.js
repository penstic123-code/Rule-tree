#!/usr/bin/env node
'use strict';
// Claude Code hook。规则怎么到 AI 手上已经交给原生的 .claude/rules（见 src/compile.js），
// 这里只做原生没有的事：
// - UserPromptSubmit：确保规则是最新编译的；记下用户这句话（给记录员用）；
//   这句话明确提到了某个需求（标题、编号、第N章）而它的规则这个会话还没送过，就作为 additionalContext 补上
//   （动手改文件之前的讨论拿不到路径规则）。每个需求每会话只送一次，最多 3 个、约 1500 字，不调用模型
// - PostToolUse（Edit/Write，后台运行）：记下 AI 改了哪个需求的文件（面板显示"AI 正在改"）
// - Stop（后台运行）：把这一轮交给记录员
// - InstructionsLoaded（后台运行）：记下这个会话往上下文里加载了哪个规则文件、多少字（上下文用量表）
// - 补漏：每 sweepEvery 轮（Stop 时）和上下文压缩前（PreCompact），把这段时间用户的原话再交给记录员对照一遍树，
//   单轮判断漏掉的长期要求补上。只在其中有实质内容（不全是「好」「继续」）时才调用模型
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { parse, nodeForFile, pathOf } = require('../src/parser');
const { mentionContext, isMachinePrompt, renderNode } = require('../src/mention');
const { autoLoads } = require('../src/compile');
const store = require('../src/store');
const { tmpDir: STATE_DIR, EDIT_TOOLS, findTreeUp, appendTmpLog } = require('../src/common');

// 这次工具调用改了哪个文件（绝对路径）。只认编辑类工具：命令行改的文件靠猜不可靠，
// 每条命令都启动一次 node 也不划算（这台机器约 0.2 秒），AI 改文件绝大多数走 Edit/Write
function editedFiles(input, cwd) {
  if (!EDIT_TOOLS.has(input.tool_name)) return [];
  const ti = input.tool_input || {};
  const f = ti.file_path || ti.notebook_path;
  return f ? [path.resolve(cwd, f)] : [];
}

// 规则文件在面板上怎么显示：项目里的用相对路径，项目外的（如 ~/.claude/CLAUDE.md）用绝对路径；都用正斜杠
const showPath = (file, projectDir) => {
  const rel = path.relative(projectDir, file);
  return (rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file).split(path.sep).join('/');
};

// 一次规则加载记成一行 context.jsonl。Claude Code 只对 CLAUDE.md 和 .claude/rules/*.md 触发这个事件，
// 都记下来：需求树自己的规则和 CLAUDE.md 等放在一起，用户才能比较谁占了上下文。
// 字数按字符算（[...text].length），不按字节：中文一个字是 3 个字节
function recordLoad(input, treePath) {
  if (!input.file_path) return;
  const projectDir = path.dirname(realPath(treePath));
  const file = realPath(path.resolve(input.cwd || projectDir, input.file_path));
  let chars = null;
  try { chars = [...fs.readFileSync(file, 'utf8')].length; } catch {}
  const shown = showPath(file, projectDir);
  const ours = /^\.claude\/rules\/reqtree\/[^/]+\.md$/.test(shown);
  const source = ours ? 'reqtree' : /^CLAUDE(\.local)?\.md$/i.test(path.basename(file)) ? 'claude-md' : /(^|\/)\.claude\/rules\//.test(shown) ? 'rules' : 'other';
  const id = ours ? path.basename(shown, '.md') : null;
  const opt = p => (p ? showPath(realPath(path.resolve(input.cwd || projectDir, p)), projectDir) : null);
  store.appendContext(treePath, {
    session: input.session_id || null, agent: input.agent_id || null, file: shown, chars,
    reason: input.load_reason || null, memory: input.memory_type || null, source,
    node: id && id !== '_index' ? id : null,
    trigger: opt(input.trigger_file_path), parent: opt(input.parent_file_path), time: Date.now(),
  });
}

// 每个会话四个小文件，各自只有一个写入方：
// - <hash>.json：最近两轮 { user, ai, start } + 最近 RECENT_MAX 句用户原话 recent（补漏用），只有 UserPromptSubmit 写
// - <hash>.sweep.json：上次补漏查到哪一句 { last: start }，只有 Stop / PreCompact 写
// - <hash>.compact.json：上次上下文压缩的时间 { time }，只有 PreCompact 写（压缩后送过的规则要重送）
// - <hash>.ai.json：最近一轮 AI 的回复 { start, ai }，只有 Stop 写
// Stop 是后台运行的，用户回得快时会和下一轮的 UserPromptSubmit 同时跑；两边写同一个文件就会互相盖掉。
// 所以 Stop 只把补上 AI 回复的副本交给记录员，回复另存一份，下一轮 UserPromptSubmit 再并进去。
function stateFile(treePath, session, suffix = '') {
  // Windows、macOS 不分大小写：C:\ 和 c:\ 要算同一个会话
  return path.join(STATE_DIR(), crypto.createHash('md5').update(store.pathKey(treePath) + '|' + (session || '')).digest('hex') + suffix + '.json');
}
// 真实路径：项目经过符号链接、目录联接（或 macOS 的 /var → /private/var）打开时，
// Claude Code 给的 cwd 和文件路径可能一个走链接、一个不走，直接 path.relative 会得到 ../ 开头的路径。
// 文件可能已经不在了（被删、被改名）：解析它所在的文件夹，再接上文件名
function realPath(p) {
  try { return fs.realpathSync.native(p); } catch {}
  const parent = path.dirname(p);
  return parent === p ? p : path.join(realPath(parent), path.basename(p));
}

// 叫 readSession，别和 store.readState（.reqtree/state.json）混
function readSession(file) {
  const s = store.readJson(file, null) || {};
  // 旧版本写的状态文件缺字段，不能假设格式
  const ok = t => t && typeof t.user === 'string';
  return {
    turns: Array.isArray(s.turns) ? s.turns.filter(ok) : [], recent: Array.isArray(s.recent) ? s.recent.filter(ok) : [],
    sent: s.sent && typeof s.sent === 'object' ? s.sent : {}, sentAt: s.sentAt || 0, machineAt: s.machineAt || 0,
    compileWarned: s.compileWarned || 0,
  };
}

// ---------- 补漏 ----------
// 最多攒 20 句，每句截到 1000 字：状态文件最大约 60 KB
const RECENT_MAX = 20;
const RECENT_CLIP = 1000;
function sweepEvery(treePath) {
  const env = process.env.REQTREE_SWEEP_EVERY;
  const n = env != null && env !== '' ? Number(env) : Number(store.readConfig(treePath).sweepEvery);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), RECENT_MAX) : 0;
}
// 上次补漏之后的用户原话。够数（或 force，压缩前）就推进标记；其中有实质内容才返回，否则返回 null
function takeSweep(treePath, session, force) {
  const n = sweepEvery(treePath);
  if (!n) return null;
  const markFile = stateFile(treePath, session, '.sweep');
  const last = (store.readJson(markFile, null) || {}).last || 0;
  const pending = readSession(stateFile(treePath, session)).recent.filter(t => t.start > last);
  if (!pending.length || (!force && pending.length < n)) return null;
  store.writeJson(markFile, { last: pending[pending.length - 1].start });
  const { isTrivial } = require('./recorder');
  return pending.some(t => !isTrivial(t.user.trim())) ? pending.map(t => t.user) : null;
}
// 把 Stop 另存的 AI 回复补进对应的那一轮（按开始时间对上）
function withReply(turns, reply) {
  if (!reply || !reply.ai) return turns;
  return turns.map(t => (t.start === reply.start && !t.ai ? { ...t, ai: reply.ai } : t));
}

// ---------- 补送：原生路径规则没加载时 ----------
// Claude Code 有过路径规则不加载的 bug（#23478、#33581、#61357，最后一个以「不修」关闭：改到匹配的文件时规则没加载）。
// AI 改了需求 X 的文件，这一路上（不含根节点）有规则文件的需求，这个会话、这个 agent 却没有加载记录（InstructionsLoaded，见 recordLoad），
// 就把 X 的规则作为 PostToolUse 的 additionalContext 补送一次，并在 context.jsonl 记一条 reason 'fallback'（顺便统计原生加载失灵有多常见）。
// 不补的情况：这个会话一条加载记录都没有（老版本没有 InstructionsLoaded，补了就是每个需求都补一遍）；
// 用户点名时已经送过 X（UserPromptSubmit 的 sent）；之前补送过（标记文件用 'wx' 独占创建，几个 PostToolUse 同时跑也只补一次）。
// PostToolUse 在后台运行，加载记录也是后台写的，可能晚到一点：有记录但缺这一路的，最多等 FALLBACK_WAIT_MS 再判断
const FALLBACK_WAIT_MS = () => { const v = process.env.REQTREE_FALLBACK_WAIT_MS; return v != null && v !== '' ? Number(v) : 1500; };
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function fallback(treePath, node, rel, input, trace) {
  const expected = pathOf(node).filter(n => n.parent && n.parent.parent && n.rules.length && autoLoads(n)).map(n => n.id);
  if (!expected.length) return null;
  const session = input.session_id || null, agent = input.agent_id || null;
  const sentByMention = readSession(stateFile(treePath, session)).sent;
  if (sentByMention[node.id]) return null;
  const marker = stateFile(treePath, session, `.fallback-${agent || 'main'}-${node.id}`);
  if (fs.existsSync(marker)) return null;
  let missing = expected;
  for (const until = Date.now() + FALLBACK_WAIT_MS(); ;) {
    const mine = store.readContext(treePath, 24 * 3600000).filter(e => e.session === session && (e.agent || null) === agent);
    // 一条都没有：会话开始时总目录就该加载了，到改文件时还没有，说明这个版本不发 InstructionsLoaded，不用等
    if (!mine.length) return null;
    const got = new Set(mine.filter(e => e.source === 'reqtree' && e.node).map(e => e.node));
    missing = expected.filter(id => !got.has(id));
    if (!missing.length) return null;
    if (Date.now() >= until) break;
    sleep(100);
  }
  try { fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.writeFileSync(marker, String(Date.now()), { flag: 'wx' }); } catch { return null; }
  const body = renderNode(node);
  if (!body) return null;
  const text = `需求树：改到 ${rel} 时，Claude Code 没有加载这个需求的规则文件（原生的按路径加载有时会失灵），这里补上：\n\n${body}`;
  store.appendContext(treePath, {
    session, agent, file: `reqtree-fallback/${node.id}`, chars: [...text].length, reason: 'fallback', memory: null, source: 'reqtree',
    node: node.id, trigger: rel, parent: null, missing, time: Date.now(),
  });
  trace.fallback = { node: node.id, missing };
  return text;
}

function startRecorder(job) {
  const dir = STATE_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const jobFile = path.join(dir, `job-${Date.now()}-${process.pid}.json`);
  fs.writeFileSync(jobFile, JSON.stringify(job));
  spawn(process.execPath, [path.join(__dirname, 'recorder.js'), jobFile], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// 会话状态和残留任务文件保留 7 天
function cleanOldState() {
  const cutoff = Date.now() - 7 * 86400000;
  try {
    for (const f of fs.readdirSync(STATE_DIR())) {
      if (!/^([0-9a-f]{32}(\.ai|\.sweep|\.compact|\.fallback-[^.]+-[A-Za-z0-9.]+)?|job-.*)\.json$/.test(f)) continue;
      const p = path.join(STATE_DIR(), f);
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch {}
}

function main(input, trace) {
  if (process.env.REQTREE_RECORDER) return; // 记录员自己调用 claude 时不要再触发
  const cwd = input.cwd || process.cwd();
  // 从 cwd 往上找（Claude Code 可能在项目的子目录里启动）
  const treePath = findTreeUp(cwd);
  trace.tree = !!treePath;
  if (!treePath) return;
  const event = input.hook_event_name;

  if (event === 'UserPromptSubmit') {
    // 树可能在别处被手改过：确保规则是最新的，再把用户编辑期间排队的记录员改动补进去
    store.compileTree(treePath);
    store.flushQueue(treePath);
    const f = stateFile(treePath, input.session_id);
    const st = readSession(f);
    st.turns = withReply(st.turns, store.readJson(stateFile(treePath, input.session_id, '.ai'), null));
    // 后台任务通知、子 agent 回报、命令输出也走 UserPromptSubmit，但不是用户的话：不进对话、不算补漏、不送规则。
    // 记下时间，这之后的 Stop 也跳过（那一轮 AI 回应的是通知）
    if (input.prompt && isMachinePrompt(input.prompt)) {
      st.machineAt = Date.now();
      trace.machine = true;
      store.writeJson(f, st);
      return '';
    }
    if (input.prompt) {
      const start = Date.now();
      st.turns = [...st.turns, { user: input.prompt, ai: '', start }].slice(-2);
      st.recent = [...st.recent, { user: input.prompt.slice(0, RECENT_CLIP), start }].slice(-RECENT_MAX);
    }
    // 编译失败时，原生规则文件可能是旧的。面板上有红色提示，但不开面板的人看不到：
    // 每次失败在下一句用户的话时告诉 AI 一次（编译结果的时间变了才算新的一次）
    const notes = [];
    const comp = store.readCompileStatus(treePath);
    if (comp && !comp.ok && comp.time !== st.compileWarned) {
      notes.push(`需求树编译失败：${comp.message}。.claude/rules/reqtree/ 里的规则可能是旧的，以 ${path.basename(treePath)} 为准。`);
      st.compileWarned = comp.time;
      trace.compileWarned = true;
    }
    // 被提到的需求的规则（Codex 的 hook 自己做，传 REQTREE_NO_MENTION 关掉这里）
    let out = '';
    if (input.prompt && !process.env.REQTREE_NO_MENTION) {
      const compacted = (store.readJson(stateFile(treePath, input.session_id, '.compact'), null) || {}).time || 0;
      if (compacted > st.sentAt) st.sent = {};
      const md5 = t => crypto.createHash('md5').update(t).digest('hex').slice(0, 12);
      // 这个会话最近两小时 AI 改过的需求：只说「第1章」时用来判断是哪门课
      const active = store.readActivity(treePath, 2 * 3600000).filter(e => e.session === input.session_id && e.node).map(e => e.node);
      const m = mentionContext(parse(fs.readFileSync(treePath, 'utf8')), input.prompt, st.sent, md5, { active });
      if (m) {
        for (const { id, hash } of m.ids) st.sent[id] = hash;
        st.sentAt = Date.now();
        trace.mention = m.ids.map(x => x.id);
        notes.push(m.text);
      }
    }
    if (notes.length) out = JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: notes.join('\n\n') } });
    store.writeJson(f, st);
    return out;
  }

  if (event === 'InstructionsLoaded') { recordLoad(input, treePath); return; }

  // 上下文压缩前：把上次补漏之后的原话查一遍（压缩后这些对话就只剩摘要了）
  if (event === 'PreCompact') {
    store.writeJson(stateFile(treePath, input.session_id, '.compact'), { time: Date.now() });
    const sweep = takeSweep(treePath, input.session_id, true);
    trace.sweep = sweep ? sweep.length : 0;
    if (sweep) startRecorder({ treePath, sweep, sweepOnly: true });
    return;
  }

  if (event === 'PostToolUse') {
    const root = parse(fs.readFileSync(treePath, 'utf8'));
    const realTree = realPath(treePath);
    const fallbacks = [];
    for (const file of editedFiles(input, cwd)) {
      const f = realPath(file);
      if (store.samePath(f, realTree)) { store.compileTree(treePath); continue; }
      const rel = path.relative(path.dirname(realTree), f).split(path.sep).join('/');
      if (rel.startsWith('..') || /^\.(reqtree|claude)\//.test(rel)) continue;
      const node = nodeForFile(root, rel);
      trace.rel = rel; trace.node = node && node.id;
      store.appendActivity(treePath, { node: node ? node.id : null, file: rel, time: Date.now(), session: input.session_id, agent: input.agent_id || null });
      const fb = node && fallback(treePath, node, rel, input, trace);
      if (fb) fallbacks.push(fb);
    }
    if (fallbacks.length) return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: fallbacks.join('\n\n') } });
    return;
  }

  if (event === 'Stop' && !input.stop_hook_active) {
    // 只读会话状态，不写（见 stateFile 的说明）
    const replyFile = stateFile(treePath, input.session_id, '.ai');
    const session = readSession(stateFile(treePath, input.session_id));
    const turns = withReply(session.turns, store.readJson(replyFile, null));
    const turn = turns[turns.length - 1];
    // 这一轮是在回应通知，不是用户的话：不交给记录员，也不把回复记到上一轮用户的话下面
    if (session.machineAt && (!turn || session.machineAt > turn.start)) {
      trace.skip = 'machine-prompt';
      store.trimActivity(treePath);
      return;
    }
    if (turn) {
      turn.ai = input.last_assistant_message || '';
      store.writeJson(replyFile, { start: turn.start, ai: turn.ai });
    }
    // 这一轮 AI 改过的需求和还没归属的文件
    const since = turn ? turn.start : Date.now() - 30 * 60000;
    const acts = store.readActivity(treePath, Date.now() - since).filter(e => e.session === input.session_id);
    const touched = [...new Set(acts.filter(e => e.node).map(e => e.node))];
    const unmapped = [...new Set(acts.filter(e => !e.node).map(e => e.file))].slice(0, 20);
    // 先启动记录员：记最后改动时间要拿 state.lock，万一拿不到（锁一直被占）也不能耽误记录员和后面的整理。
    // 最后改动时间只用来提示「久未动」，这一轮没记上影响不大，记进 hook.log 方便排查
    const sweep = takeSweep(treePath, input.session_id, false);
    if (sweep) trace.sweep = sweep.length;
    startRecorder({ treePath, turns, transcriptPath: input.transcript_path, touched, unmapped, ...(sweep ? { sweep } : {}) });
    if (touched.length) try { store.touch(treePath, touched); } catch (e) { trace.touchError = e.message; }
    store.trimActivity(treePath);
    store.trimContext(treePath);
    cleanOldState();
  }
}

// 每次触发记一行到临时目录的 hook.log，排查"hook 到底有没有跑、Claude Code 传了什么"用
function writeTrace(input, trace) {
  const ti = input.tool_input || {};
  appendTmpLog('hook.log', JSON.stringify({
    t: new Date().toISOString(), ev: input.hook_event_name, tool: input.tool_name, agent: input.agent_id,
    session: (input.session_id || '').slice(0, 8), file: ti.file_path, hasPrompt: !!input.prompt,
    hasLastMsg: !!input.last_assistant_message, ...trace,
  }));
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { buf += d; });
process.stdin.on('end', () => {
  // hook 出错时不能挡住 Claude 干活：吞掉异常，记进日志
  const trace = {};
  let input = {};
  let out = '';
  try { input = JSON.parse(buf || '{}'); out = main(input, trace) || ''; }
  catch (e) { trace.error = e.stack; }
  if (out) process.stdout.write(out);
  if (!process.env.REQTREE_RECORDER) writeTrace(input, trace);
});
