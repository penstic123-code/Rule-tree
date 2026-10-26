'use strict';
// 需求树 = .claude/rules/ruletree/ 里的规则文件，每个需求一个文件，Claude Code 按文件开头的 paths: 原生加载。
// 本模块只管内容：把一组文件（Map 文件名 → 文本）读成一棵树、在树上做编辑操作再写回文本。读写磁盘、改动记录在 src/store.js。
//
// 文件格式（R1.2-体检与整理.md）：
//   ---
//   paths:
//     - "src/checkup.js"
//   ---
//   # R1.2 体检与整理 🔨
//   上级：R1 规则记录与送达
//   文档：docs/design.md#六、体检
//   - 规则（列表项）。用户拍板的以「决定：」开头
// _root.md 是根需求（不写 paths，每次都加载），_guide.md 是工具生成的说明书（不算需求）。
// 层级看编号：R1.2 的上级是 R1，没有点的编号挂在根下。「上级：」一行只是写给 AI 看的，读的时候不用它。
// 下级推翻上级的规则时，规则后面写「（在本范围内取代 R1 的「……」）」。

const STATUS = { '✅': 'done', '🔨': 'doing', '⏳': 'todo', '❓': 'question' };
const STATUS_EMOJI = Object.fromEntries(Object.entries(STATUS).map(([e, s]) => [s, e]));
const STATUS_LABEL = { done: '完成', doing: '进行中', todo: '待做', question: '待定' };

