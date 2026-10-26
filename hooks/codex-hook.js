#!/usr/bin/env node
'use strict';
// OpenAI Codex 的 hook（.codex/hooks.json 指向这里）。Codex 的 hook 输入和 Claude Code 基本同名（session_id、cwd、hook_event_name、tool_name、tool_input），
// 差别由这里处理：
// 1. Codex 没有按路径加载的规则，AGENTS.md 只在会话开始读一次。所以 AI 读写到某个需求的文件时，这里把那几个需求文件作为 additionalContext 送过去
//    （每个会话每份只送一次；内容改了再送）。会话中途托管块（全局规则、索引）变了，下一句话时补送。
// 2. 改文件走 apply_patch（文件名在补丁文本里），在 Windows 上更常见的是 PowerShell 命令（tool_name 是 Bash）。
//    AI 改了规则文件，就对照快照记一条改动（面板上可以撤销），和 Claude 的 hook 一样。
// hook 出错不能挡住 Codex 干活：所有异常吞掉，记进临时目录的 codex-hook.log。
const fs = require('fs');
const path = require('path');
const store = require('../src/store');
const T = require('../src/tree');
const codex = require('../src/targets/codex');
const { tmpDir, findProjectUp, checkoutOf } = require('../src/common');

const readSession = file => { const s = store.readJson(file, null) || {}; return { sent: s.sent && typeof s.sent === 'object' ? s.sent : {}, seen: typeof s.seen === 'string' ? s.seen : null }; };
const blockOf = text => { const at = codex.findBlock(text); return at && !at.broken ? text.slice(at.start, at.end) : ''; };
const readBlock = dir => { try { return blockOf(fs.readFileSync(codex.agentsFile(dir), 'utf8')); } catch { return ''; } };
const fits = text => Buffer.byteLength(text) <= codex.CONTEXT_LIMIT;
function clip(text) {
  if (fits(text)) return text;
  let t = text;
  while (!fits(t + '\n…（截断）')) t = t.slice(0, Math.floor(t.length * 0.9));
  return t + '\n…（截断）';
}
const context = (event, text) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
const RULES_PREFIX = codex.RULES + '/';

