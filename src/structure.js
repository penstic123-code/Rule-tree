'use strict';
// 体检的「信息架构」一步（不调用模型）：每块在做的内容都有需求，说明文档挂在该挂的需求上，按章分的需求只挂讲这一章的那一节。
// 目的：AI 改到哪块，就拿到那块的规则和文档提示，不多也不少（2026-10-25 实测 Vibelearning：教育课没有需求，
// 改它只拿到通用写作规则，它自己的说明文档 AI 根本不知道）。
//   1. 没有需求的内容文件夹（最上一层、最近 60 天改过、至少 3 个文件、不是工具素材备份这类）→ 新建需求，挂上文件夹和它第一层的说明文档
//   2. 没挂文档的需求，自己文件夹第一层有说明文档 → 挂上
//   3. 按章分的子需求（标题或文件看得出第几章）→ 挂上级文档里讲这一章的那一节，AI 改这章时只被提醒读那一节
// 只改需求树、不动文档内容。每项是一个判断（问题的格式），交给 checkup.settle → Q.decide：直接做、可撤销，撤销过的不再做（memKey）。
const fs = require('fs');
const path = require('path');
const { parse, walk, applyOps, nextChildId } = require('./parser');
const Docs = require('./docs');
const { chapterNumbers, fileChapters } = require('./mention');
const { covers } = require('./compile');

const ACTIVE_DAYS = 60;
const MIN_FILES = 3;
const MAX_DOCS = 3;
// 备份、副本：不是在用的东西，不建需求、不挂文档、不从里面搬规则（2026-10-25 Vibelearning 的 game-design-course-备份-20261020/ 被挂进了课程）
const BACKUP = /备份|副本|backup|\bbak\b|\bold\b|archive|\bcopy\b/i;
const isBackup = p => String(p).split('/').some(seg => BACKUP.test(seg));
// 不当成「一块内容」的文件夹：工具、素材、构建产物、备份
const NOT_CONTENT = new RegExp(`^[._]|^(node_modules|tests?|spec|__tests__|docs?|scripts?|tools?|bin|build|dist|out|target|vendor|lib|assets?|img|images?|static|public|fonts?|media|coverage)$|${BACKUP.source}`, 'i');
const NOT_DOCS = /^(readme|changelog|license|licence|contributing|claude|agents)\b/i;
// 挂哪几份：讲规则、进度、总说明的优先
const docRank = f => (/规则|规范|rules|guide|brief|progress|进度|章节|chapters|plan|计划/i.test(path.basename(f)) ? 0 : 1);

// 文件夹第一层的说明文档（.md，不含 README 这类）
const topDocs = (files, folder, treeName, projectDir, cache) => files
  .filter(f => f.startsWith(folder + '/') && !f.slice(folder.length + 1).includes('/') && /\.md$/i.test(f) && !isBackup(f)
    && !NOT_DOCS.test(path.basename(f)) && path.basename(f) !== treeName && !Docs.isProgramData(projectDir, f, cache))
  .sort((a, b) => docRank(a) - docRank(b) || a.localeCompare(b));

