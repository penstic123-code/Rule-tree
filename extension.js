'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const T0 = require('./src/tree');
const store = require('./src/store');
const { samePath } = store;
const { viewData, ACTIVE_FOR_MS, CONTEXT_WINDOW_MS } = require('./src/viewmodel');
const { suggest } = require('./src/guess');
const { ensureGuide } = require('./src/guide');
const cli = require('./bin/ruletree');
const memory = require('./src/memory');
const STRINGS = require('./media/strings');

// 界面语言：设置 ruletree.language（auto / zh / en）。auto：VS Code 是中文界面就用中文；英文界面时看规则文件写的是什么语言
// （不少中文用户的 VS Code 是英文界面，规则却是中文写的，通知和面板该跟着规则走）
let treeLangCache = null;
function treeLang() {
  if (treeLangCache && Date.now() - treeLangCache.at < 60000) return treeLangCache.lang;
  let l = null;
  try {
    const p = findProjects()[0];
    if (p) {
      const s = [...store.readFiles(p).values()].join('\n').slice(0, 20000);
      const cjk = (s.match(/[一-鿿]/g) || []).length, latin = (s.match(/[A-Za-z]+/g) || []).length;
      if (s.trim()) l = cjk > latin ? 'zh' : 'en';
    }
  } catch {}
  treeLangCache = { at: Date.now(), lang: l };
  return l;
}
const setting = (k, d) => { const cfg = vscode.workspace.getConfiguration ? vscode.workspace.getConfiguration('ruletree') : null; return cfg ? cfg.get(k, d) : d; };
function lang() {
  const s = setting('language', 'auto');
  const display = vscode.env && vscode.env.language;
  if (s === 'auto' && !/^zh/i.test(display || '') && treeLang() === 'zh') return 'zh';
  return STRINGS.pick(s, display);
}
const T = (k, ...a) => STRINGS.make(lang())(k, ...a);
// 出错文字：带结构化 t（{ k, a }）的按当前语言写，没有就用 message
const errText = e => (e && e.t && e.t.k in STRINGS.zh ? T(e.t.k, ...(e.t.a || [])) : (e && e.message) || String(e));

// 设置 ruletree.memoryMode：keep（默认）不碰 Claude Code 的自动记忆；treeOnly 在项目的 .claude/settings.local.json 写 "autoMemoryEnabled": false。
// changed：用户刚在设置里改了。启动时只在 treeOnly 下关掉；默认模式下不碰（不然用户自己关掉的自动记忆每次启动都会被打开）
const memoryMode = () => (setting('memoryMode', 'keep') === 'treeOnly' ? 'treeOnly' : 'keep');
function applyMemoryMode(changed = false) {
  const off = memoryMode() === 'treeOnly';
  if (!off && !changed) return;
  for (const dir of findProjects()) {
    try { if (memory.setAutoMemory(dir, !off)) vscode.window.showInformationMessage(T(off ? 'mem.off' : 'mem.on')); }
    catch (e) { vscode.window.showWarningMessage(T('mem.fail', errText(e))); }
  }
}

const fileFolders = () => (vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme === 'file');
// 用需求树的项目：工作区文件夹里有 .claude/rules/ruletree/ 的规则文件（或者还没升级的旧 需求树.md）
const findProjects = () => fileFolders().map(f => f.uri.fsPath).filter(store.isProject);
const ruleFileOf = (dir, name) => path.join(store.rulesDir(dir), name);
// 规则文件 → 它所在的项目和文件名；不是规则文件返回 null
function ruleDoc(doc, projects) {
  if (doc.uri.scheme !== 'file') return null;
  const f = doc.uri.fsPath;
  const dir = projects.find(d => samePath(path.dirname(f), store.rulesDir(d)));
  return dir && T0.isRuleFile(path.basename(f)) ? { dir, name: path.basename(f) } : null;
}

// 面板操作没改动时告诉用户为什么，按操作区分（文字在 strings.js 的 x.nc.<op>）
const noChangeWhy = op => { const k = 'x.nc.' + op; return k in STRINGS.zh ? T(k) : T('x.noChangeAny'); };

// 最近一周 AI 改过、但现在不属于任何需求的文件（面板上可以一键归到需求）
function unmappedFiles(dir, root) {
  const files = new Set(store.readActivity(dir, 7 * 86400000).filter(e => !e.rule).map(e => e.file));
  return [...files].filter(f => !T0.nodeForFile(root, f)).slice(-8);
}