function main(input, trace) {
  const cwd = input.cwd || process.cwd();
  const dir = findProjectUp(cwd);
  trace.project = !!dir;
  if (!dir) return '';
  const event = input.hook_event_name;
  const sf = codex.sessionFile(dir, input.session_id);
  const st = readSession(sf);

  if (event === 'SessionStart') {
    // AGENTS.md 在会话开始时已经读进去了：记下 AI 看到的那一版（在 worktree 里是那份检出的），再更新。compact/clear 之后送过的要重送
    const seen = readBlock(checkoutOf(dir, cwd));
    codex.compile(dir);
    store.writeJson(sf, { sent: {}, seen: codex.hash(seen) });
    return '';
  }

  if (event === 'UserPromptSubmit') {
    const c = codex.compile(dir);
    const block = readBlock(dir);
    const notes = c.errors.slice();
    if (block && st.seen && codex.hash(block) !== st.seen) {
      notes.push(fits(block) ? `需求树的全局规则或索引刚更新过，以这一版为准：\n\n${block}` : `需求树的全局规则或索引刚更新过，内容较长，请重新读项目根 ${path.basename(codex.agentsFile(dir))} 里需求树那一段（会话开始时读到的是旧版）。`);
      trace.injected = ['global'];
    }
    if (block) st.seen = codex.hash(block);
    store.writeJson(sf, st);
    return notes.length ? context(event, clip(notes.join('\n\n'))) : '';
  }

  if (event !== 'PostToolUse') return '';
  const ti = input.tool_input || {};
  const isPatch = input.tool_name === 'apply_patch';
  const raw = isPatch ? codex.patchFiles(ti.command) : typeof ti.command === 'string' ? codex.shellPaths(ti.command) : [];
  const rels = [...new Set(raw.map(p => codex.relTo(dir, cwd, p)).filter(Boolean))];
  // 改的是主仓库里的文件（不是某个 worktree 里的）
  const mainRels = new Set(raw.map(p => path.resolve(cwd, String(p).replace(/^['"]|['"]$/g, ''))).filter(a => checkoutOf(dir, path.dirname(a)) === dir).map(a => codex.relTo(dir, cwd, a)));
  trace.files = rels.slice(0, 10);
  if (!rels.length) return '';
  let root = store.readTree(dir);

  // 活动记录（面板上的「AI 正在改」）：apply_patch 的文件是确定的；命令行只在像写文件的命令里、路径确实是项目里的文件时才记
  const writes = isPatch ? rels : codex.isWriteCommand(ti.command)
    ? rels.filter(rel => { try { return fs.statSync(path.join(dir, rel)).isFile(); } catch { return false; } }) : [];
  const ruleNames = [];
  for (const rel of writes) {
    const base = { file: rel, time: Date.now(), session: input.session_id || null, agent: 'codex' };
    if (rel.startsWith(RULES_PREFIX)) {
      const name = rel.slice(RULES_PREFIX.length);
      if (!name.includes('/') && T.isRuleFile(name) && mainRels.has(rel)) ruleNames.push(name);
      continue;
    }
    if (/^\.(ruletree|claude|codex)\//.test(rel)) continue;
    const node = T.nodeForFile(root, rel);
    store.appendActivity(dir, { ...base, node: node ? node.id : null });
    if (node) try { store.touch(dir, [node.id]); } catch {}
  }
  // AI 改了主仓库里的规则文件：记一条改动（在 worktree 里改的那份合并回来时再记）
  if (ruleNames.length) {
    const e = store.syncFiles(dir, ruleNames, 'AI');
    trace.change = e && e.id;
    root = store.readTree(dir);
  }

  // AI 照索引自己读了规则文件：记成已送
  const files = store.readFiles(dir);
  for (const rel of rels) if (rel.startsWith(RULES_PREFIX) && files.has(rel.slice(RULES_PREFIX.length))) st.sent[rel.slice(RULES_PREFIX.length)] = codex.hash(files.get(rel.slice(RULES_PREFIX.length)));
  const due = codex.units(root).filter(n => rels.some(rel => T.matchesAny(n.files, rel)) && st.sent[n.file] !== codex.hash(files.get(n.file) || ''));
  let out = '';
  if (due.length) {
    let body = '需求树：你正在处理的文件属于下面的需求，照这些规则做（每份本会话只发一次，后面不再重复）。';
    for (const n of due) {
      st.sent[n.file] = codex.hash(files.get(n.file) || '');
      const t = codex.bodyOf(files.get(n.file) || '');
      body += fits(`${body}\n\n${t}`) ? `\n\n${t}` : `\n\n${n.id} ${n.title} 的规则较长，请读 ${RULES_PREFIX}${n.file}。`;
    }
    out = context(event, clip(body));
    trace.injected = due.map(n => n.id);
  }
  store.writeJson(sf, st);
  return out;
}

function writeTrace(input, trace, ms) {
  try {
    const f = path.join(tmpDir(), 'codex-hook.log');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (fs.existsSync(f) && fs.statSync(f).size > 512 * 1024) fs.renameSync(f, f + '.old');
    fs.appendFileSync(f, JSON.stringify({ t: new Date().toISOString(), ev: input.hook_event_name, tool: input.tool_name, session: (input.session_id || '').slice(0, 8), ms, ...trace }) + '\n');
  } catch {}
}

if (require.main === module) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { buf += d; });
  process.stdin.on('end', () => {
    const t0 = Date.now();
    const trace = {};
    let input = {}, out = '';
    try { input = JSON.parse(buf || '{}'); out = main(input, trace); } catch (e) { trace.error = e.stack; }
    if (out) process.stdout.write(out);
    writeTrace(input, trace, Date.now() - t0);
  });
}

module.exports = { main };
