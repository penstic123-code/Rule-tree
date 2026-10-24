'use strict';
// 背景文档：需求下的「> 文档：DataScience/_CHAPTERS.md」。
// 规则写在需求树里，章节表、进度、踩过的坑这类背景留在文档里。文档全文不搬进规则（太长、会过时），
// 编译时只给这个需求的规则文件加一句「动手前先读 X（用途）」：AI 改到这个需求的文件时才看到，每份文档一行字。
// 用途取文档开头的「用途：…」一行，没有就取第一个标题。
const fs = require('fs');
const path = require('path');

const PURPOSE_MAX = 60;
const HEAD_LINES = 20;

// 文档的绝对路径；写成项目外面的路径（../、绝对路径）返回 null，不读项目外的文件
function resolve(projectDir, rel) {
  const p = path.resolve(projectDir, rel);
  const r = path.relative(projectDir, p);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? p : null;
}

function exists(projectDir, rel) {
  const p = resolve(projectDir, rel);
  try { return !!p && fs.statSync(p).isFile(); } catch { return false; }
}

const clean = s => s.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
const clip = s => { const a = [...s]; return a.length > PURPOSE_MAX ? a.slice(0, PURPOSE_MAX).join('') + '…' : s; };

// 文档开头写的用途；读不到返回 ''
function purpose(projectDir, rel) {
  const p = resolve(projectDir, rel);
  let lines;
  try { lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).slice(0, HEAD_LINES); } catch { return ''; }
  for (const l of lines) {
    const m = clean(l.replace(/^\s*>\s*/, '')).match(/^(?:用途|purpose)\s*[:：]\s*(.+)$/i);
    if (m) return clip(m[1].replace(/[。.]$/, ''));
  }
  const h = lines.find(l => /^#{1,3}\s+\S/.test(l));
  return h ? clip(clean(h.replace(/^#+\s+/, ''))) : '';
}

// 编译进规则文件的那一句；文档不存在就不写（体检会提醒）
function readLine(projectDir, node) {
  const docs = node.docs.filter(d => exists(projectDir, d));
  if (!docs.length) return '';
  const list = docs.map(d => { const u = purpose(projectDir, d); return `\`${d}\`${u ? `（${u}）` : ''}`; }).join('、');
  return `动手前先读背景文档：${list}。文档和需求树说法不同时以需求树为准；做完一块，文档里的进度这类内容过时了就顺手更新。`;
}

// ---------- 从文档里删一行（体检用：和需求树重复的、已经搬进需求树的规则） ----------
// 只删能找准的整行：去掉列表符号和加粗后，和要删的那句几乎一样（Dice ≥ 0.8），全文只有一处。
// 标题、表格行、下面还挂着子项的行都不删（删了会把结构弄坏），找不准的也不删，交给报告提醒。
// 删之前整份备份到 .reqtree/doc-backup/（以防万一）；撤销时把那一行插回原位（doc_restore），不整份覆盖，免得冲掉之后的修改
const DOC_SAME = 0.8;
const bodyOf = l => clean(l.replace(/^\s*(?:[-*+]|\d+[.)、])\s+/, '')).replace(/[。；;，,.\s]+$/, '');
const indentOf = l => l.match(/^\s*/)[0].length;
function removeDocText(treePath, op) {
  const projectDir = path.dirname(treePath);
  const file = typeof op.file === 'string' && resolve(projectDir, op.file);
  if (!file || !op.text) return null;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const { similarity } = require('./parser');
  const nl = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const want = bodyOf(op.text);
  const hits = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; return; }
    if (fence || /^\s*(#|\||>)/.test(l) || !l.trim()) return;
    const body = bodyOf(l);
    if (body && (body === want || similarity(body, want) >= DOC_SAME)) hits.push(i);
  });
  if (hits.length !== 1) return null;
  const at = hits[0];
  const next = lines.slice(at + 1).find(l => l.trim());
  if (next && /^\s*(?:[-*+]|\d+[.)])\s/.test(next) && indentOf(next) > indentOf(lines[at])) return null;
  try {
    const dir = path.join(projectDir, '.reqtree', 'doc-backup');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(file, path.join(dir, `${Date.now()}-${op.file.replace(/[\\/:]/g, '_')}`));
  } catch {}
  const lineText = lines[at];
  lines.splice(at, 1);
  fs.writeFileSync(file, lines.join(nl));
  return { op: 'doc_remove', file: op.file, text: bodyOf(lineText), undo: [{ op: 'doc_restore', file: op.file, at, lineText }] };
}

// 撤销：那一行不在了就插回原来的位置
function restoreDoc(treePath, u) {
  const file = typeof u.file === 'string' && resolve(path.dirname(treePath), u.file);
  if (!file || typeof u.lineText !== 'string') return false;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  const nl = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines.includes(u.lineText)) return false;
  lines.splice(Math.min(u.at || 0, lines.length), 0, u.lineText);
  fs.writeFileSync(file, lines.join(nl));
  return true;
}

const isDocOp = o => !!o && typeof o.op === 'string' && o.op.startsWith('doc_');

module.exports = { resolve, exists, purpose, readLine, removeDocText, restoreDoc, isDocOp };
