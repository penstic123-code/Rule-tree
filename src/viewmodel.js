'use strict';
// 把需求树整理成面板要显示的数据。不依赖 VS Code：插件、预览工具、测试共用。
const T = require('./tree');
const Docs = require('./docs');

const ACTIVE_FOR_MS = 3 * 60 * 1000;
// 「🔨 久未动」的天数：面板、命令行 check 只用这一份（界面文案从 viewData().staleDays 取）
const STALE_DAYS = 3;
// 第二层（大类）各用一种颜色，往下继承；第一层用前景色
const BRANCH = ['--blue', '--purple', '--green', '--orange', '--yellow', '--red'];

// 进行中，但很久没被 AI 改过。只看叶子：上级的 🔨 由下级撑着。
// since 是开始跟踪的时间，没有就从现在算（刚装好不误报）
function isStale(node, touched = {}, since, now = Date.now()) {
  if (node.status !== 'doing' || node.children.some(c => c.status === 'doing')) return false;
  return now - Math.max(touched[node.id] || 0, since || now) >= STALE_DAYS * 86400000;
}

// 某个节点的规则，按来源分组（本节点在前），并标出每条规则相对这个节点的作用：
// own 自己的、inherit 上级的、overrides 取代了上级的某条（规则末尾写着「（在本范围内取代 R1 的「……」）」）、overridden 被下级取代了。
// shown 是显示的文字（去掉取代说明）；text 是原文，面板改、删规则时按它找。
// cats：体检分好的规则分类（src/categories.js），每条规则带上 cat（没分过是 null），面板按它分小组显示
function ruleGroups(node, lines = {}, cats = {}) {
  const path = T.pathOf(node);
  const replaced = new Map(); // 「上级编号|规则」→ 取代它的需求
  for (const n of path) for (const r of n.rules) { const o = T.overrideOf(r.text); if (o) replaced.set(`${o.ref}|${T.norm(o.text)}`, n.id); }
  return path.slice().reverse().filter(n => n.rules.length).map(owner => ({
    self: owner === node,
    ownerId: owner.id,
    ownerTitle: owner.title,
    rules: owner.rules.map(r => {
      const o = T.overrideOf(r.text);
      const by = replaced.get(`${owner.id}|${T.norm(r.text)}`);
      let state = owner === node ? 'own' : 'inherit', ref = null;
      if (by) { state = 'overridden'; ref = by; } else if (o) { state = 'overrides'; ref = o.ref; }
      const cat = (cats[owner.id] && cats[owner.id][T.norm(r.text)]) || null;
      const shown = o ? r.text.slice(0, o.at).trim() : r.text;
      return { text: r.text, shown, line: r.line, raw: (lines[owner.file] || [])[r.line], file: owner.file, state, ref, cat };
    }),
  }));
}

// ---------- 上下文用量表 ----------
const CONTEXT_WINDOW_MS = 24 * 3600 * 1000;
const CONTEXT_SESSIONS = 5;
// 按需加载的原因：AI 碰到匹配 paths: 的文件、进了有 CLAUDE.md 的子文件夹。其余（会话开始、压缩后重载）是常驻
const ON_DEMAND = new Set(['path_glob_match', 'nested_traversal']);