// 升级旧版：旧的 需求树.md 拆成规则文件、旧 hook 换成新的（init 一起做）。每个项目每次打开 VS Code 只试一次
const upgraded = new Set();
function upgradeIfOld(dir) {
  if (upgraded.has(dir) || !(store.legacyTree(dir) || cli.hasOldHooks(dir))) return;
  upgraded.add(dir);
  try {
    const r = cli.init(dir, { log: () => {} });
    vscode.window.showInformationMessage(r.upgraded ? T('x.upgraded', r.upgraded.count, path.relative(dir, r.upgraded.legacy)) : T('x.upgradedHooks'));
  } catch (e) { vscode.window.showWarningMessage(T('x.upgradeFail', errText(e))); }
}

class Panel {
  constructor(context) {
    this.context = context;
    this.trees = [];
    this.view = null;
  }

  load() {
    this.trees = findProjects().map(dir => {
      upgradeIfOld(dir);
      try { ensureGuide(dir); } catch (e) { console.error(e); }
      // 别的途径（命令行、git、手动在别处改）改了规则文件：补记成「其他」的改动。最近 5 秒内改的先不记：可能是 AI 刚改的，hook 马上以「AI」记
      store.syncFilesAsync(dir, null, '其他', { minAgeMs: 5000 }).catch(e => console.error(e));
      let state;
      try { state = store.ensureTracking(dir); } catch (e) { console.error(e); state = store.readState(dir); }
      const files = store.readFiles(dir);
      return {
        dir, files,
        uri: vscode.Uri.file(store.rulesDir(dir)).toString(),
        name: path.basename(dir),
        activity: store.readActivity(dir, ACTIVE_FOR_MS).filter(e => e.node),
        since: state.since, touched: state.touched,
        changes: store.changeSummaries(dir, 8),
        unmapped: unmappedFiles(dir, T0.build(files)),
        context: store.readContext(dir, CONTEXT_WINDOW_MS),
        categories: require('./src/categories').read(dir),
      };
    });
    this.push();
  }

  // 侧栏和导图收到同一份数据
  push() {
    const data = viewData(this.trees);
    if (this.view) this.view.webview.postMessage(data);
    if (this.map) this.map.webview.postMessage(data);
  }

  // 两个网页共用：只允许自己的样式和带 nonce 的脚本。分支颜色靠元素上的 style="--branch:…"，所以样式要放行 inline
  setHtml(webview, styles, scripts, body) {
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    webview.options = { enableScripts: true, localResourceRoots: [media] };
    const u = f => webview.asWebviewUri(vscode.Uri.joinPath(media, f));
    const nonce = Math.random().toString(36).slice(2);
    const lg = lang();
    webview.html = `<!doctype html><html lang="${lg === 'en' ? 'en' : 'zh-CN'}"><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
      ${styles.map(s => `<link rel="stylesheet" href="${u(s)}">`).join('')}</head>
      <body data-lang="${lg}">${body}${['strings.js', ...scripts].map(s => `<script nonce="${nonce}" src="${u(s)}"></script>`).join('')}</body></html>`;
    if (!webview.__ruletreeListening) {
      webview.__ruletreeListening = true;
      webview.onDidReceiveMessage(msg => this.handle(msg).catch(e => vscode.window.showErrorMessage(T('x.error', errText(e)))));
    }
  }

  resolveWebviewView(view) {
    this.view = view;
    this.setHtml(view.webview, ...VIEW_HTML);
    view.onDidChangeVisibility(() => view.visible && this.push());
  }

  // 导图：编辑区里的大视图，可以拖出去成为独立窗口
  openMap() {
    if (this.map) { this.map.reveal(); return; }
    this.map = vscode.window.createWebviewPanel('ruletree.map', T('x.mapTitle'), vscode.ViewColumn.Active, { retainContextWhenHidden: true });
    this.map.iconPath = new vscode.ThemeIcon('type-hierarchy');
    this.setHtml(this.map.webview, ...MAP_HTML);
    this.map.onDidDispose(() => { this.map = null; });
  }

  relang() {
    if (this.view) this.setHtml(this.view.webview, ...VIEW_HTML);
    if (this.map) { this.map.title = T('x.mapTitle'); this.setHtml(this.map.webview, ...MAP_HTML); }
  }

