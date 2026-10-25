'use strict';
// 信息架构评分：不调用模型，按现在的需求树、项目文件和改动记录算。体检报告、命令行 reqtree health、实测脚本共用。
// 设计见 docs/design-info-architecture.md 第十节。分数只是把几个数字合在一起、方便前后比较，每项的原始数字都列出来。
//   送得到：有规则却永远不会加载的（自己和上级都没有文件对应）
//   不过载：自己挂了 MANY_RULES 条以上规则的需求（该往下拆）
//   根精简：根上的规则改任何文件都会送到，越少越好
//   上下文：改一个文件时需求树送到 AI 手上的字数（总目录、根、范围覆盖它的需求的规则文件；代码地图不自动加载，不算）
//   不重叠：被两个以上按内容分的顶层需求同时管的文件（两边的规则都送，多半是范围划得太宽）
//   代码归属：几乎只被另一个需求的文件用的代码文件（codemap.placement；公共模块不算）
// 还有真实使用的数字：记录员记的被撤销了多少、被你在面板上改掉删掉多少，体检自动改的被撤销了多少
const fs = require('fs');
const path = require('path');
const { parse, walk, globToRegExp, norm } = require('./parser');
const { isRoot } = require('./common');

const TEXT_RE = /\.(gd|tscn|tres|js|mjs|cjs|jsx|ts|tsx|py|cs|go|rs|java|kt|swift|rb|php|c|cc|cpp|h|hpp|lua|html?|vue|svelte|css|scss|md|json|ya?ml|toml|txt|sh|ps1)$/i;
const MAX_SAMPLE = 4000;
const USAGE_DAYS = 30;
// 上下文：这么多字以内满分，到 CTX_ZERO 字为 0 分（总目录本身约 1500 字）
const CTX_FULL = 4000, CTX_ZERO = 16000;
// 根：这么多条以内满分，到 ROOT_ZERO 条为 0 分
const ROOT_FULL = 10, ROOT_ZERO = 50;
const chars = s => [...String(s || '')].length;
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const linear = (v, full, zero) => Math.max(0, Math.min(100, Math.round(((zero - v) / (zero - full)) * 100)));

// 改文件时会送到的东西：[{ name, paths（null 是每次都加载）, chars }]。按树现算（和编译出的一样；插件里树可能还没存盘）。
// 代码地图不自动加载（AI 想看时自己读 .reqtree/map/），不算
function loadedFiles(treePath, root) {
  const projectDir = path.dirname(treePath);
  const C = require('./compile');
  const treeName = path.basename(treePath);
  const out = [];
  for (const n of walk(root)) {
    const text = C.compileNode(n, treeName, projectDir);
    if (text) out.push({ name: `${n.id}.md`, paths: C.scopeOf(n), chars: chars(text) });
  }
  out.push({ name: '_index.md', paths: null, chars: chars(C.compileIndex(root, treeName, C.indexOpts(projectDir))) });
  return out;
}

// 真实使用的数字（最近 USAGE_DAYS 天的改动记录）
function usage(treePath) {
  const store = require('./store');
  const since = Date.now() - USAGE_DAYS * 864e5;
  const all = store.readChanges(treePath, 500).filter(e => (e.time || 0) >= since).reverse(); // 旧的在前
  const out = { days: USAGE_DAYS, recorder: 0, recorderUndone: 0, recorderRules: 0, userChanged: 0, checkup: 0, checkupUndone: 0 };
  const byRecorder = new Map(); // node|text → true
  for (const e of all) {
    const ruleOps = e.ops.filter(o => ['add_rule', 'replace_rule', 'override_rule'].includes(o.op));
    if (e.source === '记录员') {
      out.recorder++;
      if (e.undone) out.recorderUndone++;
      else for (const o of ruleOps) { out.recorderRules++; byRecorder.set(`${o.node}|${norm(o.op === 'override_rule' ? o.new : o.text)}`, true); }
    } else if (e.source === '体检') {
      out.checkup++;
      if (e.undone) out.checkupUndone++;
    } else if (e.source === '你' && !e.undone) {
      // 你在面板上删掉、改写了记录员记的规则：多半是记错了或挂错了地方
      for (const o of e.ops) {
        const k = o.op === 'remove_rule' ? `${o.node}|${norm(o.text)}` : o.op === 'replace_rule' ? `${o.node}|${norm(o.old)}` : null;
        if (k && byRecorder.delete(k)) out.userChanged++;
      }
    }
  }
  return out;
}

