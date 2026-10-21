#!/usr/bin/env node
'use strict';
// OpenAI Codex 的 hook（.codex/hooks.json 指向这里）。Codex 的 hook 输入和 Claude Code 基本同名
// （session_id、cwd、hook_event_name、prompt、last_assistant_message、tool_name、tool_input、stop_hook_active），
// 差别在两处，由这里处理：
// 1. 规则怎么到 AI 手上：Codex 没有按路径加载的规则，AGENTS.md 只在会话开始读一次。所以 AI 读写到某个需求的文件时，
//    这里把那份规则作为 additionalContext 送过去（每个会话每份只送一次；规则改了再送）。会话中途全局规则变了，下一句话时补送。
// 2. 改文件走 apply_patch（文件名在补丁文本 tool_input.command 的 *** Update File: 行里，不在 file_path），
//    在 Windows 上更常见的是 PowerShell 命令（tool_name 是 Bash，2026-10-22 实测 gpt-6-luna 全用 Set-Content）。
// 其余（记下用户原话、启动记录员）交给 hook.js，记录员改用 codex exec 调小模型。
// hook 出错不能挡住 Codex 干活：所有异常吞掉，记进临时目录的 codex-hook.log。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parse, nodeForFile, findById, pathOf } = require('../src/parser');
const store = require('../src/store');
const codex = require('../src/targets/codex');
const { mentionContext } = require('../src/mention');

const HOOK = path.join(__dirname, 'hook.js');
const LOG_DIR = () => path.join(os.tmpdir(), 'reqtree');

// 从 cwd 往上找需求树，到 git 根为止（Codex 可能在子目录里启动）
function findTreeUp(dir) {
  for (let d = path.resolve(dir); ;) {
    const t = store.findTree(d);
    if (t) return t;
    const up = path.dirname(d);
    if (up === d || fs.existsSync(path.join(d, '.git'))) return null;
    d = up;
  }
}

function readSession(file) {
  const s = store.readJson(file, null) || {};
  return { sent: s.sent && typeof s.sent === 'object' ? s.sent : {}, seen: typeof s.seen === 'string' ? s.seen : null };
}

const blockOf = text => {
  const i = text.indexOf(codex.BEGIN), j = text.indexOf(codex.END);
  return i >= 0 && j > i ? text.slice(i, j + codex.END.length) : '';
};
const readBlock = projectDir => { try { return blockOf(fs.readFileSync(codex.agentsFile(projectDir), 'utf8')); } catch { return ''; } };

// 交给 hook.js（同步：它很快，记录员它自己放后台）。记录员的模型命令通过环境变量换成 codex exec
function delegate(payload, projectDir, trace) {
  const env = { ...process.env };
  if ((payload.hook_event_name === 'Stop' || payload.hook_event_name === 'PreCompact') && !env.REQTREE_CLAUDE_CMD) {
    const cmd = codex.recorderCommand(projectDir);
    if (cmd) env.REQTREE_CLAUDE_CMD = cmd; else trace.recorder = '找不到 codex 命令';
  }
  // 被提到的需求的规则由这里送（和按文件送的规则共用一份「送过了」的记录），hook.js 那边关掉
  if (payload.hook_event_name === 'UserPromptSubmit') env.REQTREE_NO_MENTION = '1';
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), env, windowsHide: true, timeout: 20000 });
  if (r.error) trace.delegateError = r.error.message;
}

function context(event, text) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
}

const unitText = (u, treeName) => codex.renderUnit(u, treeName).split('\n').filter(l => !l.startsWith('<!--')).join('\n').trim();

