'use strict';
// 规则分类：只改面板的显示方式，规则文件不动。
// 体检时模型给规则多的需求（MIN_RULES 条以上）分组，比如「画风」「写作」「互动」「工作流」，存在 .ruletree/categories.json：
//   { "<需求 ID>": { "<规则文字（norm 后）>": "分类名" } }
// 面板按分类显示这些需求的规则。规则后来被改写、对不上了，就显示在「其他」里，下次体检再分。
// 分类不影响规则怎么加载、怎么记，只是给人看的
const fs = require('fs');
const store = require('./store');
const { walk, findById, norm } = require('./tree');

const FILE = 'categories.json';
const MIN_RULES = 6; // 规则少于这么多条的需求不分组，一眼就能看完
const MAX_GROUPS = 8;
const MAX_NAME = 8; // 分类名最多几个字

function read(dir) {
  try {
    const v = JSON.parse(fs.readFileSync(store.metaFile(dir, FILE), 'utf8'));
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

// 模型给的分组 [{ node, groups: [{ name, rules: [规则序号] }] }] → 写进 categories.json。序号是这个需求里第几条（从 1 起）；
// 也认原文。2026-10-25：原来让模型抄原文，小猪进城记 285 条规则光输出就超过 300 秒，体检超时
// 需求要在树里、规则够多；规则文字对不上的跳过；分类名太长截掉。模型这次分了的需求整个换掉，没分的保留原来的；
// 树里已经没有的需求顺手删掉。返回分了组的需求编号
function save(dir, root, list) {
  const cats = read(dir);
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
        const k = Number.isInteger(r) ? node.rules[r - 1] && norm(node.rules[r - 1].text) : typeof r === 'string' && norm(r);
        if (k && own.has(k) && !map[k]) map[k] = name;
      }
    }
    if (!Object.keys(map).length) continue;
    cats[node.id] = map;
    done.push(node.id);
  }
  const ids = new Set([...walk(root)].map(n => n.id).filter(Boolean));
  for (const id of Object.keys(cats)) if (!ids.has(id)) delete cats[id];
  if (done.length) store.writeJson(store.metaFile(dir, FILE), cats);
  return done;
}

// 要分组的需求（规则够多），only：只要这几个（规则变了的；没分过组的也算）
const needGroups = (root, cats, only = null) => [...walk(root)].filter(n => n.id && n.rules.length >= MIN_RULES && (!only || only.has(n.id) || !(cats && cats[n.id])));

module.exports = { FILE, MIN_RULES, MAX_GROUPS, read, catOf, names, save, needGroups };