  treeOf(uri) { return this.trees.find(t => t.uri === uri); }

  async pickProject() {
    const dirs = findProjects();
    if (!dirs.length) { vscode.window.showWarningMessage(T('x.openFolder')); return null; }
    if (dirs.length === 1) return dirs[0];
    const pick = await vscode.window.showQuickPick(dirs.map(d => ({ label: path.basename(d), description: d, d })), { placeHolder: T('x.whichProject') });
    return pick ? pick.d : null;
  }

  // 命令「需求树：体检」：程序检查 + 一次模型调用，能改的直接改（一条改动，可撤销），结果写成报告
  async checkupCommand() {
    const dir = await this.pickProject();
    if (!dir) return;
    this.checking = this.checking || new Set();
    if (this.checking.has(dir)) return; // 同一个项目的体检正在跑：不再开第二个
    this.checking.add(dir);
    let r;
    try {
      const run = () => require('./src/checkup').runCheckup(dir, { T });
      r = vscode.window.withProgress && vscode.ProgressLocation
        ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: T('q.checking') }, run)
        : await run();
    } finally { this.checking.delete(dir); }
    this.load();
    const done = T('ck.summary', r.applied.length, r.ask.length, r.notes.length);
    const show = r.error ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    Promise.resolve(show(r.error ? `${done}\n${T('ck.modelFail', errText(r.error))}` : done, T('q.report'))).then(b => {
      if (b === T('q.report')) this.reportCommand(dir);
    }, () => {});
    return r;
  }

  // 命令「需求树：查看体检报告」
  async reportCommand(dir) {
    const f = (dir ? [dir] : findProjects()).map(d => store.metaFile(d, require('./src/checkup').REPORT)).find(x => fs.existsSync(x));
    if (!f) { vscode.window.showInformationMessage(T('q.noReport')); return; }
    await vscode.window.showTextDocument(vscode.Uri.file(f));
  }

  // 面板上的编辑操作（树行和详情面板都发 edit 消息）。按需求编号定位，输入用 VS Code 自带的输入框和文件选择框。
  // 这些改动都记进改动记录，面板上可以撤销
  async edit(dir, msg) {
    const root = store.readTree(dir);
    const node = msg.node && T0.findById(root, msg.node);
    const ask = (prompt, value = '') => vscode.window.showInputBox({ prompt, value, ignoreFocusOut: true, validateInput: v => (v.trim() ? null : T('x.notEmpty')) });
    const apply = async ops => {
      const done = await store.commitAsync(dir, ops, { source: '你' });
      if (!done.length) vscode.window.showInformationMessage(T('x.noChange', noChangeWhy(ops[0].op)));
      this.load();
      return done;
    };
    switch (msg.action) {
      case 'addChild': {
        const title = await ask(T('x.askNew', node ? node.title : T('x.top')));
        if (!title) return;
        const [added] = await apply([{ op: 'add_node', parent: msg.node, title }]);
        if (added) await this.offerFiles(dir, added.id, apply);
        return;
      }
      case 'rename': {
        if (typeof msg.title === 'string') {
          const title = msg.title.trim();
          if (node && title) await apply([{ op: 'rename_node', node: node.id, title }]);
          return;
        }
        const title = node && await ask(T('x.askRename'), node.title);
        if (title) await apply([{ op: 'rename_node', node: node.id, title }]);
        return;
      }
      case 'delete': {
        if (!node) return;
        const count = 1 + [...T0.walk(node)].length;
        const ok = await vscode.window.showWarningMessage(T('x.confirmDelete', node.title, count), { modal: true }, T('x.delete'));
        if (ok === T('x.delete')) await apply([{ op: 'delete_node', node: node.id }]);
        return;
      }
      case 'setStatus': return node && apply([{ op: 'set_status', node: node.id, status: msg.status || null }]);
      case 'addRule': {
        const text = node && await ask(T('x.askAddRule', node.title));
        if (text) await apply([{ op: 'add_rule', node: node.id, text }]);
        return;
      }
      case 'editRule': {
        const text = node && await ask(T('x.askEditRule'), msg.text);
        if (text) await apply([{ op: 'replace_rule', node: node.id, old: msg.text, text }]);
        return;
      }
      case 'deleteRule': return node && apply([{ op: 'remove_rule', node: node.id, text: msg.text }]);
      case 'overrideRule': {
        const text = node && await ask(T('x.askOverride', node.title), msg.text);
        if (text) await apply([{ op: 'override_rule', node: node.id, from: msg.from, text: msg.text, new: text }]);
        return;
      }
      case 'setFiles': {
        if (!node) return;
        const globs = await this.pickFiles(dir, node);
        if (globs) await apply([{ op: 'set_files', node: node.id, globs }]);
        return;
      }
      case 'assignFile': {
        // AI 改了还没归属的文件：选它属于哪个需求，再选只要这个文件还是整个文件夹
        const items = [...T0.walk(root)].filter(n => !T0.isRoot(n)).map(n => ({ label: `${n.id} ${n.title}`, description: n.files.join(', '), id: n.id }));
        const pick = await vscode.window.showQuickPick(items, { placeHolder: T('x.whichNode', msg.file) });
        if (!pick) return;
        const d = path.posix.dirname(msg.file);
        const scope = await vscode.window.showQuickPick([
          { label: `${d === '.' ? '' : d + '/'}**`, description: T('x.wholeFolder') },
          { label: msg.file, description: T('x.onlyFile') },
        ], { placeHolder: T('x.scopePick') });
        if (scope) await apply([{ op: 'add_files', node: pick.id, globs: [scope.label] }]);
      }
    }
  }

  // 选文件夹或文件，转成相对项目根目录的路径规则；也可以手写或清空
  async pickFiles(dir, node) {
    const how = await vscode.window.showQuickPick([
      { label: T('x.pickFiles'), id: 'pick' },
      { label: T('x.typeGlob'), description: T('x.typeGlobEg'), id: 'type' },
      ...(node.files.length ? [{ label: T('x.clear'), description: T('x.now', node.files.join(', ')), id: 'clear' }] : []),
    ], { placeHolder: T('x.filesFor', node.title) });
    if (!how) return null;
    if (how.id === 'clear') return [];
    if (how.id === 'type') {
      const v = await vscode.window.showInputBox({ prompt: T('x.globPrompt'), value: node.files.join(', ') });
      return v == null ? null : T0.splitGlobs(v);
    }
    return this.pickDialog(dir);
  }

  // 新建的需求：按名字猜文件范围（第3章 → ch03-*.html，英文词对上文件夹名），让用户一键用上。猜不到就不打扰（新需求已沿用上级的范围）
  async offerFiles(dir, id, apply) {
    const n = T0.findById(store.readTree(dir), id);
    if (!n) return;
    const up = T0.pathOf(n).slice(0, -1).reverse().find(a => a.files.length);
    let guesses = [];
    try { guesses = suggest(dir, n.title, up ? up.files : []); } catch (e) { console.error(e); }
    if (!guesses.length) return;
    const pick = await vscode.window.showQuickPick([
      ...guesses.map(g => ({ label: T('x.useGuess', g), description: T('x.guessed'), globs: [g] })),
      { label: T('x.pickFolder'), id: 'pick' },
      { label: T('x.later'), description: up ? T('x.inherit', up.title) : T('x.laterTip'), id: 'none' },
    ], { placeHolder: T('x.filesFor', n.title) });
    if (!pick || pick.id === 'none') return;
    const globs = pick.globs || await this.pickDialog(dir);
    if (globs) await apply([{ op: 'set_files', node: id, globs }]);
  }

  async pickDialog(dir) {
    const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: true, canSelectMany: true, defaultUri: vscode.Uri.file(dir), openLabel: T('x.pickThese') });
    if (!uris) return null;
    const globs = [];
    for (const u of uris) {
      const rel = path.relative(dir, u.fsPath).split(path.sep).join('/');
      if (rel.startsWith('..')) { vscode.window.showWarningMessage(T('x.outside', u.fsPath)); continue; }
      globs.push(fs.statSync(u.fsPath).isDirectory() ? (rel ? `${rel}/**` : '**') : rel);
    }
    return globs.length ? globs : null;
  }

  // 网页发来的消息。改规则的操作都走 edit（进改动记录、可撤销）；没列出的消息类型一律忽略
  async handle(msg) {
    const t = msg.uri && this.treeOf(msg.uri);
    const dir = t && t.dir;
    switch (msg.type) {
      case 'ready': return this.push();
      case 'openMap': return this.openMap();
      case 'checkup': return this.checkupCommand();
      case 'checkupReport': return this.reportCommand();
      case 'create': return create(this);
      case 'disable': return vscode.commands.executeCommand('ruletree.disable');
      case 'openDoc': {
        // 打开需求挂的文档（只开项目里的文件）；只挂了一节（路径#节名）的跳到那一节
        const Docs = require('./src/docs');
        const f = dir && Docs.resolve(dir, String(msg.doc || ''));
        if (!f || !fs.existsSync(f)) { vscode.window.showWarningMessage(T('x.docGone', String(msg.doc || ''))); return; }
        const sec = Docs.splitRef(msg.doc).section;
        const h = sec ? Docs.findSection(fs.readFileSync(f, 'utf8'), sec) : null;
        const line = h ? h.start - 1 : 0;
        await vscode.window.showTextDocument(vscode.Uri.file(f), h && vscode.Range ? { selection: new vscode.Range(line, 0, line, 0) } : undefined);
        return;
      }
      case 'open': {
        // 打开需求的规则文件。面板上的行号可能已经过时（AI 刚改过文件）：按当时那一行的原文找回来，找不到就用原行号
        if (!dir || !msg.file || !T0.isRuleFile(String(msg.file)) || /[\\/]/.test(msg.file)) return;
        const f = ruleFileOf(dir, msg.file);
        if (!fs.existsSync(f)) return;
        const lines = T0.splitLines(fs.readFileSync(f, 'utf8'));
        let line = Math.max(0, +msg.line || 0);
        if (msg.expect != null && lines[line] !== msg.expect) { const i = lines.indexOf(msg.expect); if (i >= 0) line = i; }
        await vscode.window.showTextDocument(vscode.Uri.file(f), { selection: new vscode.Range(line, 0, line, 0) });
        return;
      }
      case 'edit': return dir && this.edit(dir, msg);
      case 'undo':
        if (dir) {
          const r = await store.undoChangeAsync(dir, msg.id);
          if (!r) vscode.window.showWarningMessage(T('x.undoFail'));
          else if (r === 'partial') vscode.window.showWarningMessage(T('x.undoPartial'));
        }
        return this.load();
    }
  }
}

