'use strict';
// 背景文档：需求下的「> 文档：DataScience/_CHAPTERS.md」，或只挂一节「> 文档：规范/内容与写作.md#写作风格」。
// 分工：规则是一句话就能照做的要求（每次改到对应文件都要读，所以要短）；文档放规则装不下的：为什么、具体怎么做、例子、数据、进度。
// 文档全文不搬进规则（太长、会过时），编译时只给这个需求的规则文件加一句「动手前先读」：
//   - 挂了一节：写明那一节在第几行到第几行，只读那几行；
//   - 挂了整份、又比较长（LONG_CHARS 字以上）：附一张目录（每节的标题和行号），让 AI 只读和这次任务有关的节；
//   - 短文档：直接读。
// 用途取文档开头的「用途：…」一行，没有就取第一个标题。行号随文档变：文档改了要重新编译（compile.ensureCompiled 会看文档的修改时间）
const fs = require('fs');
const path = require('path');

const PURPOSE_MAX = 60;
const HEAD_LINES = 20;
const LONG_CHARS = 3000;   // 超过这么多字的文档附目录
const TOC_ITEMS = 16;      // 目录最多列几节
const TOC_NAME = 16;       // 每节标题最多几个字

// 「路径#节名」拆开；没有 # 的 section 为 ''
function splitRef(ref) {
  const s = String(ref || '');
  const i = s.indexOf('#');
  return i < 0 ? { file: s.trim(), section: '' } : { file: s.slice(0, i).trim(), section: s.slice(i + 1).trim() };
}

// 文档的绝对路径；写成项目外面的路径（../、绝对路径）返回 null，不读项目外的文件。可以带 #节名（忽略）
function resolve(projectDir, rel) {
  rel = splitRef(rel).file;
  const p = path.resolve(projectDir, rel);
  const r = path.relative(projectDir, p);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? p : null;
}

function exists(projectDir, rel) {
  const p = resolve(projectDir, rel);
  try { return !!p && fs.statSync(p).isFile(); } catch { return false; }
}

// 程序运行时读的 .md（提示词模板、要原样编译出去的文字）：同一个文件夹里有代码文件用字符串写着它的文件名。
// 它不是写给 AI 的说明文档：不挂成文档，体检也不改它。2026-10-25 初始化把 src/ponytail.md 挂成了文档，体检把里面的句子搬进树、从原文删掉
const CODE_FILE = /\.(c?js|mjs|ts|tsx|jsx|py|gd|cs|go|rs|rb|php|java|kt|lua|sh|ps1)$/i;
function isProgramData(projectDir, rel, cache = new Map()) {
  const file = splitRef(rel).file.replace(/\\/g, '/');
  const dir = path.posix.dirname(file);
  if (!cache.has(dir)) {
    let text = '';
    try {
      for (const n of fs.readdirSync(path.join(projectDir, dir))) {
        if (!CODE_FILE.test(n)) continue;
        const p = path.join(projectDir, dir, n);
        try { if (fs.statSync(p).size < 300 * 1024) text += fs.readFileSync(p, 'utf8') + '\n'; } catch {}
      }
    } catch {}
    cache.set(dir, text);
  }
  const name = path.posix.basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`['"\`]${name}['"\`]`).test(cache.get(dir));
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

// 文档的各节：[{ level, title, start, end }]（行号从 1 起，end 含）。代码块里的 # 不算标题
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

// 目录：选最主要的那一级标题（文档里第一个出现次数 ≥ 2 的级别，通常是 ##），列标题和行号
function toc(text) {
  // 只有一个一级标题时，它是文档的大标题，不算一节
  let all = sections(text);
  if (all.filter(h => h.level === 1).length === 1) all = all.filter(h => h.level > 1);
  if (all.length < 2) return '';
  const levels = [...new Set(all.map(h => h.level))].sort();
  const level = levels.find(l => all.filter(h => h.level === l).length >= 2) || levels[0];
  const items = all.filter(h => h.level === level);
  const cut = s => { const a = [...s]; return a.length > TOC_NAME ? a.slice(0, TOC_NAME).join('') + '…' : s; };
  const shown = items.slice(0, TOC_ITEMS).map(h => `${cut(h.title)} ${h.start}–${h.end}`);
  return shown.join('；') + (items.length > TOC_ITEMS ? `；等 ${items.length} 节` : '');
}