// 新需求的名字：第一层说明文档的标题里「：」前面那段（「教育学 · 美术馆：项目规则与经验」→「教育学 · 美术馆」），没有就用文件夹名
function titleOf(projectDir, folder, docs) {
  for (const d of docs) {
    let head = '';
    try { head = (fs.readFileSync(path.join(projectDir, d), 'utf8').match(/^#\s+(.+)$/m) || [])[1] || ''; } catch {}
    const t = head.split(/[：:—|]/)[0].replace(/[`*_]/g, '').trim();
    if (t && [...t].length <= 20) return t;
  }
  return folder;
}

function recentlyChanged(projectDir, files) {
  const since = Date.now() - ACTIVE_DAYS * 86400000;
  return files.some(f => { try { return fs.statSync(path.join(projectDir, f)).mtimeMs > since; } catch { return false; } });
}

const option = (label, k, a, ops) => ({ label, t: { k, a }, ops });
const judgment = (memKey, text, t, ops) => ({
  source: '体检', kind: 'structure', memKey, text, t,
  options: [option('照做', 'q.optDo', [], ops), option('不用', 'q.optSkip', [], [])], default: 0,
});

// 文档里讲第 n 章的那一节（二到四级标题里只提到第 n 章的）→ 挂法「文件#节名」。节名尽量用「第 n 章」这几个字，
// 能唯一找回这一节就行；「> 文档：」按逗号分，节名里不能带逗号
function chapterSection(text, file, n) {
  const h = Docs.sections(text).find(x => x.level >= 2 && (s => s.size === 1 && s.has(n))(chapterNumbers(x.title)));
  if (!h) return null;
  const token = (h.title.match(/第\s*\S{1,3}?\s*[章课节篇关]|(?:chapter|ch|lesson|level)[\s._-]*0*\d+/i) || [])[0];
  for (const sec of [token, h.title]) {
    if (!sec || /[,，、]/.test(sec)) continue;
    const back = Docs.findSection(text, sec);
    if (back && back.start === h.start) return `${file}#${sec}`;
  }
  return null;
}

// 新需求的编号：跟着「有专门文件夹的需求」最常用的字母走（课程是 C1、C2…），不跟横切的（W1 正文写作）；都没有就照常分配
function folderNodeId(root, top) {
  const count = new Map();
  for (const c of top.children) {
    const m = c.id.match(/^([A-Z]+)\d+$/);
    if (m && c.files.some(g => !/^[*?{]/.test(g))) count.set(m[1], (count.get(m[1]) || 0) + 1);
  }
  const L = [...count].sort((a, b) => b[1] - a[1])[0];
  if (!L) return nextChildId(root, top);
  // 最大编号加一，不补空位：空出来的号可能是删掉的需求，改动记录里还指着它
  const nums = [...walk(root)].map(n => (n.id.match(new RegExp(`^${L[0]}(\\d+)$`)) || [])[1]).filter(Boolean).map(Number);
  return `${L[0]}${Math.max(0, ...nums) + 1}`;
}

// 返回要做的判断列表。files：项目里的文件（相对路径，/ 分隔，已按 .gitignore 过滤）
function plan(text, projectDir, files, treeName = '需求树.md') {
  const out = [];
  let root = parse(text);
  const dataCache = new Map(); // isProgramData 读过的文件夹
  const nodes = [...walk(root)].filter(n => n.id);
  // 这个文件夹有没有专门的需求：只看文件对应以这个文件夹开头的。*/ch*.html 这种横跨所有文件夹的（「正文写作」）不算
  const owned = folder => nodes.some(n => n.files.some(g => g === folder || g.startsWith(folder + '/')));

  // 1. 没有需求的内容文件夹
  const byFolder = new Map();
  for (const f of files) {
    const i = f.indexOf('/');
    if (i > 0) { const k = f.slice(0, i); if (!byFolder.has(k)) byFolder.set(k, []); byFolder.get(k).push(f); }
  }
  let work = text;
  for (const [folder, list] of [...byFolder].sort((a, b) => a[0].localeCompare(b[0]))) {
    // 只放 .md 的是文档文件夹（规范、笔记），挂在需求上就够了，不单独成一块
    if (NOT_CONTENT.test(folder) || list.length < MIN_FILES || owned(folder) || list.every(f => /\.md$/i.test(f)) || !recentlyChanged(projectDir, list)) continue;
    const docs = topDocs(files, folder, treeName, projectDir, dataCache).slice(0, MAX_DOCS);
    const title = titleOf(projectDir, folder, docs);
    const r = parse(work);
    const top = r.children[0];
    if (!top) break;
    const id = folderNodeId(r, top);
    const ops = [{ op: 'add_node', parent: top.id, id, title }, { op: 'add_files', node: id, globs: [`${folder}/**`] }];
    if (docs.length) ops.push({ op: 'add_docs', node: id, docs });
    work = applyOps(work, ops).text;
    out.push(judgment(`struct|node|${folder}`, `${folder}/ 还没有需求：新建「${title}」，对应 ${folder}/**${docs.length ? `，挂上 ${docs.join('、')}` : ''}`,
      { k: 'q.structNode', a: [folder, title, docs] }, ops));
  }

  // 2. 没挂文档的需求：自己文件夹第一层的说明文档
  for (const n of nodes) {
    if (n.docs.length) continue;
    const docs = n.files.flatMap(g => { const m = g.match(/^([^*?{}[\]]+)\/\*\*$/); return m ? topDocs(files, m[1], treeName, projectDir, dataCache) : []; }).slice(0, MAX_DOCS);
    if (!docs.length) continue;
    out.push(judgment(`struct|docs|${n.id}|${docs.join(',')}`, `「${n.title}」没挂文档：挂上 ${docs.join('、')}`,
      { k: 'q.structDocs', a: [n.title, docs] }, [{ op: 'add_docs', node: n.id, docs }]));
  }

  // 3. 按章分的子需求：挂上级文档里讲这一章的那一节
  for (const n of nodes) {
    const nums = new Set([...chapterNumbers(n.title), ...fileChapters(n.files)]);
    if (nums.size !== 1) continue;
    const num = [...nums][0];
    const mine = new Set(n.docs.map(d => Docs.splitRef(d).file));
    for (let p = n.parent; p && p.id; p = p.parent) {
      for (const ref of p.docs) {
        const { file, section } = Docs.splitRef(ref);
        if (section || mine.has(file)) continue;
        let t = '';
        try { t = fs.readFileSync(Docs.resolve(projectDir, file), 'utf8'); } catch { continue; }
        const sec = chapterSection(t, file, num);
        if (!sec) continue;
        mine.add(file);
        out.push(judgment(`struct|sec|${n.id}|${sec}`, `「${n.title}」挂上 ${sec}（改这一章时只读这一节）`,
          { k: 'q.structSection', a: [n.title, sec] }, [{ op: 'add_docs', node: n.id, docs: [sec] }]));
      }
    }
  }
  out.push(...dupLines(root, projectDir));
  return out;
}

// 4. 下级需求的文档里，和上级需求的文档逐字重复（忽略标点空格）的行：从下级文档删掉。AI 改下级的文件时上级的文档提示也会加载，
// 内容不丢；平级的（两门课各一份）谁也看不到谁，不动。只看列表项，代码块里的、太短的不碰；删一行用 doc_remove（先备份，
// 一行对不准、在表格里、带子项的它自己会拒绝）
const MIN_DUP_CHARS = 15, MAX_DUPS = 30;
function docLines(projectDir, ref) {
  const { file, section } = Docs.splitRef(ref);
  if (section) return null;
  let t = '';
  try { t = fs.readFileSync(Docs.resolve(projectDir, file), 'utf8'); } catch { return null; }
  const out = [];
  let fence = false;
  for (const raw of t.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; continue; }
    // 只看列表项（要点、规则）：普通段落常是讲这份文档自己的话（「本文节号沿用 CLAUDE.md」），每份各写一句才对，不能当重复删
    const item = raw.match(/^\s*(?:[-*+]|\d+[.、)])\s+(.*)$/);
    const line = item ? item[1].trim() : '';
    if (fence || !line || [...line].length < MIN_DUP_CHARS) continue;
    out.push(line);
  }
  return { file, lines: out };
}
function dupLines(root, projectDir) {
  const { norm } = require('./parser');
  const out = [];
  const cache = new Map();
  const linesOf = ref => { if (!cache.has(ref)) cache.set(ref, docLines(projectDir, ref)); return cache.get(ref); };
  for (const n of walk(root)) {
    if (!n.id || !n.parent) continue;
    for (const ref of n.docs) {
      const mine = linesOf(ref);
      if (!mine) continue;
      for (let p = n.parent; p; p = p.parent) {
        // 上级的文档提示要在下级的文件上也加载，删掉下级这一行才不丢（下级自己写了别处的文件范围时不一定）
        if (p.docs.length && !covers(p, n)) continue;
        for (const up of p.docs) {
          const theirs = linesOf(up);
          if (!theirs || theirs.file === mine.file) continue;
          const have = new Set(theirs.lines.map(norm));
          for (const line of mine.lines) {
            if (out.length >= MAX_DUPS || !have.has(norm(line))) continue;
            const key = `struct|dup|${mine.file}|${norm(line)}`;
            if (out.some(q => q.memKey === key)) continue;
            out.push(judgment(key, `${mine.file} 里的「${line}」和上级（${p.id || '最顶上'}）的 ${theirs.file} 一字不差：从 ${mine.file} 删掉`,
              { k: 'q.structDup', a: [mine.file, line, p.id || 'P', theirs.file] }, [{ op: 'doc_remove', file: mine.file, text: line }]));
          }
        }
      }
    }
  }
  return out;
}

module.exports = { plan, chapterSection, titleOf, dupLines, NOT_CONTENT, isBackup };