const ROOT_FILE = '_root.md';
const GUIDE_FILE = '_guide.md';
const ID_SRC = '[A-Z][A-Z0-9]*(?:\\.\\d+)*';
const ID_ONLY = new RegExp(`^${ID_SRC}$`);
const HEAD_RE = /^#\s+(.*)$/;
const RULE_RE = /^\s*[-*]\s+(.*)$/;
const PARENT_RE = /^\s*>?\s*(?:上级|parent)\s*[:：]\s*(.*)$/i;
const DOCS_RE = /^\s*>?\s*(?:文档|docs?)\s*[:：]\s*(.+)$/i;
const DECISION_RE = /^(?:决定|decision)\s*[:：]/i;
// 下级取代上级某条规则的说明（写在规则末尾）
// 英文的规则写英文的说明：「 (in this scope, replaces R1's "……")」
const OVERRIDE_RE = /（在本范围内(?:以此为准，)?取代\s*(?:上级\s*)?(\S+?)\s*的「(.+)」）\s*$|\s*\(in this scope, replaces (\S+?)'s "(.+)"\)\s*$/;
const CJK = /[一-鿿]/;
// 「上级：」「文档：」行：中文的规则文件写中文，英文的写 Parent: / Docs:
const label = (k, zh) => (k === 'parent' ? (zh ? '上级：' : 'Parent: ') : zh ? '文档：' : 'Docs: ');
const overrideText = (ownerId, text, sample = text) => (CJK.test(sample) ? `（在本范围内取代 ${ownerId} 的「${text}」）` : ` (in this scope, replaces ${ownerId}'s "${text}")`);

const isRuleFile = name => /\.md$/i.test(name) && name !== GUIDE_FILE;
const lineEnding = text => (text.includes('\r\n') ? '\r\n' : '\n');
const splitLines = text => String(text).split(/\r?\n/);

function splitStatus(text) {
  const rest = text.replace(/️/g, '').trim();
  for (const [emoji, status] of Object.entries(STATUS)) if (rest.endsWith(emoji)) return { rest: rest.slice(0, -emoji.length).trim(), status };
  return { rest, status: null };
}

// ---------- 文件头（YAML front matter，只认 paths） ----------

// 文件头在第几行到第几行（含两条 ---）；没有返回 null
function frontRange(lines) {
  if (!/^---\s*$/.test(lines[0] || '')) return null;
  for (let i = 1; i < lines.length; i++) if (/^---\s*$/.test(lines[i])) return { start: 0, end: i };
  return null;
}
const unquote = s => {
  const t = s.trim();
  if (/^"(.*)"$/.test(t)) { try { return JSON.parse(t); } catch { return t.slice(1, -1); } }
  return t.replace(/^'(.*)'$/, '$1');
};
// paths 写成列表（- "a"）、行内数组（["a", "b"]）或一个字符串都认
// 行内数组 ["a", 'b', c/{x,y}.js]：按顶层逗号分，引号和花括号里的逗号不分
function splitInline(s) {
  const out = [];
  let cur = '', quote = null, depth = 0;
  for (const c of s) {
    if (quote) { if (c === quote) quote = null; cur += c; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && depth) depth--;
    else if (c === ',' && !depth) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map(unquote).filter(Boolean);
}
// 列表项可以缩进也可以不缩进（两种都是合法的 YAML）
const LIST_ITEM = /^\s*-\s+(.*)$/;
function readPaths(lines, fr) {
  const out = [];
  for (let i = fr.start + 1; i < fr.end; i++) {
    const m = lines[i].match(/^paths\s*:\s*(.*)$/);
    if (!m) continue;
    const inline = m[1].trim();
    if (inline.startsWith('[')) out.push(...splitInline(inline.replace(/^\[|\]$/g, '')));
    else if (inline) out.push(unquote(inline));
    for (let j = i + 1; j < fr.end; j++) {
      const it = lines[j].match(LIST_ITEM);
      if (!it) break;
      out.push(unquote(it[1]));
    }
  }
  return out.filter(Boolean);
}
// 换掉文件头里的 paths（别的键原样留着）；globs 为空就去掉 paths，文件头也没别的了就整个去掉
function writePaths(lines, globs) {
  const block = globs.length ? ['paths:', ...globs.map(g => `  - ${JSON.stringify(g)}`)] : [];
  const fr = frontRange(lines);
  if (!fr) { if (block.length) lines.splice(0, 0, '---', ...block, '---'); return; }
  const inner = lines.slice(fr.start + 1, fr.end);
  const kept = [];
  for (let i = 0; i < inner.length; i++) {
    if (/^paths\s*:/.test(inner[i])) { while (i + 1 < inner.length && LIST_ITEM.test(inner[i + 1])) i++; continue; }
    kept.push(inner[i]);
  }
  const next = [...block, ...kept.filter(l => l.trim())];
  lines.splice(fr.start, fr.end - fr.start + 1, ...(next.length ? ['---', ...next, '---'] : []));
}

// 「文档：」一行：逗号分开（不按顿号：节名里常有「六、体检」）；每项是「路径」或「路径#节名」，后面可以带（说明）
const splitDocs = s => s.split(/[,，；;]/).map(x => x.trim()).filter(Boolean);
const docPath = d => d.replace(/\s*[（(].*$/, '').trim();

// ---------- 读 ----------

// 一个文件 → 节点（还没接上下级）
function parseFile(name, text) {
  const lines = splitLines(String(text).replace(/^﻿/, ''));
  const fr = frontRange(lines);
  const node = { id: null, title: '', status: null, files: fr ? readPaths(lines, fr) : [], docs: [], rules: [], notes: [], children: [], parent: null, file: name, line: -1, root: name === ROOT_FILE };
  let fence = null, comment = false;
  for (let i = fr ? fr.end + 1 : 0; i < lines.length; i++) {
    const raw = lines[i];
    const fm = raw.match(/^\s*(`{3,}|~{3,})/);
    if (fm) { if (!fence) fence = fm[1][0]; else if (fm[1][0] === fence) fence = null; continue; }
    if (fence) continue;
    // HTML 注释（可以跨好几行）里的不算
    if (comment) { if (raw.includes('-->')) comment = false; continue; }
    if (/^\s*<!--/.test(raw)) { if (!raw.includes('-->')) comment = true; continue; }
    const h = node.line < 0 && raw.match(HEAD_RE);
    if (h) {
      const { rest, status } = splitStatus(h[1]);
      const m = rest.match(new RegExp(`^(${ID_SRC})(?:\\s+(.*))?$`));
      node.id = m ? m[1] : null;
      node.title = (m ? m[2] || '' : rest).trim();
      node.status = status;
      node.line = i;
      continue;
    }
    if (PARENT_RE.test(raw)) continue;
    const d = raw.match(DOCS_RE);
    if (d) { for (const x of splitDocs(d[1])) if (!node.docs.includes(docPath(x))) node.docs.push(docPath(x)); continue; }
    const r = raw.match(RULE_RE);
    if (r) node.rules.push({ text: r[1].trim(), line: i, owner: node, decision: DECISION_RE.test(r[1].trim()) });
    else if (raw.trim()) node.notes.push(raw.trim());
  }
  // 标题行没写编号：从文件名取（R1.2-xxx.md）
  if (!node.id) { const m = name.match(new RegExp(`^(${ID_SRC})(?:-|\\.md$)`)); if (m) node.id = m[1]; }
  if (node.root && !node.id) node.id = 'P';
  return node;
}

// 编号自然排序：R2 < R10，R1.2 < R1.10
function compareIds(a, b) {
  const pa = a.split(/(\d+)/), pb = b.split(/(\d+)/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || '', y = pb[i] || '';
    if (x === y) continue;
    return /^\d+$/.test(x) && /^\d+$/.test(y) ? Number(x) - Number(y) : x < y ? -1 : 1;
  }
  return 0;
}
const parentId = id => (id.includes('.') ? id.slice(0, id.lastIndexOf('.')) : null);

// 一组文件 → 树。返回虚拟的根 { children: [根需求] }；根需求（_root.md，没有就是空的 P）下面挂所有需求。
// problems：编号重复、上级不存在、文件里没有编号
function build(files) {
  const root = { id: '', title: '', children: [], parent: null, rules: [], files: [], docs: [], level: 0, problems: [] };
  const nodes = [];
  let top = null;
  for (const [name, text] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!isRuleFile(name)) continue;
    const n = parseFile(name, text);
    if (n.root) { top = n; continue; }
    if (!n.id) { root.problems.push({ k: 'noId', file: name }); continue; }
    nodes.push(n);
  }
  if (!top) top = { ...parseFile(ROOT_FILE, ''), missing: true };
  top.parent = root;
  root.children.push(top);
  const byId = new Map([[top.id, top]]);
  nodes.sort((a, b) => compareIds(a.id, b.id));
  for (const n of nodes) {
    if (byId.has(n.id)) { root.problems.push({ k: 'dupId', id: n.id, file: n.file, other: byId.get(n.id).file }); continue; }
    byId.set(n.id, n);
  }
  for (const n of nodes) {
    if (byId.get(n.id) !== n) continue;
    const pid = parentId(n.id);
    let parent = pid ? byId.get(pid) : top;
    if (!parent) { root.problems.push({ k: 'noParent', id: n.id, parent: pid, file: n.file }); parent = top; }
    n.parent = parent;
    parent.children.push(n);
  }
  const depth = (n, d) => { n.level = d; n.children.forEach(c => depth(c, d + 1)); };
  depth(top, 1);
  return root;
}

function* walk(node) {
  for (const c of node.children) { yield c; yield* walk(c); }
}
function findById(root, id) {
  for (const n of walk(root)) if (n.id === id) return n;
  return null;
}
function pathOf(node) {
  const out = [];
  for (let n = node; n && n.parent; n = n.parent) out.unshift(n);
  return out;
}
// 根需求（_root.md）：规则全局生效
const isRoot = node => !!node && (!node.parent || !node.parent.parent);

// 规则末尾的取代说明 → { ref, text }（取代谁的哪一条）；没有返回 null
function overrideOf(text) {
  const m = String(text).match(OVERRIDE_RE);
  return m ? { ref: m[1] || m[3], text: m[2] || m[4], at: m.index } : null;
}

// ---------- 比较规则 ----------

// 比较规则时忽略标点、空格和大小写
const norm = s => String(s || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
// 两条规则有多像（0–1）：相邻两个字的组合按 Dice 系数算。中文没有空格分词，用字对比较稳
function similarity(a, b) {
  const grams = s => { const t = [...norm(s)], g = new Set(); for (let i = 0; i < t.length - 1; i++) g.add(t[i] + t[i + 1]); return g; };
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return norm(a) === norm(b) ? 1 : 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return (2 * hit) / (A.size + B.size);
}
// 达到这个重合度算同一条规则的另一种说法。「段落都不超过 4 行」/「段落不超过 4 行」0.77 算；「开场用伦敦地图」/「开场用勇士」0.4 不算
const DUPLICATE = 0.7;
// 字面很像，意思可能相反或换了数：「不超过 5 道」和「不超过 3 道」重合度 0.85。所以还要数字一样、否定词一样多
const numbersOf = s => (String(s).match(/[\d零一二两三四五六七八九十百千]+(?:\.\d+)?/g) || []).join(',');
const negationsOf = s => (String(s).match(/[不别没无非勿禁]/g) || []).length;
const sameMeaning = (a, b) => similarity(a, b) >= DUPLICATE && numbersOf(a) === numbersOf(b) && negationsOf(a) === negationsOf(b);

// 按原文找本需求的规则：先逐字，再忽略标点和空格。不找「最像的」：面板、体检传来的都是原文，
// 对不上说明那条已经被改过，猜一条最像的会改错（「标题用蓝色」删掉了后来的「标题用红色」）
function findRule(node, text) {
  if (!node || !text) return null;
  return node.rules.find(r => r.text === text) || node.rules.find(r => norm(r.text) === norm(text)) || null;
}

// ---------- 文件路径匹配 ----------

// glob 片段 → 正则片段。支持 **、*、?、{a,b}（可嵌套；没配对的花括号按普通字符）
function globBody(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { re += '(?:.*/)?'; i++; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') {
      let depth = 0, j = i, from = i + 1;
      const parts = [];
      for (; j < glob.length; j++) {
        if (glob[j] === '{') depth++;
        else if (glob[j] === '}' && --depth === 0) break;
        else if (glob[j] === ',' && depth === 1) { parts.push(glob.slice(from, j)); from = j + 1; }
      }
      if (j >= glob.length) { re += '\\{'; continue; }
      parts.push(glob.slice(from, j));
      re += `(?:${parts.map(globBody).join('|')})`;
      i = j;
    } else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return re;
}
// Windows 和 macOS 的文件系统默认不分大小写，Linux 区分
const globToRegExp = glob => new RegExp('^' + globBody(glob) + '$', process.platform === 'win32' || process.platform === 'darwin' ? 'i' : '');
const matchesAny = (globs, rel) => (globs || []).some(g => globToRegExp(g).test(rel));
// 输入框里的一串 glob：按逗号和空白拆，花括号里的逗号不拆（{ch18,ch19}-*.html 是一个）
function splitGlobs(s) {
  const out = [];
  let cur = '', depth = 0;
  for (const c of String(s)) {
    if (c === '{') depth++;
    else if (c === '}' && depth) depth--;
    if (!depth && /[,，\s]/.test(c)) { if (cur) out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}
// 文件属于哪些需求（rel 是相对项目根、用 / 分隔的路径），从浅到深；根需求不算（它管所有文件）
const nodesForFile = (root, rel) => [...walk(root)].filter(n => !isRoot(n) && matchesAny(n.files, rel)).sort((a, b) => a.level - b.level);
const nodeForFile = (root, rel) => nodesForFile(root, rel).pop() || null;

// ---------- 写 ----------

// 文件名：编号-标题.md（标题里文件名不能用的字符换成 -）
const fileName = (id, title) => `${id}-${String(title).trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || id}.md`;

// 新需求的文件内容
function newFile({ id, title, status = null, globs = [], parent = null, docs = [] }) {
  const lines = [];
  if (globs.length) lines.push('---', 'paths:', ...globs.map(g => `  - ${JSON.stringify(g)}`), '---');
  lines.push(`# ${id} ${title.trim()}${status ? ' ' + STATUS_EMOJI[status] : ''}`);
  const zh = CJK.test(title + (parent ? parent.title : ''));
  if (parent) lines.push(label('parent', zh) + `${parent.id} ${parent.title}`);
  if (docs.length) lines.push(label('docs', zh) + docs.join(', '));
  return lines.join('\n') + '\n';
}

// 新需求的编号：根下面沿用兄弟们最常用的字母（R1、R2 → R3），更深的用 上级编号.序号
function nextChildId(root, parent) {
  const taken = new Set([...walk(root)].map(n => n.id));
  let make;
  if (isRoot(parent)) {
    const count = new Map();
    for (const c of parent.children) { const m = c.id.match(/^([A-Z]+)\d+$/); if (m) count.set(m[1], (count.get(m[1]) || 0) + 1); }
    let L = 'R', best = 0;
    for (const [letter, k] of count) if (k > best) { L = letter; best = k; }
    make = i => `${L}${i}`;
  } else make = i => `${parent.id}.${i}`;
  for (let i = parent.children.length + 1; ; i++) if (!taken.has(make(i))) return make(i);
}

// 一行规则插在哪：最后一条规则之后；还没有规则就在标题和「上级」「文档」行之后
function ruleInsertAt(lines, node) {
  if (node.rules.length) return node.rules[node.rules.length - 1].line + 1;
  let at = node.line >= 0 ? node.line + 1 : (frontRange(lines) ? frontRange(lines).end + 1 : 0);
  while (at < lines.length && (PARENT_RE.test(lines[at]) || DOCS_RE.test(lines[at]))) at++;
  return at;
}
const oneLine = s => (typeof s === 'string' ? s.replace(/[\r\n]+/g, ' ').trim() : s);

// 新规则和本需求或上级的某条像（≥ 0.7）时：意思一样 → 跳过；本需求的 → 改写那条；上级的 → 在本需求里取代它
function nearRule(node, text) {
  let best = null, score = 0;
  for (let n = node; n && n.parent; n = n.parent) {
    for (const r of n.rules) {
      if (sameMeaning(r.text, text)) return 'duplicate';
      const s = similarity(r.text, text);
      if (s > score) { best = r; score = s; }
    }
  }
  if (!best || score < DUPLICATE) return null;
  if (best.owner === node) return { op: 'replace_rule', node: node.id, old: best.text, text };
  return { op: 'override_rule', node: node.id, from: best.owner.id, text: best.text, new: text };
}

// 编辑操作（面板、体检共用），都直接改成最终样子。files 是 Map 文件名 → 文本，不改传进来的那份：
//   {op:'add_rule', node, text, force?}   新规则；和本需求或上级意思一样的跳过，字面像但数字或否定变了的改写或取代（force 不查）
//   {op:'replace_rule', node, old, text}  改写一条
//   {op:'remove_rule', node, text}        删一条（原文对不上时找唯一最像、数字相同的）
//   {op:'override_rule', node, from, text, new}  在下级里取代上级 from 的一条：加一条带取代说明的规则
//   {op:'add_node', parent, id?, title, globs?}  新需求（新文件）；没给 globs 就沿用上级的范围
//   {op:'set_files', node, globs} / {op:'add_files', node, globs}  管哪些文件（文件头的 paths）
//   {op:'set_docs', node, docs} / {op:'add_docs', node, docs}      挂的文档
//   {op:'set_status', node, status|null}  {op:'rename_node', node, title}  {op:'delete_node', node}（连下级一起删）
// 返回 { files, applied: [做成的 op，带补充字段], skipped: [{ op, reason }] }
function applyOps(input, ops) {
  const files = new Map(input);
  const applied = [], skipped = [];
  const queue = [...(ops || [])];
  while (queue.length) {
    const raw = queue.shift();
    if (!raw || typeof raw !== 'object') { skipped.push({ op: raw, reason: 'unknown-op' }); continue; }
    const op = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v.map(oneLine).filter(Boolean) : oneLine(v)]));
    const skip = reason => skipped.push({ op, reason });
    const root = build(files);
    const node = op.node ? findById(root, op.node) : null;
    // 要改的需求的文件没有标题行（空的 _root.md、手写漏了）：先补上标题行再重来，规则的行号才对得上
    if (node && node.line < 0) {
      const text = (files.get(node.file) || '').replace(/^﻿/, '');
      const lines = text ? splitLines(text) : [];
      const fr = frontRange(lines);
      lines.splice(fr ? fr.end + 1 : 0, 0, `# ${node.id} ${node.title || ''}`.trim());
      files.set(node.file, lines.join(text ? lineEnding(text) : '\n'));
      queue.unshift(raw);
      continue;
    }
    const edit = (n, fn) => {
      const text = (files.get(n.file) || '').replace(/^﻿/, '');
      const nl = text ? lineEnding(text) : '\n';
      const lines = text ? splitLines(text) : [];
      fn(lines, n);
      const out = lines.join(nl).replace(/\s*$/, '') + nl;
      files.set(n.file, out);
      return true;
    };
    let extra = {};
    switch (op.op) {
      case 'add_rule': {
        if (!node) { skip('no-node'); continue; }
        if (!op.text) { skip('empty'); continue; }
        if (!op.force) {
          const near = nearRule(node, op.text);
          if (near === 'duplicate') { skip('duplicate'); continue; }
          if (near) { queue.unshift(near); continue; }
        }
        edit(node, (lines, n) => lines.splice(ruleInsertAt(lines, n), 0, `- ${op.text}`));
        break;
      }
      case 'replace_rule': {
        if (!node) { skip('no-node'); continue; }
        if (!op.text) { skip('empty'); continue; }
        const old = findRule(node, op.old);
        if (!old) { skip('no-rule'); continue; }
        if (old.text === op.text) { skip('same'); continue; }
        extra = { old: old.text };
        edit(node, lines => { lines[old.line] = lines[old.line].replace(/^(\s*[-*]\s+).*$/, (_, head) => head + op.text); });
        break;
      }
      case 'remove_rule': {
        if (!node) { skip('no-node'); continue; }
        const r = findRule(node, op.text);
        if (!r) { skip('no-rule'); continue; }
        extra = { text: r.text };
        edit(node, lines => lines.splice(r.line, 1));
        break;
      }
      case 'override_rule': {
        const from = op.from && findById(root, op.from);
        if (!node || !from) { skip('no-node'); continue; }
        if (from === node || !pathOf(node).includes(from)) { skip('not-ancestor'); continue; }
        const base = findRule(from, op.text);
        if (!base) { skip('no-rule'); continue; }
        if (!op.new) { skip('empty'); continue; }
        const text = op.new + overrideText(from.id, base.text, op.new + base.text);
        const prev = node.rules.find(r => { const o = overrideOf(r.text); return o && o.ref === from.id && norm(o.text) === norm(base.text); });
        if (prev && prev.text === text) { skip('same'); continue; }
        edit(node, (lines, n) => { if (prev) lines[prev.line] = `- ${text}`; else lines.splice(ruleInsertAt(lines, n), 0, `- ${text}`); });
        extra = { text: base.text };
        break;
      }
      case 'add_node': {
        const parent = op.parent ? findById(root, op.parent) : root.children[0];
        if (!parent) { skip('no-node'); continue; }
        if (!op.title) { skip('empty'); continue; }
        const id = op.id || nextChildId(root, parent);
        if (findById(root, id) || !ID_ONLY.test(id) || (isRoot(parent) ? id.includes('.') : parentId(id) !== parent.id)) { skip('bad-id'); continue; }
        const globs = op.globs && op.globs.length ? op.globs : isRoot(parent) ? [] : parent.files;
        const name = fileName(id, op.title);
        if (files.has(name)) { skip('bad-id'); continue; }
        files.set(name, newFile({ id, title: op.title, globs, parent: isRoot(parent) ? null : parent }));
        extra = { id };
        break;
      }
      case 'set_files': case 'add_files': {
        if (!node) { skip('no-node'); continue; }
        if (isRoot(node)) { skip('root'); continue; }
        const globs = [...new Set(op.op === 'set_files' ? op.globs || [] : [...node.files, ...(op.globs || [])])];
        if (globs.join('\n') === node.files.join('\n')) { skip('same'); continue; }
        extra = { globs, before: node.files };
        edit(node, lines => writePaths(lines, globs));
        break;
      }
      case 'set_docs': case 'add_docs': {
        if (!node) { skip('no-node'); continue; }
        const docs = [...new Set(op.op === 'set_docs' ? op.docs || [] : [...node.docs, ...(op.docs || [])])];
        if (docs.join('\n') === node.docs.join('\n')) { skip('same'); continue; }
        extra = { docs };
        edit(node, (lines, n) => {
          const at = lines.findIndex((l, i) => i > n.line && DOCS_RE.test(l));
          const zh = at >= 0 ? /文档/.test(lines[at]) : CJK.test(lines.join(' '));
          if (at >= 0 && docs.length) lines[at] = label('docs', zh) + docs.join(', ');
          else if (at >= 0) lines.splice(at, 1);
          else {
            let i = n.line + 1;
            while (i < lines.length && PARENT_RE.test(lines[i])) i++;
            lines.splice(i, 0, label('docs', zh) + docs.join(', '));
          }
        });
        break;
      }
      case 'set_status': {
        const status = op.status || null;
        if (!node) { skip('no-node'); continue; }
        if (status && !(status in STATUS_EMOJI)) { skip('bad-status'); continue; }
        if (node.status === status) { skip('same'); continue; }
        extra = { before: node.status };
        edit(node, (lines, n) => { lines[n.line] = `# ${n.id} ${n.title}${status ? ' ' + STATUS_EMOJI[status] : ''}`.replace(/\s+$/, ''); });
        break;
      }
      case 'rename_node': {
        if (!node) { skip('no-node'); continue; }
        if (!op.title) { skip('empty'); continue; }
        if (node.title === op.title) { skip('same'); continue; }
        extra = { old: node.title };
        edit(node, (lines, n) => { lines[n.line] = `# ${n.id} ${op.title}${n.status ? ' ' + STATUS_EMOJI[n.status] : ''}`; });
        // 文件名带标题：跟着改（根需求的文件名固定）
        if (!isRoot(node)) {
          const to = fileName(node.id, op.title);
          if (to !== node.file && !files.has(to)) { files.set(to, files.get(node.file)); files.delete(node.file); }
        }
        // 下级文件里的「上级：」一行
        for (const c of node.children) {
          const t = files.get(c.file);
          if (!t) continue;
          const nl = lineEnding(t);
          files.set(c.file, splitLines(t).map(l => (PARENT_RE.test(l) ? label('parent', /上级/.test(l)) + `${node.id} ${op.title}` : l)).join(nl));
        }
        break;
      }
      case 'delete_node': {
        if (!node) { skip('no-node'); continue; }
        if (isRoot(node)) { skip('root'); continue; }
        extra = { title: node.title };
        for (const n of [node, ...walk(node)]) files.delete(n.file);
        break;
      }
      default: skip('unknown-op'); continue;
    }
    applied.push({ ...op, ...extra });
  }
  return { files, applied, skipped };
}

const SKIP_REASON = {
  'no-node': '找不到这个需求', 'no-rule': '找不到这条规则', empty: '内容是空的', same: '和现在一样', duplicate: '已经有意思一样的规则',
  'bad-id': '编号不合法或已被占用', 'bad-status': '状态不认识', 'unknown-op': '不认识的操作', 'not-ancestor': '只能取代上级需求的规则', root: '根需求不能这样改',
};

module.exports = {
  STATUS_EMOJI, STATUS_LABEL, DECISION_RE, ROOT_FILE, GUIDE_FILE, ID_ONLY, SKIP_REASON,
  isRuleFile, parseFile, build, walk, findById, pathOf, isRoot, compareIds, parentId, overrideOf, overrideText,
  norm, similarity, DUPLICATE, numbersOf, sameMeaning, findRule,
  globToRegExp, matchesAny, splitGlobs, splitDocs, docPath, nodesForFile, nodeForFile,
  fileName, newFile, nextChildId, applyOps, splitLines, lineEnding,
};