// 算一次。opts.files：项目文件（不给就自己列）；opts.graph：代码地图的图（codemap.build，不给就不算代码归属）
function measure(treePath, { text, files, graph } = {}) {
  const { scopeOf, autoLoads } = require('./compile');
  const { MANY_RULES } = require('./init');
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

  // 改一个文件时送到的东西
  if (!files) { try { files = require('./codemap').listFiles(projectDir, { any: true }); } catch { files = []; } }
  const { isBackup } = require('./structure');
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

  // 被两个以上按内容分的顶层需求同时管的文件
  const tops = reqs.filter(n => n.parent === top && autoLoads(n) && !scopeOf(n).every(g => g.startsWith('*')))
    .map(n => ({ id: n.id, res: [n, ...walk(n)].filter(x => x.files.length).flatMap(x => x.files.map(globToRegExp)) }));
  let matched = 0, overlap = 0;
  const pairs = new Map();
  for (const f of pool) {
    const own = tops.filter(t => t.res.some(re => re.test(f)));
    if (own.length) matched++;
    if (own.length > 1) { overlap++; const k = own.map(t => t.id).join('+'); pairs.set(k, (pairs.get(k) || 0) + 1); }
  }

  // 代码归属
  let code = null;
  if (graph) {
    const pl = require('./codemap').placement(graph, root);
    const judged = pl.filter(p => !p.shared);
    code = { judged: judged.length, shared: pl.length - judged.length, misplaced: pl.filter(p => p.misplaced).map(p => ({ file: p.file, node: p.node, to: p.misplaced, users: p.by[0][1] })) };
  }

  const parts = {
    reach: rules ? Math.round(100 * (1 - neverRules / rules)) : 100,
    size: reqs.some(n => n.rules.length) ? Math.round(100 * (1 - big.length / reqs.filter(n => n.rules.length).length)) : 100,
    root: linear(rootRules, ROOT_FULL, ROOT_ZERO),
    context: linear(stat('chars').avg, CTX_FULL, CTX_ZERO),
    overlap: matched ? Math.round(100 * (1 - overlap / matched)) : 100,
    ...(code && code.judged ? { code: Math.round(100 * (1 - code.misplaced.length / code.judged)) } : {}),
  };
  const vals = Object.values(parts);
  let use = null;
  try { use = usage(treePath); } catch {}
  return {
    score: Math.round(vals.reduce((s, v) => s + v, 0) / vals.length), parts,
    structure: { nodes: reqs.length, depth, rules, rootRules, big, neverLoaded: { nodes: never.map(n => n.id), rules: neverRules } },
    load: { files: perFile.length, rules: stat('rules'), chars: stat('chars'), always },
    overlap: { files: overlap, of: matched, share: pct(overlap, matched), top: [...pairs].sort((a, b) => b[1] - a[1]).slice(0, 5) },
    code, usage: use,
  };
}

// 写进报告的几行（zh / en 由调用方的 T 决定，这里只给数字）
function summaryLines(h, T) {
  const L = [T('h.score', h.score, Object.entries(h.parts).map(([k, v]) => `${T('h.part.' + k)} ${v}`).join(' · '))];
  const s = h.structure;
  L.push(T('h.structure', s.nodes, s.depth, s.rules, s.rootRules, s.big.length, s.neverLoaded.rules));
  L.push(T('h.load', h.load.rules.avg, h.load.rules.max, Math.round(h.load.chars.avg), h.load.chars.p90, h.load.files));
  if (h.overlap.files) L.push(T('h.overlap', h.overlap.files, h.overlap.share, h.overlap.top.map(([k, n]) => `${k} ${n}`).join('、')));
  if (h.code && h.code.misplaced.length) L.push(T('h.misplaced', h.code.misplaced.length, h.code.misplaced.slice(0, 5).map(m => `${m.file}（${m.node || '—'} → ${m.to}）`).join('、')));
  const u = h.usage;
  if (u && (u.recorder || u.checkup)) L.push(T('h.usage', u.days, u.recorderRules, u.recorderUndone, u.userChanged, u.checkup, u.checkupUndone));
  return L;
}

module.exports = { measure, usage, summaryLines, CTX_FULL, CTX_ZERO, ROOT_FULL, ROOT_ZERO };