// 一份挂上的文档怎么写进「动手前先读」：整份短文档写用途；长文档附目录；只挂一节的写那一节的行号。
// 节名找不到时退回整份（体检会提醒节名对不上）
function describe(projectDir, ref) {
  const { file, section } = splitRef(ref);
  let text = '';
  try { text = fs.readFileSync(resolve(projectDir, file), 'utf8'); } catch { return null; }
  if (section) {
    const h = findSection(text, section);
    if (h) return { section: true, text: `\`${file}\` 的「${h.title}」（第 ${h.start}–${h.end} 行）` };
  }
  const u = purpose(projectDir, file);
  const chars = [...text].length;
  const t = chars > LONG_CHARS ? toc(text) : '';
  return { long: !!t, text: `\`${file}\`${u ? `（${u}）` : ''}${t ? `，约 ${Math.round(chars / 100) * 100} 字，目录：${t}` : ''}` };
}

// 编译进规则文件的那一句；文档不存在就不写（体检会提醒）
function readLine(projectDir, node) {
  const parts = node.docs.filter(d => exists(projectDir, d)).map(d => describe(projectDir, d)).filter(Boolean);
  if (!parts.length) return '';
  const how = parts.some(p => p.long || p.section)
    ? '长文档先看目录，只读和这次任务有关的节，读文件时按行号只读那几行；只挂了一节的，只读那一节。'
    : '';
  return `动手前先读背景文档：${parts.map(p => p.text).join('、')}。${how}文档和需求树说法不同时以需求树为准；做完一块，文档里的进度这类内容过时了就顺手更新。`;
}

// 挂的文档里，最晚改的那份的修改时间（编译看它判断行号是不是过时了）。不 parse 整棵树，只找「> 文档：」行
function docsMtime(treePath) {
  let text = '';
  try { text = fs.readFileSync(treePath, 'utf8'); } catch { return 0; }
  const dir = path.dirname(treePath);
  let latest = 0;
  const { splitDocs } = require('./parser');
  for (const m of text.matchAll(/^\s*>\s*(?:文档|docs?)\s*[:：]\s*(.+)$/gim)) {
    for (const ref of splitDocs(m[1])) {
      const p = resolve(dir, ref);
      try { if (p) latest = Math.max(latest, fs.statSync(p).mtimeMs); } catch {}
    }
  }
  return latest;
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
  // 记下前后两行：同一份文档删了好几行、不按从新到旧的顺序撤销时，只靠行号会插错位置
  const before = lines[at - 1], after = lines[at + 1];
  lines.splice(at, 1);
  fs.writeFileSync(file, lines.join(nl));
  return { op: 'doc_remove', file: op.file, text: bodyOf(lineText), undo: [{ op: 'doc_restore', file: op.file, at, lineText, prev: before, next: after }] };
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
  // 插回原来那两行之间：先找原来的下一行（只出现一次的才算），再找上一行，都找不到才按行号。
  // 已知限制：连着删掉的几行按从旧到新的顺序全撤，几行之间的先后可能对调（每行只记得删它那时的邻居）
  const only = s => typeof s === 'string' && s.trim() && lines.indexOf(s) === lines.lastIndexOf(s) ? lines.indexOf(s) : -1;
  const n = only(u.next), p = only(u.prev);
  const at = n >= 0 ? n : p >= 0 ? p + 1 : Math.min(u.at || 0, lines.length);
  lines.splice(at, 0, u.lineText);
  fs.writeFileSync(file, lines.join(nl));
  return true;
}

