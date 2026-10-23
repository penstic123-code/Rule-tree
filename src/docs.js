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

module.exports = { resolve, exists, purpose, readLine };