// 导图页面骨架；预览工具 tools/preview.js 用同一份
const MAP_BODY = require('./media/map-body');
const VIEW_HTML = [['view.css', 'detail.css'], ['detail.js', 'view.js'], '<div id="app" style="display:contents"></div>'];
const MAP_HTML = [['view.css', 'detail.css', 'map.css'], ['detail.js', 'map.js'], MAP_BODY];

// 「新建需求树」= 在这个项目启用：装 hook、按文件夹建第一批需求（或把旧的 需求树.md 拆开）、写说明书，然后打开根需求的文件
async function create(panel) {
  const folder = fileFolders()[0];
  if (!folder) { vscode.window.showWarningMessage(T('x.openFolder')); return; }
  const dir = folder.uri.fsPath;
  if (!(await enableIn(dir, panel))) return;
  const f = ruleFileOf(dir, T0.ROOT_FILE);
  if (fs.existsSync(f)) await vscode.window.showTextDocument(vscode.Uri.file(f));
}

function activate(context) {
  const panel = new Panel(context);
  let timer = null;
  let shownLang = lang();
  const checkLang = () => { treeLangCache = null; const l = lang(); if (l !== shownLang) { shownLang = l; panel.relang(); } };
  // 连续多次文件变化合并成一次刷新
  const refresh = () => { clearTimeout(timer); timer = setTimeout(() => { try { checkLang(); panel.load(); } catch (e) { console.error(e); } }, 150); };

  const watchers = fileFolders().flatMap(f => [
    vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(f, '.claude/rules/ruletree/*.md')),
    vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(f, '.ruletree/*.{json,jsonl}')),
    vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(f, '{需求树.md,*.tree.md}')),
  ]);
  for (const w of watchers) { w.onDidChange(refresh); w.onDidCreate(refresh); w.onDidDelete(refresh); }
  // 定时刷新：让「AI 正在改」过期消失，把别处改的规则文件补记下来
  const tick = setInterval(refresh, 60 * 1000);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('ruletree.panel', panel, { webviewOptions: { retainContextWhenHidden: true } }),
    ...watchers, { dispose: () => { clearInterval(tick); clearTimeout(timer); } },
    // 用户在编辑器里改了规则文件并保存：记成「你」的一条改动
    vscode.workspace.onDidSaveTextDocument(doc => {
      const r = ruleDoc(doc, findProjects());
      if (r) try { store.syncFiles(r.dir, [r.name], '你'); } catch (e) { console.error(e); }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    vscode.commands.registerCommand('ruletree.refresh', refresh),
    vscode.commands.registerCommand('ruletree.openMap', () => panel.openMap()),
    vscode.commands.registerCommand('ruletree.create', () => create(panel)),
    vscode.commands.registerCommand('ruletree.disable', () => disableCommand(context, panel)),
    vscode.commands.registerCommand('ruletree.enable', () => enableCommand(panel)),
    vscode.commands.registerCommand('ruletree.checkup', () => panel.checkupCommand()),
    vscode.commands.registerCommand('ruletree.checkupReport', () => panel.reportCommand()),
  );
  if (vscode.workspace.onDidChangeConfiguration) {
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('ruletree.language')) { panel.relang(); panel.load(); }
      else if (e.affectsConfiguration('ruletree.memoryMode')) applyMemoryMode(true);
    }));
  }
  // 插件升级后，~/.ruletree/runtime 里的 hook 程序还是旧版：换成新的（从没启用过就不建）
  try { cli.refreshRuntimeIfOlder(); } catch (e) { console.error(e); }
  panel.load();
  applyMemoryMode();
  const prompted = offerEnable(context, panel).catch(e => console.error(e));
  return { prompted, panel }; // 测试用：等提示走完
}

