'use strict';
// 升级：旧版的一整份 需求树.md（标题 = 需求，> 文件：、> 文档：、列表项 = 规则）拆成 .claude/rules/ruletree/ 里每需求一个文件。
// - 层级改成看编号：编号对不上上级的（手写的、自动补的）换成 上级编号.序号，换了哪些写进结果
// - 没写文件对应的需求沿用最近上级的范围（旧版就是这样继承的），写进自己的 paths
// - 旧的规则键 [键]：下级用同一个键覆盖上级的，改成规则末尾的「（在本范围内取代 R1 的「……」）」；键本身去掉
// - 旧树文件挪到 .ruletree/legacy/ 留底；旧版编译出的 .claude/rules/reqtree/ 删掉
const fs = require('fs');
const path = require('path');
const T = require('./tree');
const store = require('./store');

// ---------- 旧格式的解析（只为升级保留） ----------
const ID_SRC = '[A-Z][A-Z0-9]*(?:\\.\\d+)*';
const ID_RE = new RegExp(`^(${ID_SRC})\\s+(.+)$`);
const FILES_RE = /^\s*>\s*(?:文件|files)\s*[:：]\s*(.+)$/i;
const DOCS_RE = /^\s*>\s*(?:文档|docs?)\s*[:：]\s*(.+)$/i;
const KEY_RE = /^\[([^\]]+)\]\s*(.*)$/;
const STATUS = { '✅': 'done', '🔨': 'doing', '⏳': 'todo', '❓': 'question' };
// 旧版自动生成的树开头的说明，不搬
const OLD_INTROS = [/^这棵树按项目的文件夹自动生成/, /^这棵树由 AI 读项目后生成/];

