'use strict';
// OpenAI Codex。Codex 没有按文件路径加载规则的机制：AGENTS.md 在会话开始时读一遍，之后不再按改到的文件补充。所以分两路：
// 1. 项目根 AGENTS.md 里的托管块（<!-- ruletree:begin --> … <!-- ruletree:end -->）：说明书 + 全局规则 + 一张「改哪些文件先读哪个规则文件」的索引，
//    规则文件就是 .claude/rules/ruletree/ 里那些（和 Claude Code 共用一份）。用户自己写在 AGENTS.md 里的内容一个字不动。
// 2. hooks/codex-hook.js（需要用户在 Codex 里信任 hook）：AI 读写到匹配的文件时，把那几个需求文件的内容作为 additionalContext 送过去，每个会话每份只送一次。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const T = require('../tree');
const store = require('../store');
const { rulesText } = require('../guide');

const BEGIN = '<!-- ruletree:begin -->';
const END = '<!-- ruletree:end -->';
// 旧版（需求树 reqtree）的托管块，升级时换掉
const OLD = ['<!-- reqtree:begin -->', '<!-- reqtree:end -->'];
// 装过 Codex 的标记
const CONFIG = path.join(store.META_DIR, 'codex.json');
// Codex 默认只读 AGENTS.md 合计 32 KiB，托管块超过这个数就提醒
const BLOCK_WARN_BYTES = 16 * 1024;
// hook 往 Codex 上下文里加的内容上限：默认 additionalContextLimit 2500 token，按 4 字节一个 token 估算，留点余量
const CONTEXT_LIMIT = 9000;
const RULES = store.RULES_DIR.split(path.sep).join('/');

// 每个有文件范围、有内容的需求（根需求除外，它的规则直接写在托管块里）
const units = root => [...T.walk(root)].filter(n => !T.isRoot(n) && n.files.length && (n.rules.length || n.docs.length));

// 规则文件去掉文件头，送给 AI 的正文
const bodyOf = text => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();

function renderBlock(root) {
  const top = root.children[0];
  const lines = [
    BEGIN,
    '## RuleTree：本项目的需求和规则',
    '',
    `本项目的需求和规则记在 ${RULES}/：每个文件是一个需求，文件名是编号和标题（R1.2 是 R1 的下级），开头的 paths 是它管哪些文件，标题行带状态（✅完成 🔨进行中 ⏳待做 ❓待定），下面的列表项是规则，「文档：」一行是动手前要读的背景文档。这一段由 RuleTree 生成，不要手改。`,
    ...rulesText('AGENTS.md'),
  ];
  if (top && (top.rules.length || top.docs.length)) {
    lines.push('', '### 全局规则（_root.md）', '');
    if (top.docs.length) lines.push(`- 背景文档：${top.docs.join('、')}`);
    for (const r of top.rules) lines.push(`- ${r.text}`);
  }
  const us = units(root);
  if (us.length) {
    lines.push('', '### 按文件的规则', '', '动手修改或新建下面这些文件之前，先读对应的需求文件，照着做。一个文件匹配几条就读几份（范围小的那份在冲突时优先）；同一份在本次会话里读过就不用再读。', '');
    for (const n of us) lines.push(`- ${n.files.map(g => '`' + g + '`').join('、')} → \`${RULES}/${n.file}\`（${n.id} ${n.title}）`);
  }
  lines.push(END);
  return lines.join('\n');
}