// 把 context.jsonl 的记录按会话汇总：最近 24 小时、最多 5 个会话，新的在前。
// 同一个文件在一个会话里只算一次（压缩后重载、子 agent 再加载都不重复计字数），字数取最后一次；
// 只要有一次是常驻加载，就算常驻。include 进来的文件跟着它的上级算
function contextData(entries = [], now = Date.now()) {
  const sessions = new Map();
  for (const e of entries || []) {
    if (!e || !e.file || now - e.time > CONTEXT_WINDOW_MS) continue;
    const key = e.session || '';
    if (!sessions.has(key)) sessions.set(key, { session: e.session || null, start: e.time, end: e.time, agents: new Set(), files: new Map() });
    const s = sessions.get(key);
    s.start = Math.min(s.start, e.time); s.end = Math.max(s.end, e.time);
    s.agents.add(e.agent || '');
    const prev = s.files.get(e.file);
    const parent = e.reason === 'include' && e.parent ? s.files.get(e.parent) : null;
    const kind = parent ? parent.kind : ON_DEMAND.has(e.reason) ? 'demand' : 'resident';
    if (!prev) {
      s.files.set(e.file, {
        file: e.file, chars: e.chars ?? null, kind, reason: e.reason || null, source: e.source || 'other', node: e.node || null,
        trigger: e.trigger || null, loads: 1, agentSet: new Set([e.agent || '']), time: e.time,
      });
    } else {
      prev.loads++;
      prev.agentSet.add(e.agent || '');
      if (e.time >= prev.time) { prev.chars = e.chars ?? null; prev.time = e.time; }
      if (kind === 'resident' && prev.kind !== 'resident') { prev.kind = 'resident'; prev.reason = e.reason || prev.reason; }
      if (!prev.trigger && e.trigger) prev.trigger = e.trigger;
    }
  }
  const sum = (files, pred = () => true) => files.filter(pred).reduce((n, f) => n + (f.chars || 0), 0);
  return [...sessions.values()].sort((a, b) => b.end - a.end).slice(0, CONTEXT_SESSIONS).map(s => {
    const files = [...s.files.values()]
      .map(({ agentSet, ...f }) => ({ ...f, agents: agentSet.size }))
      .sort((a, b) => (a.kind === b.kind ? (b.chars || 0) - (a.chars || 0) : a.kind === 'resident' ? -1 : 1));
    return {
      session: s.session, start: s.start, end: s.end, agents: s.agents.size,
      total: sum(files), resident: sum(files, f => f.kind === 'resident'), demand: sum(files, f => f.kind === 'demand'),
      ruletree: sum(files, f => f.source === 'ruletree'),
      files,
    };
  });
}

// tree = { uri, name, files: Map 文件名 → 文本, dir, activity: [], touched: {}, since, changes, unmapped, context: [], categories: {} }
// context 是 .ruletree/context.jsonl 里的记录（store.readContext）；since 是开始跟踪的时间（.ruletree/state.json）
function fileData(tree, now = Date.now()) {
  const files = tree.files || new Map();
  const root = T.build(files);
  // 每行带上原文：「打开原文」时文件可能刚被改过，插件按原文找回正确的行
  const lines = Object.fromEntries([...files].map(([n, t]) => [n, T.splitLines(t)]));
  const active = new Map();
  for (const e of tree.activity || []) if (now - e.time < ACTIVE_FOR_MS) active.set(e.node, e);
  const touched = tree.touched || {};
  const since = tree.since;
  const conv = (n, index, parentBranch) => {
    const depth = T.pathOf(n).length;
    const branch = depth === 1 ? '--fg' : depth === 2 ? BRANCH[index % BRANCH.length] : parentBranch;
    const children = n.children.map((c, i) => conv(c, i, branch));
    return {
      // AI 最后一次改它（或它下面的需求）的文件是什么时候：面板「按最近改动」排序用
      recent: Math.max(touched[n.id] || 0, ...children.map(c => c.recent)),
      key: tree.uri + '#' + n.id,
      id: n.id, title: n.title, status: n.status,
      depth, index, line: n.line, raw: (lines[n.file] || [])[n.line], file: n.file, branch,
      active: active.get(n.id) || null,
      stale: isStale(n, touched, since, now),
      files: n.files,
      // 挂的文档（文档：），ok 是文件在不在
      docs: n.docs.map(d => ({ path: d, ok: !tree.dir || Docs.exists(tree.dir, d) })),
      // 不是根需求，却没写管哪些文件：Claude Code 每次都会加载它的规则
      global: !T.isRoot(n) && !n.files.length && n.rules.length > 0,
      ruleCount: n.rules.length,
      crumbs: T.pathOf(n).slice(0, -1).map(p => `${p.id} ${p.title}`),
      groups: ruleGroups(n, lines, tree.categories || {}),
      children,
    };
  };
  return {
    uri: tree.uri, name: tree.name,
    nodes: root.children.map((c, i) => conv(c, i, '--fg')),
    changes: tree.changes || [],
    unmapped: tree.unmapped || [],
    problems: root.problems, // 编号重复、上级不存在、文件里没有编号
    context: contextData(tree.context, now), // 上下文用量表，见 contextData
  };
}

function viewData(trees, now = Date.now()) {
  return { type: 'data', files: trees.map(t => fileData(t, now)), now, staleDays: STALE_DAYS };
}

module.exports = { viewData, contextData, isStale, STALE_DAYS, ACTIVE_FOR_MS, CONTEXT_WINDOW_MS };