// 旧版的「> 文档：」也按顿号分，可节名里常有顿号（#一、写作风格）：顿号分出来的每段都像文件路径才分
const splitOldDocs = s => s.split(/[,，]/).map(x => x.trim()).filter(Boolean)
  .flatMap(x => { const parts = x.split('、').map(y => y.trim()).filter(Boolean); return parts.length > 1 && parts.every(y => /\.\w+(#|$)/.test(y)) ? parts : [x]; });

function parseLegacy(text) {
  const root = { level: 0, children: [], rules: [], notes: [], files: [], docs: [] };
  const stack = [root];
  let fence = null, inComment = false;
  for (const raw of text.split(/\r?\n/)) {
    const fm = raw.match(/^\s*(`{3,}|~{3,})/);
    if (fm) { if (!fence) fence = fm[1][0]; else if (fm[1][0] === fence) fence = null; continue; }
    if (fence) continue;
    if (inComment) { if (raw.includes('-->')) inComment = false; continue; }
    if (/^\s*<!--/.test(raw)) { if (!raw.includes('-->')) inComment = true; continue; }
    const h = raw.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      let rest = h[2].replace(/️/g, '').trim(), status = null;
      for (const [e, s] of Object.entries(STATUS)) if (rest.endsWith(e)) { rest = rest.slice(0, -e.length).trim(); status = s; }
      const m = rest.match(ID_RE);
      while (stack[stack.length - 1].level >= h[1].length) stack.pop();
      const node = { id: m ? m[1] : null, title: (m ? m[2] : rest).trim(), status, level: h[1].length, rules: [], notes: [], body: [], files: [], docs: [], children: [], parent: stack[stack.length - 1] };
      node.parent.children.push(node);
      stack.push(node);
      continue;
    }
    const node = stack[stack.length - 1];
    if (node === root) continue;
    let m;
    if ((m = raw.match(FILES_RE))) { node.files.push(...T.splitGlobs(m[1])); continue; }
    if ((m = raw.match(DOCS_RE))) { node.docs.push(...splitOldDocs(m[1])); continue; }
    if ((m = raw.match(/^\s*[-*]\s+(.*)$/))) {
      const k = m[1].match(KEY_RE);
      const rule = { key: k ? k[1].trim() : null, text: (k ? k[2] : m[1]).trim() };
      node.rules.push(rule);
      node.body.push({ rule });
    } else if (raw.trim()) { node.notes.push(raw.trim()); node.body.push({ note: raw.trim() }); }
  }
  return root;
}

// 旧树文本 → 新的规则文件（Map 文件名 → 文本）。返回 { files, renamed: [{ from, to, title }] }
function convert(text, projectName = 'P') {
  const old = parseLegacy(text);
  const tops = old.children;
  const P = tops[0] || { id: 'P', title: projectName, rules: [], notes: [], docs: [], children: [] };
  // 第一个一级标题是根需求；还有别的一级标题的，当成根下面的需求
  const kids = [...P.children, ...tops.slice(1)];
  const files = new Map();
  const renamed = [];
  const taken = new Set([P.id || 'P']);
  const rootLines = [`# ${P.id || 'P'} ${P.title || projectName}`];
  if (P.docs.length) rootLines.push(`文档：${P.docs.join(', ')}`);
  rootLines.push(...(P.body || []).filter(b => b.rule || !OLD_INTROS.some(re => re.test(b.note))).map(b => (b.rule ? `- ${b.rule.text}` : b.note)));
  files.set(T.ROOT_FILE, rootLines.join('\n') + '\n');

  // 先定每个需求的新编号：根下面的不能带点，更深的要是 上级编号.序号
  const newId = new Map();
  const fresh = (parentId, wanted) => {
    if (wanted && !taken.has(wanted) && (parentId ? T.parentId(wanted) === parentId : !wanted.includes('.'))) return wanted;
    const letter = !parentId && wanted ? (wanted.match(/^[A-Z]+/) || ['R'])[0] : 'R';
    for (let i = 1; ; i++) { const id = parentId ? `${parentId}.${i}` : `${letter}${i}`; if (!taken.has(id)) return id; }
  };
  const assign = (list, parentId) => {
    // 先给本来就对的占位，再给对不上的分配，免得后者抢了前者的号
    const ok = list.filter(n => n.id && !taken.has(n.id) && (parentId ? T.parentId(n.id) === parentId : !n.id.includes('.')));
    ok.forEach(n => { newId.set(n, n.id); taken.add(n.id); });
    for (const n of list) {
      if (newId.has(n)) continue;
      const id = fresh(parentId, n.id);
      newId.set(n, id);
      taken.add(id);
      if (n.id && n.id !== id) renamed.push({ from: n.id, to: id, title: n.title });
    }
    list.forEach(n => assign(n.children, newId.get(n)));
  };
  assign(kids, null);

  const scopeOf = n => { for (let x = n; x && x !== P && x.parent; x = x.parent) if (x.files.length) return x.files; return []; };
  const write = (n, parent) => {
    // 下级用同一个键覆盖上级的规则 → 取代说明
    const ruleLine = r => {
      if (!r.key) return r.text;
      for (let p = n.parent; p && p.parent; p = p.parent) {
        const hit = p.rules.find(x => x.key === r.key);
        if (hit) return r.text + T.overrideText(p === P ? P.id || 'P' : newId.get(p), hit.text, r.text + hit.text);
      }
      return r.text;
    };
    const id = newId.get(n);
    const head = T.newFile({ id, title: n.title, status: n.status, globs: scopeOf(n), parent: parent ? { id: newId.get(parent), title: parent.title } : null, docs: n.docs });
    // 说明文字和规则按原来的先后写
    const body = n.body.map(b => (b.rule ? `- ${ruleLine(b.rule)}` : b.note));
    files.set(T.fileName(id, n.title), head + (body.length ? body.join('\n') + '\n' : ''));
    n.children.forEach(c => write(c, n));
  };
  kids.forEach(n => write(n, null));
  return { files, renamed };
}

// 旧版编译出的规则文件夹（.claude/rules/reqtree/，含每个 worktree 里抄的那份）：只删旧版自己生成的文件
function removeOldRules(dir) {
  const removed = [];
  for (const root of [dir, ...require('./common').worktreesOf(dir)]) {
    const old = path.join(root, '.claude', 'rules', 'reqtree');
    let names = [];
    try { names = fs.readdirSync(old); } catch { continue; }
    for (const n of names) {
      const p = path.join(old, n);
      try { if (/reqtree:(generated|codemap)/.test(fs.readFileSync(p, 'utf8'))) { fs.unlinkSync(p); removed.push(p); } } catch {}
    }
    try { if (!fs.readdirSync(old).length) fs.rmdirSync(old); } catch {}
  }
  return removed;
}

// 在项目里升级：有旧树文件、还没有新的规则文件时才做。返回 null（不用升级）或 { count, renamed, legacy }
function upgrade(dir) {
  const legacy = store.legacyTree(dir);
  if (!legacy || store.hasRules(dir)) return null;
  const { files, renamed } = convert(fs.readFileSync(legacy, 'utf8'), path.basename(dir));
  store.replaceAll(dir, files, { source: '升级' });
  const keep = store.metaFile(dir, path.join('legacy', path.basename(legacy)));
  fs.mkdirSync(path.dirname(keep), { recursive: true });
  fs.renameSync(legacy, keep);
  removeOldRules(dir);
  return { count: files.size - 1, renamed, legacy: keep };
}

module.exports = { parseLegacy, convert, upgrade, removeOldRules };
