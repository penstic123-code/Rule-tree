'use strict';
// 实测脚本（test/eval-ia.js）用的信息架构数字：不调用模型，按现在的需求树和项目文件算整理前后的样子。
// 0.20 时体检报告和 reqtree health 也有一个总分，2026-10-26 用户定：评分没必要，去掉；这里只留实测要比的原始数字。
//   结构：需求几个、几层、规则几条、根上几条、自己挂了 MANY_RULES 条以上的需求、永远送不到的规则
//   送到的：改一个文件时需求树送到 AI 手上的规则条数和字数（总目录、根、范围覆盖它的需求的规则文件）
//   重叠：被两个以上按内容分的顶层需求同时管的文件
//   代码归属：几乎只被另一个需求的文件用的代码文件（codemap.placement；公共模块不算）
const fs = require('fs');
const path = require('path');
const { parse, walk, globToRegExp } = require('../src/parser');
const { isRoot } = require('../src/common');

const TEXT_RE = /\.(gd|tscn|tres|js|mjs|cjs|jsx|ts|tsx|py|cs|go|rs|java|kt|swift|rb|php|c|cc|cpp|h|hpp|lua|html?|vue|svelte|css|scss|md|json|ya?ml|toml|txt|sh|ps1)$/i;
const MAX_SAMPLE = 4000;
const chars = s => [...String(s || '')].length;
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

// 改文件时会送到的东西：[{ name, paths（null 是每次都加载）, chars }]。代码地图不自动加载，不算
function loadedFiles(treePath, root) {
  const projectDir = path.dirname(treePath);
  const C = require('../src/compile');
  const treeName = path.basename(treePath);
  const out = [];
  for (const n of walk(root)) {
    const text = C.compileNode(n, treeName, projectDir);
    if (text) out.push({ name: `${n.id}.md`, paths: C.scopeOf(n), chars: chars(text) });
  }
  out.push({ name: '_index.md', paths: null, chars: chars(C.compileIndex(root, treeName, C.indexOpts(projectDir))) });
  return out;
}

// opts.files：项目文件（不给就自己列）；opts.graph：代码地图的图（codemap.build，不给就不算代码归属）
function measure(treePath, { text, files, graph } = {}) {
  const { scopeOf, autoLoads } = require('../src/compile');
  const { MANY_RULES } = require('../src/init');
  const projectDir = path.dirname(treePath);
  const root = parse(text != null ? text : fs.readFileSync(treePath, 'utf8'));
  const nodes = [...walk(root)].filter(n => n.id);
  const top = nodes.find(isRoot);
  const reqs = nodes.filter(n => !isRoot(n));
  const rules = nodes.reduce((s, n) => s + n.rules.length, 0);
  const rootRules = top ? top.rules.length : 0;
  const big = reqs.filter(n => n.rules.length >= MANY_RULES).map(n => ({ node: n.id, rules: n.rules.length }));
  const never = reqs.filter(n => n.rules.length && !autoLoads(n));
  const neverRules = never.reduce((s, n) => s + n.rules.length, 0);
  const depth = Math.max(0, ...reqs.map(n => n.level - (top ? top.level : 1)));

  if (!files) { try { files = require('../src/codemap').listFiles(projectDir, { any: true }); } catch { files = []; } }
  const { isBackup } = require('../src/structure');
  const pool = files.filter(f => TEXT_RE.test(f) && !/^\.(reqtree|claude|codex)\//.test(f) && !isBackup(f));
  const step = Math.max(1, Math.ceil(pool.length / MAX_SAMPLE));
  const sample = pool.filter((_, i) => i % step === 0);
  const loaded = loadedFiles(treePath, root).map(l => ({ ...l, res: l.paths ? l.paths.map(globToRegExp) : null }));
  const always = loaded.filter(l => !l.res).reduce((s, l) => s + l.chars, 0);
  const reach = reqs.filter(n => autoLoads(n)).map(n => ({ n, res: scopeOf(n).map(globToRegExp) }));
  const perFile = sample.map(f => {
    const hit = reach.filter(x => x.res.some(re => re.test(f)));
    const ruleCount = rootRules + hit.reduce((s, x) => s + x.n.rules.length, 0);
    const mine = loaded.filter(l => l.res && l.res.some(re => re.test(f)));
    return { file: f, rules: ruleCount, chars: always + mine.reduce((s, l) => s + l.chars, 0) };
  });
  const stat = key => {
    if (!perFile.length) return { avg: 0, p90: 0, max: 0, maxFile: null };
    const v = perFile.map(p => p[key]).sort((a, b) => a - b);
    const max = perFile.reduce((a, b) => (b[key] > a[key] ? b : a));
    return { avg: Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 10) / 10, p90: v[Math.floor(v.length * 0.9)], max: max[key], maxFile: max.file };
  };

  const tops = reqs.filter(n => n.parent === top && autoLoads(n) && !scopeOf(n).every(g => g.startsWith('*')))
    .map(n => ({ id: n.id, res: [n, ...walk(n)].filter(x => x.files.length).flatMap(x => x.files.map(globToRegExp)) }));
  let matched = 0, overlap = 0;
  const pairs = new Map();
  for (const f of pool) {
    const own = tops.filter(t => t.res.some(re => re.test(f)));
    if (own.length) matched++;
    if (own.length > 1) { overlap++; const k = own.map(t => t.id).join('+'); pairs.set(k, (pairs.get(k) || 0) + 1); }
  }

  let code = null;
  if (graph) {
    const pl = require('../src/codemap').placement(graph, root);
    const judged = pl.filter(p => !p.shared);
    code = { judged: judged.length, shared: pl.length - judged.length, misplaced: pl.filter(p => p.misplaced).map(p => ({ file: p.file, node: p.node, to: p.misplaced, users: p.by[0][1] })) };
  }

  return {
    structure: { nodes: reqs.length, depth, rules, rootRules, big, neverLoaded: { nodes: never.map(n => n.id), rules: neverRules } },
    load: { files: perFile.length, rules: stat('rules'), chars: stat('chars'), always },
    overlap: { files: overlap, of: matched, share: pct(overlap, matched), top: [...pairs].sort((a, b) => b[1] - a[1]).slice(0, 5) },
    code,
  };
}

module.exports = { measure };
