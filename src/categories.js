'use strict';
// 规则分类：只改面板的显示方式，需求树.md 不动。
// 体检时模型给规则多的需求（MIN_RULES 条以上）分组，比如「画风」「写作」「互动」「工作流」，存在 .reqtree/categories.json：
//   { "<需求 ID>": { "<规则文字（norm 后）>": "分类名" } }
// 面板按分类显示这些需求的规则。规则后来被改写、对不上了，就显示在「其他」里，下次体检再分。
// 分类不影响规则怎么加载、怎么记，只是给人看的
const fs = require('fs');
const store = require('./store');
const { parse, walk, findById, norm, globToRegExp } = require('./parser');

const FILE = 'categories.json';
const MIN_RULES = 6; // 规则少于这么多条的需求不分组，一眼就能看完
const MAX_GROUPS = 8;
const MAX_NAME = 8; // 分类名最多几个字

function read(treePath) {
  try {
    const v = JSON.parse(fs.readFileSync(store.metaFile(treePath, FILE), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

// 这条规则的分类名；没分过返回 null
const catOf = (cats, nodeId, text) => (cats && cats[nodeId] && cats[nodeId][norm(text)]) || null;

// 已经用过的分类名（给模型参考，尽量沿用，全项目说法一致）
function names(cats) {
  const out = new Set();
  for (const m of Object.values(cats || {})) for (const v of Object.values(m || {})) out.add(v);
  return [...out];
}

// 模型给的分组 [{ node, groups: [{ name, rules: [树里原文] }] }] → 写进 categories.json。
// 需求要在树里、规则够多；规则文字对不上的跳过；分类名太长截掉。模型这次分了的需求整个换掉，没分的保留原来的；
// 树里已经没有的需求顺手删掉。返回分了组的需求 ID
function save(treePath, text, list) {
  const root = parse(text);
  const cats = read(treePath);
  const done = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item.node !== 'string' || !Array.isArray(item.groups)) continue;
    const node = findById(root, item.node.trim());
    if (!node || node.rules.length < MIN_RULES) continue;
    const own = new Map(node.rules.map(r => [norm(r.text), r]));
    const map = {};
    for (const g of item.groups.slice(0, MAX_GROUPS)) {
      if (!g || typeof g.name !== 'string' || !g.name.trim() || !Array.isArray(g.rules)) continue;
      const name = [...g.name.replace(/[\r\n]+/g, ' ').trim()].slice(0, MAX_NAME).join('');
      for (const r of g.rules) {
        const k = typeof r === 'string' && norm(r);
        if (k && own.has(k) && !map[k]) map[k] = name;
      }
    }
    if (!Object.keys(map).length) continue;
    cats[node.id] = map;
    done.push(node.id);
  }
  const ids = new Set([...walk(root)].map(n => n.id).filter(Boolean));
  for (const id of Object.keys(cats)) if (!ids.has(id)) delete cats[id];
  if (done.length) store.writeJson(store.metaFile(treePath, FILE), cats);
  return done;
}

// 一个需求范围里的文件长什么样：按「文件夹/名字前缀*扩展名」归类计数（ch01-cholera.html → ch*.html），最多 PATTERNS 类。
// 模型看到这个，才知道某组规则能不能只挂一部分文件（第一轮真实测试：不给文件分布，模型一次也没给出 files）
const PATTERNS = 10;
function filePatterns(files) {
  const count = new Map();
  for (const f of files) {
    const i = f.lastIndexOf('/');
    const dir = i < 0 ? '' : f.slice(0, i + 1), name = f.slice(i + 1);
    const m = name.match(/^([^\d]*?)\d[^.]*(\.[a-z0-9]+)$/i);
    const key = dir + (m ? `${m[1]}*${m[2]}` : name);
    count.set(key, (count.get(key) || 0) + 1);
  }
  const list = [...count].sort((a, b) => b[1] - a[1]);
  const shown = list.slice(0, PATTERNS).map(([k, n]) => (n > 1 ? `${k}（${n} 个）` : k));
  // 先列文件夹（各有多少个文件），再列最多的几类文件名
  const dirs = new Map();
  for (const f of files) { const i = f.lastIndexOf('/'); const d = i < 0 ? '（根目录）' : f.slice(0, i + 1); dirs.set(d, (dirs.get(d) || 0) + 1); }
  const dl = [...dirs].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([d, n]) => `${d} ${n} 个`);
  return `文件夹：${dl.join('、')}${dirs.size > 8 ? ` 等 ${dirs.size} 个文件夹` : ''}；常见文件：${shown.join('、')}`;
}

// 体检提示词里的这一段：哪些需求要分组、已有的分类名；files（项目里的文件，相对路径）给了就附上每个需求范围里的文件分布
function promptTask(text, cats, files = []) {
  const nodes = [...walk(parse(text))].filter(n => n.id && n.rules.length >= MIN_RULES);
  if (!nodes.length) return '';
  const big = nodes.map(n => n.id);
  const used = names(cats);
  const { scopeOf } = require('./compile');
  const layout = files.length ? nodes.map(n => {
    const scope = scopeOf(n);
    if (!scope) return '';
    const res = scope.map(globToRegExp);
    const mine = files.filter(f => res.some(re => re.test(f)));
    return mine.length ? `- ${n.id}（${scope.join('、')}）：${filePatterns(mine)}` : '';
  }).filter(Boolean) : [];
  return `
另外给规则多的需求（${big.join('、')}）的规则分组，在面板上分类显示。每个需求分 2–${MAX_GROUPS} 组，组名 2–4 个字，说清这组管什么（例：画风、写作、互动、练习、工作流、技术），用需求树的语言；同一个意思在全项目用同一个组名${used.length ? `，已有的组名尽量沿用：${used.join('、')}` : ''}。每条规则都放进一组，rules 里写树里的原文（不含 [键]）。写进 categories。
某一组规则只管这个需求里的一部分文件时，在这组加 files：glob 列表（相对项目根，要落在这个需求的文件范围里）。这样的组会拆成子需求，AI 改别的文件时就不用加载这组规则。例：一门课的规则里，「页内样式类名加章节前缀」「存储走 common.js 的封装」只管脚本和样式，可以写 files ["DataScience/js/**", "DataScience/css/**"]；「每章配三张图」只管正文页，写 ["DataScience/ch*.html"]。管这个需求全部文件的组、拿不准的组不写 files。${layout.length ? `
各需求范围里的文件分布（写 files 时照这个写）：
${layout.join('\n')}` : ''}
`;
}

module.exports = { FILE, MIN_RULES, read, catOf, names, save, promptTask };
