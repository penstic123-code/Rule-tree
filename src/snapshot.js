'use strict';
// 一份项目现状：面板（VS Code 或 Claude 插件）要显示的数据。只读，不依赖 VS Code，没有规则的项目不创建任何文件。
const path = require('path');
const T = require('./tree');
const store = require('./store');
const { viewData, ACTIVE_FOR_MS, CONTEXT_WINDOW_MS } = require('./viewmodel');
const { overview } = require('./layout');
const { findProjectUp, projectRel } = require('./common');

// 最近一周 AI 改过、但现在不属于任何需求的文件（面板上可以一键归到需求）
function unmappedFiles(dir, root) {
  const files = new Set(store.readActivity(dir, 7 * 86400000).filter(e => !e.rule).map(e => e.file));
  return [...files].filter(f => !T.nodeForFile(root, f)).slice(-8);
}

// 改动记录里存的说明是中文（store.describeOp，VS Code 面板和中文项目照旧用它）。
// 非中文项目的面板按 ops 用文字表重写一遍，认不出的操作就整条用存下来的
const STATUS_EN = { done: 'Done', doing: 'In progress', todo: 'To do', question: 'Open question' };
function localSummary(c, lang) {
  if (lang === 'zh' || !Array.isArray(c.ops) || !c.ops.length) return c.summary;
  const t = require('../media/strings').make(lang);
  const g = a => (a || []).join(', ');
  const lines = c.ops.map(o => {
    switch (o && o.op) {
      case 'add_rule': return t('op.add_rule', o.node, o.text);
      case 'replace_rule': return t('op.replace_rule', o.node, o.old, o.text);
      case 'remove_rule': return t('op.remove_rule', o.node, o.text);
      case 'add_node': return t('op.add_node', `${o.id} ${o.title}`);
      case 'set_files': return (o.globs || []).length ? t('op.set_files', o.node, g(o.globs)) : t('op.clear_files', o.node);
      case 'set_docs': return (o.docs || []).length ? t('op.set_docs', o.node, g(o.docs)) : t('op.clear_docs', o.node);
      case 'set_status': return t('op.set_status', o.node, o.status ? STATUS_EN[o.status] || o.status : t('op.noStatus'));
      case 'rename_node': return t('op.rename_node', o.node, o.title);
      case 'delete_node': return t('op.delete_node', o.node);
      case 'edit_file': return t('op.edit_file', o.node);
      default: return null;
    }
  });
  return lines.every(Boolean) ? lines : c.summary;
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
  const snap = { enabled: !!dir, dir, name: path.basename(dir || cwd), nodes: [], changes: [], unmapped: [], problems: [], working: null, overview: null, lang: 'en' };
  if (!dir) return snap;
  snap.lang = require('./lang').detectLang(dir, 'en');
  const tree = loadTree(dir, now);
  const view = viewData([{ ...tree, uri: dir }], now).files[0];
  Object.assign(snap, { nodes: view.nodes, changes: view.changes.map(c => ({ ...c, summary: localSummary(c, snap.lang) })), unmapped: view.unmapped, problems: view.problems });
  if (file) {
    const rel = projectRel(dir, path.resolve(cwd, file));
    const node = rel.startsWith('..') ? null : T.nodeForFile(T.build(tree.files), rel);
    snap.working = node ? node.id : null;
  }
  snap.overview = overview(snap.nodes, { working: snap.working, now });
  return snap;
}

module.exports = { loadTree, snapshot };