// ---------- 启用、停用（和命令行 init、disable 同一套逻辑） ----------

const neverKey = dir => `ruletree.neverOfferEnable:${store.pathKey(dir)}`;

async function enableIn(dir, panel) {
  try { cli.init(dir, { log: () => {} }); }
  catch (e) { vscode.window.showErrorMessage(T('x.enableFail', errText(e))); return false; }
  try { panel.load(); } catch (e) { console.error(e); }
  vscode.window.showInformationMessage(T('x.enabled'));
  return true;
}

// 工作区里没启用的项目：弹一次不挡操作的提示。「不再提示」按工作区记住；直接关掉下次还问。正在升级的旧项目不问
async function offerEnable(context, panel) {
  const state = context.workspaceState;
  const folders = fileFolders();
  for (const f of folders) {
    const dir = f.uri.fsPath;
    if (cli.enabledIn(dir) || store.legacyTree(dir) || cli.hasOldHooks(dir) || (state && state.get(neverKey(dir)))) continue;
    const where = folders.length > 1 ? (lang() === 'en' ? ` (${path.basename(dir)})` : `（${path.basename(dir)}）`) : '';
    const pick = await vscode.window.showInformationMessage(T('x.askEnable', where), T('x.enable'), T('x.never'));
    if (pick === T('x.enable')) await enableIn(dir, panel);
    else if (pick === T('x.never') && state) await state.update(neverKey(dir), true);
    return; // 一次只问一个
  }
}

