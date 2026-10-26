#!/usr/bin/env node
'use strict';
// 在浏览器里预览面板：用插件同一套 viewmodel 生成数据，模拟 VS Code 深色或浅色主题，输出一个独立 HTML。
// 用法：node tools/preview.js <规则文件夹 或 旧版需求树.md> <输出.html> [dark|light|hc] [选中的 ID] [AI 正在改的 ID] [宽度=340] [side|map] [zh|en]
// 页面里的 window.__posted 记录面板发给插件的消息，window.__errors 记录脚本报错，测试用。
const fs = require('fs');
const path = require('path');
const { viewData } = require('../src/viewmodel');

// 规则文件：treeFile 是规则文件夹就照读；是旧版的一整份 需求树.md 就先拆成规则文件（src/migrate.js），示例和测试的树都是这种
function readRules(treeFile) {
  if (fs.statSync(treeFile).isDirectory()) return new Map(fs.readdirSync(treeFile).filter(n => n.endsWith('.md')).map(n => [n, fs.readFileSync(path.join(treeFile, n), 'utf8')]));
  return require('../src/migrate').convert(fs.readFileSync(treeFile, 'utf8')).files;
}

// mode: 'side' 侧栏（默认）| 'map' 导图；deliver=false：不自动推数据，测试调 window.__deliver() 再推
// sinceDays：开始跟踪是几天前（默认 1 天，不会出现「久未动」；给 10 就能看到久未动的标记）
function build({ state: extraState = {}, treeFile, files, theme = 'dark', selId, activeId, width = 340, height = 900, touched = {}, mode = 'side', changes = [], unmapped = [], deliver = true, sinceDays = 1, context = [], lang = 'zh' }) {
  const uri = 'file:///tree.md';
  const now = Date.now();
  const activity = activeId ? [{ node: activeId, file: 'DataScience/ch01-cholera.html', time: now }] : [];
  const since = now - sinceDays * 86400000;
  const data = viewData([{ uri, name: treeFile ? path.basename(treeFile) : 'rules', files: files || readRules(treeFile), activity, touched, since, changes, unmapped, context: typeof context === 'function' ? context(now) : context }], now);

  // VS Code 默认 Dark Modern / Light Modern 的主要颜色
  const THEMES = {
    dark: '--vscode-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-sideBar-background:#181818;--vscode-list-hoverBackground:#2a2d2e;--vscode-list-inactiveSelectionBackground:#37373d;--vscode-focusBorder:#0078d4;--vscode-widget-border:#313131;--vscode-button-background:#0078d4;--vscode-button-foreground:#ffffff;--vscode-button-secondaryBackground:#313131;--vscode-button-secondaryForeground:#cccccc;--vscode-charts-green:#89d185;--vscode-charts-yellow:#cca700;--vscode-charts-orange:#d18616;--vscode-charts-red:#f14c4c;--vscode-charts-blue:#3794ff;--vscode-charts-purple:#b180d7;--vscode-tree-indentGuidesStroke:#585858;--vscode-menu-background:#1f1f1f;--vscode-editor-background:#1f1f1f;--vscode-widget-shadow:rgba(0,0,0,.36);--vscode-button-hoverBackground:#026ec1;--vscode-button-secondaryHoverBackground:#3c3c3c;--vscode-button-border:rgba(255,255,255,.07);',
    light: '--vscode-foreground:#3b3b3b;--vscode-descriptionForeground:#616161;--vscode-sideBar-background:#f8f8f8;--vscode-list-hoverBackground:#f2f2f2;--vscode-list-inactiveSelectionBackground:#e4e6f1;--vscode-focusBorder:#005fb8;--vscode-widget-border:#e5e5e5;--vscode-button-background:#005fb8;--vscode-button-foreground:#ffffff;--vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryForeground:#3b3b3b;--vscode-charts-green:#388a34;--vscode-charts-yellow:#bf8803;--vscode-charts-orange:#d18616;--vscode-charts-red:#e51400;--vscode-charts-blue:#1a85ff;--vscode-charts-purple:#652d90;--vscode-tree-indentGuidesStroke:#a9a9a9;--vscode-menu-background:#ffffff;--vscode-editor-background:#ffffff;--vscode-widget-shadow:rgba(0,0,0,.16);--vscode-button-hoverBackground:#0258a8;--vscode-button-secondaryHoverBackground:#cccccc;--vscode-button-border:rgba(0,0,0,.1);',
    // 高对比度（深色）：只测不糊、不崩，颜色取 VS Code 默认 High Contrast 主题
    hc: '--vscode-foreground:#ffffff;--vscode-descriptionForeground:#ffffff;--vscode-sideBar-background:#000000;--vscode-editor-background:#000000;--vscode-list-hoverBackground:transparent;--vscode-list-inactiveSelectionBackground:transparent;--vscode-focusBorder:#f38518;--vscode-contrastBorder:#6fc3df;--vscode-widget-border:#6fc3df;--vscode-button-background:#000000;--vscode-button-foreground:#ffffff;--vscode-button-border:#6fc3df;--vscode-button-secondaryBackground:#000000;--vscode-button-secondaryForeground:#ffffff;--vscode-charts-green:#89d185;--vscode-charts-yellow:#ffd700;--vscode-charts-orange:#d18616;--vscode-charts-red:#f48771;--vscode-charts-blue:#75beff;--vscode-charts-purple:#b180d7;--vscode-tree-indentGuidesStroke:#a9a9a9;--vscode-menu-background:#000000;',
  };
  const font = '--vscode-font-family:"Segoe UI","Microsoft YaHei UI",sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Consolas,monospace;';
  const media = path.join(__dirname, '..', 'media');
  // extraState：额外的 webview 状态（focus 写需求 ID，follow、inheritOpen 照原样）
  const state = { ...(selId ? { selected: uri + '#' + selId } : {}), ...extraState };
  if (state.focus && !state.focus.includes('#')) state.focus = uri + '#' + state.focus;
  const bodyClass = theme === 'hc' ? 'vscode-high-contrast' : theme === 'light' ? 'vscode-light' : 'vscode-dark';
  return `<!doctype html><html lang="${lang === 'en' ? 'en' : 'zh-CN'}"><head><meta charset="utf-8">
<style>html{${THEMES[theme]}${font}} body{width:${width}px;height:${height}px}</style>
<style>${fs.readFileSync(path.join(media, 'view.css'), 'utf8')}</style>
<style>${fs.readFileSync(path.join(media, 'detail.css'), 'utf8')}</style>
${mode === 'map' ? `<style>${fs.readFileSync(path.join(media, 'map.css'), 'utf8')}</style>` : ''}</head>
<body class="${bodyClass}" data-lang="${lang === 'en' ? 'en' : 'zh'}">${mode === 'map' ? require('../media/map-body') : '<div id="app" style="display:contents"></div>'}
<script>
  window.__posted = [];
  window.__errors = [];
  window.__state = null;
  window.addEventListener('error', e => window.__errors.push(e.message));
  window.__data = ${JSON.stringify(data)};
  window.__deliver = () => window.postMessage(window.__data, '*');
  window.acquireVsCodeApi = () => ({
    getState: () => (${JSON.stringify(state)}),
    setState(s) { window.__state = s; },
    postMessage(m) { window.__posted.push(m); if (m.type === 'ready' && ${deliver}) setTimeout(window.__deliver); },
  });
</script>
<script>${fs.readFileSync(path.join(media, 'strings.js'), 'utf8')}</script>
<script>${fs.readFileSync(path.join(media, 'detail.js'), 'utf8')}</script>
<script>${fs.readFileSync(path.join(media, mode === 'map' ? 'map.js' : 'view.js'), 'utf8')}</script></body></html>`;
}