// 找托管块：标记要单独占一行，END 只在 BEGIN 后面找。返回 { start, end }；没有块返回 null；有 BEGIN 没有 END 返回 { broken: true }
function findBlock(text, [begin, end] = [BEGIN, END]) {
  const marker = m => new RegExp(`^[ \\t]*${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'm');
  const b = marker(begin).exec(text);
  if (!b) return null;
  const start = b.index + b[0].indexOf(begin);
  const after = b.index + b[0].length;
  const e = marker(end).exec(text.slice(after));
  if (!e) return { broken: true };
  return { start, end: after + e.index + e[0].indexOf(end) + end.length };
}
// 放进托管块：已有就原地替换，没有就加在末尾。块不完整（用户删了结束标记）时原样返回：不知道块到哪里结束
function upsertBlock(text, block) {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const b = block.replace(/\r?\n/g, eol);
  const at = findBlock(text);
  if (at && at.broken) return text;
  if (at) return text.slice(0, at.start) + b + text.slice(at.end);
  if (!text.trim()) return b + eol;
  return text.replace(/\s*$/, '') + eol + eol + b + eol;
}
function removeBlock(text, markers = [BEGIN, END]) {
  const at = findBlock(text, markers);
  if (!at || at.broken) return text;
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const before = text.slice(0, at.start).replace(/\s*$/, ''), after = text.slice(at.end).replace(/^\s*/, '');
  if (before && after) return before + eol + eol + after;
  return before || after ? (before || after) + (/\r?\n$/.test(after) ? '' : eol) : '';
}

// 同一目录里 AGENTS.override.md 存在时 Codex 不读 AGENTS.md，托管块要写进 override
function agentsFile(dir) {
  const over = path.join(dir, 'AGENTS.override.md');
  try { if (fs.readFileSync(over, 'utf8').trim()) return over; } catch {}
  return path.join(dir, 'AGENTS.md');
}

// 装过 Codex：有 .ruletree/codex.json，或 AGENTS.md 里已经有托管块
function enabled(dir) {
  if (fs.existsSync(path.join(dir, CONFIG))) return true;
  for (const f of ['AGENTS.md', 'AGENTS.override.md']) {
    try { if (findBlock(fs.readFileSync(path.join(dir, f), 'utf8'))) return true; } catch {}
  }
  return false;
}

// 托管块写成最新的（内容没变不写）。返回 { written, warnings, errors }（errors：块不完整，没更新）
function compile(dir) {
  const file = agentsFile(dir);
  let before = '';
  try { before = fs.readFileSync(file, 'utf8'); } catch {}
  const block = renderBlock(store.readTree(dir));
  const warnings = [], errors = [];
  const found = findBlock(before);
  if (found && found.broken) errors.push(`${path.basename(file)} 里需求树的部分不完整（有开始标记 ${BEGIN}，没有结束标记 ${END}），没有更新它；补上结束标记或删掉开始标记后再试`);
  const after = upsertBlock(removeBlock(before, OLD), block);
  if (after !== before) fs.writeFileSync(file, after);
  if (Buffer.byteLength(block) > BLOCK_WARN_BYTES) warnings.push(`AGENTS.md 里需求树的部分有 ${Buffer.byteLength(block)} 字节，Codex 默认只读 AGENTS.md 合计 32 KiB，全局规则太多会被截掉`);
  return { written: after !== before, file, warnings, errors };
}

// ---------- hook 用：从工具调用里找出涉及的文件 ----------

// apply_patch 的补丁文本里改了哪些文件：Add/Update/Delete File 和 Move to
function patchFiles(patch) {
  const out = [];
  for (const m of String(patch || '').matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/gm)) out.push(m[1].replace(/^(["'])(.*)\1$/, '$2'));
  return [...new Set(out)];
}
// 命令行里像文件路径的词（只用来决定送哪份规则，猜错了顶多多送或少送一份）
function shellPaths(command) {
  const s = String(command || '');
  const tokens = [...s.matchAll(/'([^']+)'|"([^"]+)"/g)].map(m => m[1] || m[2]).concat(s.split(/[\s"'|;&<>(),]+/));
  const out = [];
  for (let t of tokens) {
    t = t.trim().replace(/^-[A-Za-z]+[:=]/, '');
    if (!t || /\s/.test(t) && !/^[^\s]+(?: [^\s]+)*\.[A-Za-z0-9]{1,6}$/.test(t)) continue;
    if (/[\\/]/.test(t) || /\.[A-Za-z0-9]{1,6}$/.test(t)) out.push(t);
  }
  return [...new Set(out)];
}
// 命令像不像在写文件（Codex 在 Windows 上常用 PowerShell 改文件）。动词要在命令的位置，不然 `grep tee x.html` 这种只读的也算写
const CMD_AT = String.raw`(?:^|[;&|({\n]|\$\(|\bpowershell(?:\.exe)?\s+(?:-\w+\s+)*?-c(?:ommand)?\s+["']?)\s*`;
const WRITE_CMD = new RegExp(`${CMD_AT}(?:Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Rename-Item|Remove-Item|sed\\s+(?:-\\w+\\s+)*-i|tee|cp|mv|rm|touch)\\b|\\bWriteAll(?:Text|Bytes|Lines)\\b|open\\([^)]*,\\s*['"][wa]`, 'i');
const isWriteCommand = command => WRITE_CMD.test(String(command || ''));
// 绝对或相对路径 → 相对项目根、用 / 分隔；不在项目里返回 null。在这个项目的 git worktree 里的，按 worktree 的根算
function relTo(dir, cwd, p) {
  const abs = path.resolve(cwd || dir, String(p).replace(/^['"]|['"]$/g, ''));
  const rel = require('../common').projectRel(dir, abs);
  return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? null : rel;
}

const hash = s => crypto.createHash('md5').update(s).digest('hex').slice(0, 12);
// 会话状态：已经送过哪些需求文件（文件名 → 内容哈希）
function sessionFile(dir, session) {
  return path.join(require('../common').tmpDir(), 'codex-' + crypto.createHash('md5').update(store.pathKey(dir) + '|' + (session || '')).digest('hex') + '.json');
}

module.exports = {
  BEGIN, END, OLD, CONFIG, CONTEXT_LIMIT, RULES,
  units, bodyOf, renderBlock, findBlock, upsertBlock, removeBlock, agentsFile, enabled, compile,
  patchFiles, shellPaths, isWriteCommand, relTo, hash, sessionFile,
};
