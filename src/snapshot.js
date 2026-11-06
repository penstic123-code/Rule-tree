'use strict';
// 一份项目现状：面板（VS Code 或 Claude 插件）要显示的数据。只读，不依赖 VS Code，没有规则的项目不创建任何文件。
const path = require('path');
const T = require('./tree');
const store = require('./store');
const { viewData, ACTIVE_FOR_MS, CONTEXT_WINDOW_MS } = require('./viewmodel');
const { findProjectUp, projectRel } = require('./common');

// 最近一周 AI 改过、但现在不属于任何需求的文件（面板上可以一键归到需求）
function unmappedFiles(dir, root) {
  const files = new Set(store.readActivity(dir, 7 * 86400000).filter(e => !e.rule).map(e => e.file));
  return [...files].filter(f => !T.nodeForFile(root, f)).slice(-8);
}

// 项目的需求树和近期动静，viewData 的输入（插件另加 uri）
function loadTree(dir, now = Date.now()) {
  const files = store.readFiles(dir);
  const state = store.readState(dir);
  return {
    dir, files,
    name: path.basename(dir),
    activity: store.readActivity(dir, ACTIVE_FOR_MS).filter(e => e.node),
    since: state.since, touched: state.touched,
    changes: store.changeSummaries(dir, 8),
    unmapped: unmappedFiles(dir, T.build(files)),
    context: store.readContext(dir, CONTEXT_WINDOW_MS),
    categories: require('./categories').read(dir),
  };
}

// cwd 所在的项目现状；file 是正在改的文件，working 是管它的需求编号
function snapshot(cwd, { file, now = Date.now() } = {}) {
  cwd = path.resolve(cwd);
  const dir = findProjectUp(cwd);
  const snap = { enabled: !!dir, dir, name: path.basename(dir || cwd), nodes: [], changes: [], unmapped: [], problems: [], working: null, overview: null };
  if (!dir) return snap;
  const tree = loadTree(dir, now);
  const view = viewData([{ ...tree, uri: dir }], now).files[0];
  Object.assign(snap, { nodes: view.nodes, changes: view.changes, unmapped: view.unmapped, problems: view.problems });
  if (file) {
    const rel = projectRel(dir, path.resolve(cwd, file));
    const node = rel.startsWith('..') ? null : T.nodeForFile(T.build(tree.files), rel);
    snap.working = node ? node.id : null;
  }
  return snap;
}

module.exports = { loadTree, snapshot };
