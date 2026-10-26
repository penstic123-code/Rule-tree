'use strict';
// 需求挂的背景文档：需求文件里的「文档：docs/design.md」，或只挂一节「文档：规范/写作.md#写作风格」。
// 分工：规则是一句话就能照做的要求（改到对应文件都要读，所以要短）；文档放规则装不下的：为什么、具体怎么做、例子、数据、进度。
// 干活的 AI 自己去读（说明书里写着）；这里只给面板打开文档、体检查文档在不在用
const fs = require('fs');
const path = require('path');

// 「路径#节名」拆开；没有 # 的 section 为 ''
function splitRef(ref) {
  const s = String(ref || '');
  const i = s.indexOf('#');
  return i < 0 ? { file: s.trim(), section: '' } : { file: s.slice(0, i).trim(), section: s.slice(i + 1).trim() };
}

// 文档的绝对路径；写成项目外面的路径（../、绝对路径）返回 null，不读项目外的文件。可以带 #节名（忽略）
function resolve(dir, rel) {
  const p = path.resolve(dir, splitRef(rel).file);
  const r = path.relative(dir, p);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? p : null;
}
function exists(dir, rel) {
  const p = resolve(dir, rel);
  try { return !!p && fs.statSync(p).isFile(); } catch { return false; }
}

// 文档的各节：[{ level, title, start, end }]（行号从 1 起）
const clean = s => s.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
function sections(text) {
  const lines = text.split(/\r?\n/);
  const heads = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; return; }
    const m = !fence && l.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/);
    if (m) heads.push({ level: m[1].length, title: clean(m[2]), start: i + 1 });
  });
  heads.forEach((h, k) => {
    const next = heads.slice(k + 1).find(x => x.level <= h.level);
    h.end = next ? next.start - 1 : lines.length;
  });
  return heads;
}

// 按节名找一节：先找标题完全一样的，再找包含这个名字的（「写作风格」能找到「一C、写作风格」）
const norm = s => clean(s).replace(/[\s、，,.:：（）()]/g, '').toLowerCase();
function findSection(text, name) {
  const want = norm(name);
  if (!want) return null;
  const all = sections(text);
  return all.find(h => norm(h.title) === want) || all.find(h => norm(h.title).includes(want)) || null;
}

module.exports = { splitRef, resolve, exists, sections, findSection };