if (require.main === module) {
  const [treeFile, out, theme, selId, activeId, width, mode, lang] = process.argv.slice(2);
  fs.writeFileSync(out, build({ treeFile, theme, selId, activeId, width: +width || 340, mode, lang }));
  console.log('已生成', out);
}
// 假的上下文用量记录（.ruletree/context.jsonl 的格式），给 example/需求树.md 用：两个会话，第一个有子 agent
function fakeContext(now = Date.now()) {
  const m = 60000, S1 = 'sess-a', S2 = 'sess-b';
  const r = (session, agent, ago, file, chars, reason, source, node = null, trigger = null) => ({ session, agent, file, chars, reason, source, node, trigger, parent: null, time: now - ago * m });
  return [
    r(S1, null, 42, 'CLAUDE.md', 8640, 'session_start', 'claude-md'),
    r(S1, null, 42, 'DataScience/CLAUDE.md', 1420, 'session_start', 'claude-md'),
    r(S1, null, 42, '.claude/rules/ruletree/_guide.md', 310, 'session_start', 'ruletree'),
    r(S1, null, 42, '.claude/rules/ruletree/_root.md', 860, 'session_start', 'ruletree', 'P'),
    r(S1, null, 30, '.claude/rules/ruletree/R3.md', 420, 'path_glob_match', 'ruletree', 'R3', 'DataScience/ch01-cholera.html'),
    r(S1, 'agent-1', 25, '.claude/rules/ruletree/R3.md', 420, 'path_glob_match', 'ruletree', 'R3', 'DataScience/ch01-cholera.html'),
    r(S1, 'agent-1', 24, '.claude/rules/ruletree/R1.md', 355, 'path_glob_match', 'ruletree', 'R1', 'DataScience/index.html'),
    r(S1, null, 12, '.claude/rules/style.md', 400, 'path_glob_match', 'rules', null, 'DataScience/css/style.css'),
    r(S2, null, 300, 'CLAUDE.md', 8640, 'session_start', 'claude-md'),
    r(S2, null, 300, '.claude/rules/ruletree/_root.md', 860, 'session_start', 'ruletree', 'P'),
    r(S2, null, 280, '.claude/rules/ruletree/R4.md', 210, 'path_glob_match', 'ruletree', 'R4', 'DataScience/ch02-intro.html'),
  ];
}
module.exports = { build, fakeContext };