// 命令「需求树：在本项目停用」：去掉 hook，规则文件留着；以后不再弹「启用？」
async function disableCommand(context, panel) {
  const folders = fileFolders().filter(f => cli.enabledIn(f.uri.fsPath));
  if (!folders.length) { vscode.window.showInformationMessage(T('x.notEnabled')); return; }
  const dir = folders[0].uri.fsPath;
  const ok = await vscode.window.showWarningMessage(T('x.askDisable', path.basename(dir)), { modal: true }, T('x.disable'));
  if (ok !== T('x.disable')) return;
  try { cli.disable(dir); } catch (e) { vscode.window.showErrorMessage(T('x.error', errText(e))); return; }
  if (context.workspaceState) await context.workspaceState.update(neverKey(dir), true);
  try { panel.load(); } catch {}
  vscode.window.showInformationMessage(T('x.disabled'));
}

async function enableCommand(panel) {
  const folders = fileFolders();
  if (!folders.length) { vscode.window.showWarningMessage(T('x.openFolder')); return; }
  let dir = folders[0].uri.fsPath;
  if (folders.length > 1) {
    const pick = await vscode.window.showQuickPick(folders.map(f => ({ label: path.basename(f.uri.fsPath), description: f.uri.fsPath, dir: f.uri.fsPath })), { placeHolder: T('x.whichProject') });
    if (!pick) return;
    dir = pick.dir;
  }
  await enableIn(dir, panel);
}

module.exports = { activate, deactivate() {} };