function main(input, trace) {
  if (process.env.REQTREE_RECORDER) return ''; // 记录员自己调用 codex 时不要再触发
  const cwd = input.cwd || process.cwd();
  const treePath = findTreeUp(cwd);
  trace.tree = !!treePath;
  if (!treePath) return '';
  const projectDir = path.dirname(treePath);
  const treeName = path.basename(treePath);
  const event = input.hook_event_name;
  const sf = codex.sessionFile(projectDir, input.session_id);
  const st = readSession(sf);
  let out = '';

  if (event === 'SessionStart') {
    // AGENTS.md 在会话开始时已经读进去了：记下 AI 看到的那一版，再编译。compact/clear 之后上下文清空，送过的规则要重送
    const seen = readBlock(projectDir);
    store.compileTree(treePath);
    store.writeJson(sf, { sent: {}, seen: codex.hash(seen) });
    return '';
  }

  if (event === 'UserPromptSubmit') {
    delegate({ ...input, cwd: projectDir }, projectDir, trace); // 编译 + 记下用户原话
    const block = readBlock(projectDir);
    const parts = [];
    if (block && st.seen && codex.hash(block) !== st.seen) {
      parts.push(`需求树（${treeName}）的全局规则或索引刚更新过，以这一版为准：\n\n${block}`);
      trace.injected = ['global'];
    }
    if (block) st.seen = codex.hash(block);
    // 这句话明确提到的需求（标题、编号、第N章）：送它的规则。记在 sent 里键加 @；提到的正好是一个单元的主人时，单元也记成已送
    if (input.prompt) {
      const root = parse(fs.readFileSync(treePath, 'utf8'));
      const mine = Object.fromEntries(Object.entries(st.sent).filter(([k]) => k.startsWith('@')).map(([k, v]) => [k.slice(1), v]));
      const m = mentionContext(root, input.prompt, mine, codex.hash);
      if (m) {
        const units = codex.units(root);
        for (const { id, hash } of m.ids) {
          st.sent['@' + id] = hash;
          // 提到的需求自己的单元，以及上级里只有自己一个成员的单元（它们的规则已经作为「来自上级」写在里面）
          const node = findById(root, id);
          for (const u of units) {
            const self = u.id === id;
            const ancestor = node && u.owner !== node && pathOf(node).includes(u.owner) && u.members.length === 1;
            if (self || ancestor) st.sent[u.id] = codex.hash(codex.renderUnit(u, treeName));
          }
        }
        parts.push(m.text);
        trace.injected = [...(trace.injected || []), ...m.ids.map(x => '@' + x.id)];
      }
    }
    store.writeJson(sf, st);
    return parts.length ? context(event, parts.join('\n\n')) : '';
  }

  if (event === 'PostToolUse') {
    const ti = input.tool_input || {};
    const isPatch = input.tool_name === 'apply_patch';
    const raw = isPatch ? codex.patchFiles(ti.command) : typeof ti.command === 'string' ? codex.shellPaths(ti.command) : [];
    const rels = [...new Set(raw.map(p => codex.relTo(projectDir, cwd, p)).filter(Boolean))];
    trace.files = rels.slice(0, 10);
    if (!rels.length) return '';
    const text = fs.readFileSync(treePath, 'utf8');
    const root = parse(text);

    // 活动记录（面板上的「AI 正在改」）：apply_patch 的文件是确定的；命令行只在像写文件的命令里、
    // 且路径确实是项目里的文件时才记（Codex 在 Windows 上多半用 PowerShell 改文件）
    const writes = isPatch ? rels : codex.isWriteCommand(ti.command)
      ? rels.filter(rel => { try { return fs.statSync(path.join(projectDir, rel)).isFile(); } catch { return false; } }) : [];
    if (writes.length) {
      if (!isPatch) trace.writes = writes.slice(0, 10);
      for (const rel of writes) {
        if (store.samePath(path.join(projectDir, rel), treePath)) { store.compileTree(treePath); continue; }
        if (/^\.(reqtree|claude|codex)\//.test(rel)) continue;
        const node = nodeForFile(root, rel);
        store.appendActivity(treePath, { node: node ? node.id : null, file: rel, time: Date.now(), session: input.session_id, agent: 'codex' });
      }
    }

    // AI 照 AGENTS.md 的索引自己读了规则文件：记成已送
    const all = codex.units(root);
    for (const id of codex.readRuleIds(rels)) {
      const u = all.find(x => x.id === id);
      if (u) st.sent[id] = codex.hash(codex.renderUnit(u, treeName));
    }
    const due = codex.unitsForFiles(root, rels).filter(u => st.sent[u.id] !== codex.hash(codex.renderUnit(u, treeName)));
    if (due.length) {
      for (const u of due) st.sent[u.id] = codex.hash(codex.renderUnit(u, treeName));
      out = context(event, `需求树：你正在处理的文件属于下面的需求，照这些规则做（每份本会话只发一次，后面不再重复）。\n\n${due.map(u => unitText(u, treeName)).join('\n\n')}`);
      trace.injected = due.map(u => u.id);
    }
    store.writeJson(sf, st);
    return out;
  }

  if (event === 'PreCompact') {
    delegate({ ...input, cwd: projectDir }, projectDir, trace); // 压缩前补漏
    return '';
  }

  if (event === 'Stop') {
    // 先记一行：Codex 结束得快时可能等不到这个进程写完最后的日志
    writeTrace(input, { ...trace, phase: 'start' }, 0);
    delegate({ ...input, cwd: projectDir }, projectDir, trace); // 启动记录员
    return '';
  }
  return '';
}

function writeTrace(input, trace, ms) {
  try {
    const f = path.join(LOG_DIR(), 'codex-hook.log');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (fs.existsSync(f) && fs.statSync(f).size > 512 * 1024) fs.renameSync(f, f + '.old');
    fs.appendFileSync(f, JSON.stringify({
      t: new Date().toISOString(), ev: input.hook_event_name, tool: input.tool_name, session: (input.session_id || '').slice(0, 8),
      turn: input.turn_id, hasPrompt: !!input.prompt, hasLastMsg: !!input.last_assistant_message, ms, ...trace,
    }) + '\n');
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
    try { input = JSON.parse(buf || '{}'); out = main(input, trace); }
    catch (e) { trace.error = e.stack; }
    if (out) process.stdout.write(out);
    if (!process.env.REQTREE_RECORDER) writeTrace(input, trace, Date.now() - t0);
  });
}

module.exports = { main, findTreeUp };
