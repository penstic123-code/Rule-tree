'use strict';
// 能写成检查的规则：AI 改完文件，hook 用正则查这次写进去的内容，可能违反就提醒 AI 一句（不拦、不改文件）。
// 光写进规则 AI 也会忘（「不留调试输出」「注释用中文」这类一行就看得出的），改完马上被点出来最管用。
// 哪些规则能查、怎么查由体检时模型给出（src/rulecheck.js 的 checks），程序核对后存进 .reqtree/checks.json：
//   规则还在树里、正则合法而且不会卡死、glob 在这个需求的范围里匹配得到文件、现在的文件里没有一半以上都「违反」（那多半是误报）。
// 规则改了、删了，对应的检查跟着失效（按 rulecheck.ruleKey 对）。要看效果、要跑程序、要靠理解的规则不做成检查。
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { parse, walk, findById, norm, globToRegExp } = require('./parser');
const { scopeOf, autoLoads } = require('./compile');
const { isRoot } = require('./common');

const FILE = 'checks.json';
const MAX_CHECKS = 10;      // 一次体检最多新做几条
const MAX_TEST_FILES = 200; // 核对时最多拿几个现有文件试
const MAX_TEST_MS = 1000;   // 试跑超过这么久的正则不要（可能回溯爆炸）
const MAX_HITS = 5;         // 一次提醒最多列几处
const clip = (s, n) => { const a = [...String(s)]; return a.length > n ? a.slice(0, n).join('') + '…' : String(s); };

function read(treePath) {
  try { const v = JSON.parse(fs.readFileSync(store.metaFile(treePath, FILE), 'utf8')); return Array.isArray(v.checks) ? v.checks : []; } catch { return []; }
}

// 需求的规则在这个文件上会不会送到（根全局）
const reaches = (node, rel) => isRoot(node) || (autoLoads(node) && scopeOf(node).some(g => globToRegExp(g).test(rel)));

// 模型给的检查 → 核对后存下。items：[{ node, rule 树里原文, glob, forbid 正则, why }]；files：项目文件；
// considered：这次让模型看过的规则（ruleKey 的集合，增量体检时），这些规则原来的检查换成这次的；null 表示看了全部。
// 返回 { saved 新存的, dropped [{ item, reason }] }
function save(treePath, text, items, { files = [], considered = null } = {}) {
  const { ruleKey } = require('./rulecheck');
  const projectDir = path.dirname(treePath);
  const root = parse(text);
  const live = new Set([...walk(root)].flatMap(n => n.rules.map(r => ruleKey(n.id, r.text))));
  const saved = [], dropped = [];
  for (const it of (Array.isArray(items) ? items : []).slice(0, MAX_CHECKS)) {
    const drop = reason => dropped.push({ item: it, reason });
    if (!it || typeof it !== 'object') continue;
    const node = typeof it.node === 'string' && findById(root, it.node.trim());
    const rule = node && typeof it.rule === 'string' && (node.rules.find(r => r.text === it.rule.trim()) || node.rules.find(r => norm(r.text) === norm(it.rule)));
    if (!rule) { drop('no-rule'); continue; }
    if (typeof it.forbid !== 'string' || !it.forbid || it.forbid.length > 200) { drop('bad-regex'); continue; }
    let re;
    try { re = new RegExp(it.forbid, 'm'); } catch { drop('bad-regex'); continue; }
    if (re.test('') || re.test(' ')) { drop('matches-empty'); continue; }
    const glob = typeof it.glob === 'string' && it.glob.trim();
    if (!glob || glob.length > 200) { drop('bad-glob'); continue; }
    const g = globToRegExp(glob);
    const targets = files.filter(f => g.test(f) && reaches(node, f));
    if (!targets.length) { drop('no-files'); continue; }
    // 拿现有文件试一遍：太慢的不要；一半以上的文件都「违反」的多半是误报（或者这条规则本来就没人照做，查了也只会刷屏）
    const t0 = Date.now();
    let tested = 0, hit = 0;
    for (const f of targets.slice(0, MAX_TEST_FILES)) {
      let body = '';
      try { body = fs.readFileSync(path.join(projectDir, f), 'utf8'); } catch { continue; }
      tested++;
      if (re.test(body)) hit++;
      if (Date.now() - t0 > MAX_TEST_MS) break;
    }
    if (Date.now() - t0 > MAX_TEST_MS) { drop('slow'); continue; }
    if (tested >= 4 && hit / tested > 0.5) { drop('too-broad'); continue; }
    saved.push({ key: ruleKey(node.id, rule.text), node: node.id, rule: rule.text, glob, forbid: it.forbid, why: typeof it.why === 'string' ? clip(it.why.replace(/[\r\n]+/g, ' '), 80) : '', hits: hit, tested });
  }
  const keep = read(treePath).filter(c => live.has(c.key) && !(considered ? considered.has(c.key) : true) && !saved.some(s => s.key === c.key));
  const all = [...keep, ...saved];
  try { store.writeJson(store.metaFile(treePath, FILE), { checks: all }); } catch {}
  return { saved, dropped, total: all.length };
}

// AI 刚往 rel 写进 added（新写的那几段文字）：查一遍，返回给 AI 的提醒（没问题返回 ''）
function run(treePath, root, rel, added) {
  if (!added) return '';
  const checks = read(treePath);
  if (!checks.length) return '';
  const { ruleKey } = require('./rulecheck');
  const lines = String(added).split(/\r?\n/);
  const hits = [];
  for (const c of checks) {
    const node = findById(root, c.node);
    if (!node || !node.rules.some(r => ruleKey(node.id, r.text) === c.key)) continue;
    if (!globToRegExp(c.glob).test(rel) || !reaches(node, rel)) continue;
    let re;
    try { re = new RegExp(c.forbid, 'm'); } catch { continue; }
    for (const l of lines) {
      if (hits.length >= MAX_HITS) break;
      if (re.test(l)) hits.push(`- ${c.node}「${clip(c.rule, 60)}」：「${clip(l.trim(), 80)}」`);
    }
  }
  if (!hits.length) return '';
  return `需求树：刚写进 ${rel} 的内容可能不符合下面的规则（程序按规则对应的写法查的，不一定准；确实不是违反就不用管）：\n${hits.join('\n')}`;
}

// 编辑工具这次写进去的文字：Edit 的 new_string、Write 的 content、MultiEdit 的每段 new_string
function addedText(toolInput) {
  const ti = toolInput || {};
  if (typeof ti.new_string === 'string') return ti.new_string;
  if (typeof ti.content === 'string') return ti.content;
  if (Array.isArray(ti.edits)) return ti.edits.map(e => (e && typeof e.new_string === 'string' ? e.new_string : '')).join('\n');
  return '';
}

// Codex 的 apply_patch：每个文件加进去的行（+ 开头的）。返回 Map<补丁里写的路径, 文字>
function patchAdded(patch) {
  const out = new Map();
  let cur = null;
  for (const l of String(patch || '').split(/\r?\n/)) {
    const m = l.match(/^\*\*\* (?:Update|Add) File: (.+)$/);
    if (m) { cur = m[1].trim(); out.set(cur, ''); continue; }
    if (/^\*\*\* /.test(l)) { cur = null; continue; }
    if (cur && l.startsWith('+')) out.set(cur, out.get(cur) + l.slice(1) + '\n');
  }
  return out;
}

module.exports = { FILE, read, save, run, addedText, patchAdded, MAX_CHECKS };
