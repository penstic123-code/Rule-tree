'use strict';
// 把需求树整理成面板要显示的数据。不依赖 VS Code：插件、预览工具、测试共用。
const { parse, effectiveRules, pathOf } = require('./parser');
const { autoLoads } = require('./compile');

const ACTIVE_FOR_MS = 3 * 60 * 1000;
// 「🔨 久未动」的天数：面板、命令行 check 只用这一份（界面文案从 viewData().staleDays 取）
const STALE_DAYS = 3;
// 第二层（大类）各用一种颜色，往下继承；第一层用前景色
const BRANCH = ['--blue', '--purple', '--green', '--orange', '--yellow', '--red'];

// 正在做，但很久没被 AI 改过。只看叶子：上级的 🔨 由下级撑着。
// since 是开始跟踪的时间，没有就从现在算（刚装好不误报）
function isStale(node, touched = {}, since, now = Date.now()) {
  if (node.status !== 'doing' || node.children.some(c => c.status === 'doing')) return false;
  return now - Math.max(touched[node.id] || 0, since || now) >= STALE_DAYS * 86400000;
}

// 某个节点的规则，按来源分组（本节点在前），并标出每条规则相对这个节点的作用
function ruleGroups(node, lines = []) {
  const winners = new Map();
  for (const r of effectiveRules(node)) if (r.key) winners.set(r.key, r);
  return pathOf(node).reverse().filter(n => n.rules.length).map(owner => ({
    self: owner === node,
    ownerId: owner.id,
    ownerTitle: owner.title,
    rules: owner.rules.map(r => {
      const w = r.key && winners.get(r.key);
      let state = owner === node ? 'own' : 'inherit', ref = null;
      if (w && w.owner !== owner) { state = 'overridden'; ref = w.owner.id; }
      else if (w && w.overrides) { state = 'overrides'; ref = w.overrides.owner.id; }
      return { key: r.key, text: r.text, line: r.line, raw: lines[r.line], state, ref };
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
      reqtree: sum(files, f => f.source === 'reqtree'),
      files,
    };
  });
}

// tree = { uri, name, text, activity: [], touched: {}, since, recorder, config, changes, unmapped, compile, context: [] }
// context 是 .reqtree/context.jsonl 里的记录（store.readContext）
// since 是开始跟踪的时间（来自 .reqtree/state.json）
function fileData(tree, now = Date.now()) {
  const root = parse(tree.text);
  // 每行带上原文：「打开原文」时文件可能刚被改过，插件按原文找回正确的行（parser.relocate）
  const lines = tree.text.split(/\r?\n/);
  const active = new Map();
  for (const e of tree.activity || []) if (now - e.time < ACTIVE_FOR_MS) active.set(e.node, e);
  const touched = tree.touched || {};
  const since = tree.since;
  const conv = (n, index, parentBranch) => {
    const depth = pathOf(n).length;
    const branch = depth === 1 ? '--fg' : depth === 2 ? BRANCH[index % BRANCH.length] : parentBranch;
    return {
      key: tree.uri + '#' + n.id,
      id: n.id, title: n.title, status: n.status,
      depth, index, line: n.line, raw: lines[n.line], branch,
      active: active.get(n.id) || null,
      stale: isStale(n, touched, since, now),
      files: n.files,
      // 有规则却不会自动加载给 AI（判断和编译用同一个函数）
      noScope: n.rules.length > 0 && !autoLoads(n),
      ruleCount: n.rules.length,
      crumbs: pathOf(n).slice(0, -1).map(p => `${p.id} ${p.title}`),
      groups: ruleGroups(n, lines),
      children: n.children.map((c, i) => conv(c, i, branch)),
    };
  };
  return {
    uri: tree.uri, name: tree.name,
    nodes: root.children.map((c, i) => conv(c, i, '--fg')),
    recorder: tree.recorder || null,
    changes: tree.changes || [],
    unmapped: tree.unmapped || [],
    config: tree.config || null, // 用户开关 { recorder: 'turn' | 'off' }
    compile: tree.compile || null, // 编译结果 { ok, message, time }
    context: contextData(tree.context, now), // 上下文用量表，见 contextData
  };
}

function viewData(trees, now = Date.now()) {
  return { type: 'data', files: trees.map(t => fileData(t, now)), now, staleDays: STALE_DAYS };
}

module.exports = { viewData, contextData, isStale, STALE_DAYS, ACTIVE_FOR_MS, CONTEXT_WINDOW_MS };