// ---------- 整份写一个文件（初始化用：写需求树、从 CLAUDE.md 拆出去的新文档、拆过的 CLAUDE.md） ----------
// 写之前整份备份（原来没有这个文件就记 null）；撤销（doc_put_back）时整份放回，原来没有的就删掉。
// 放回之前把当时的内容也备份一份：初始化之后用户或记录员又改过，撤销也不会把那些改动弄丢
function backupFile(projectDir, file, rel) {
  const dir = path.join(projectDir, '.reqtree', 'doc-backup');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${rel.replace(/[\\/:]/g, '_')}`;
  fs.copyFileSync(file, path.join(dir, name));
  return name;
}
function writeDoc(treePath, op) {
  const projectDir = path.dirname(treePath);
  const file = typeof op.file === 'string' && resolve(projectDir, op.file);
  if (!file || typeof op.text !== 'string') return null;
  let backup = null;
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, 'utf8') === op.text) return null;
    backup = backupFile(projectDir, file, op.file);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, op.text);
  return { op: 'doc_write', file: op.file, undo: [{ op: 'doc_put_back', file: op.file, backup }] };
}
function putBack(treePath, u) {
  const projectDir = path.dirname(treePath);
  const file = typeof u.file === 'string' && resolve(projectDir, u.file);
  if (!file) return false;
  const src = u.backup && path.join(projectDir, '.reqtree', 'doc-backup', path.basename(u.backup));
  if (src && !fs.existsSync(src)) return false;
  if (fs.existsSync(file)) backupFile(projectDir, file, u.file);
  if (src) fs.copyFileSync(src, file);
  else try { fs.unlinkSync(file); } catch { return false; }
  return true;
}

// ---------- 改文档里的一段话（体检用：文档挂在某个需求下，说法和这个需求的规则冲突，按需求树改文档） ----------
// text 在全文里只出现一次才改（表格行里的也行，只换那几个字，不动结构）；找不到或不止一处就不改，交给报告提醒。
// 撤销是反过来再换一次（doc_replace，new 换回 text）
function replaceDocText(treePath, op) {
  const projectDir = path.dirname(treePath);
  const file = typeof op.file === 'string' && resolve(projectDir, op.file);
  if (!file || !op.text || typeof op.new !== 'string' || op.text === op.new) return null;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const at = text.indexOf(op.text);
  if (at < 0 || text.indexOf(op.text, at + 1) >= 0) return null;
  try { backupFile(projectDir, file, op.file); } catch {}
  fs.writeFileSync(file, text.slice(0, at) + op.new + text.slice(at + op.text.length));
  return { op: 'doc_replace', file: op.file, text: op.text, new: op.new, undo: [{ op: 'doc_replace', file: op.file, text: op.new, new: op.text }] };
}

// 做文档改动：删一行（doc_remove）、改一段（doc_replace）、整份写（doc_write）；
// 撤销：插回一行（doc_restore）、改回来（doc_replace）、整份放回（doc_put_back）
function doDoc(treePath, o) {
  if (o.op === 'doc_write') return writeDoc(treePath, o);
  if (o.op === 'doc_remove') return removeDocText(treePath, o);
  if (o.op === 'doc_replace') return replaceDocText(treePath, o);
  return null;
}
function undoDoc(treePath, u) {
  if (u.op === 'doc_put_back') return putBack(treePath, u);
  if (u.op === 'doc_replace') return !!replaceDocText(treePath, u);
  return restoreDoc(treePath, u);
}

const isDocOp = o => !!o && typeof o.op === 'string' && o.op.startsWith('doc_');

module.exports = { resolve, exists, isProgramData, purpose, readLine, removeDocText, restoreDoc, writeDoc, putBack, replaceDocText, doDoc, undoDoc, isDocOp, splitRef, sections, findSection, toc, describe, docsMtime, LONG_CHARS };
