'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { parse, walk, findById, pathOf, relocate, nodeForFile, splitGlobs } = require('./src/parser');
const store = require('./src/store');
const { samePath } = store;
const { viewData, ACTIVE_FOR_MS, CONTEXT_WINDOW_MS } = require('./src/viewmodel');
const { suggest } = require('./src/guess');
const reqtree = require('./bin/reqtree');
const Q = require('./src/questions');
const { runCheckup, checkPlan } = require('./src/checkup');
const CHECK_PICK_KEY = 'reqtree.checkupParts';
const memory = require('./src/memory');
const STRINGS = require('./media/strings');

// 界面语言：设置 reqtree.language（auto / zh / en）。auto：VS Code 是中文界面就用中文；英文界面时看需求树写的是什么语言
// （不少中文用户的 VS Code 是英文界面，需求树却是中文写的，通知和面板该跟着树走）。插件的提示和网页用同一张文字表
let treeLangCache = null;
function treeLang() {
  if (treeLangCache && Date.now() - treeLangCache.at < 60000) return treeLangCache.lang;
  let l = null;
  try {
    const t = findTrees()[0];
    if (t) {
      const s = fs.readFileSync(t, 'utf8').slice(0, 20000);
      const cjk = (s.match(/[一-鿿]/g) || []).length, latin = (s.match(/[A-Za-z]+/g) || []).length;
      l = cjk > latin ? 'zh' : 'en';
    }
  } catch {}
  treeLangCache = { at: Date.now(), lang: l };
  return l;
}
function lang() {
  const cfg = vscode.workspace.getConfiguration ? vscode.workspace.getConfiguration('reqtree') : null;
  const setting = cfg ? cfg.get('language', 'auto') : 'auto';
  const display = vscode.env && vscode.env.language;
  if (setting === 'auto' && !/^zh/i.test(display || '') && treeLang() === 'zh') return 'zh';
  return STRINGS.pick(setting, display);
}
const T = (k, ...a) => STRINGS.make(lang())(k, ...a);
// 出错文字：带结构化 t（{ k, a }）的按当前语言写，没有就用 message（Node 自己的错误本来就是英文）
const errText = e => (e && e.t && e.t.k in STRINGS.zh ? T(e.t.k, ...(e.t.a || [])) : (e && e.message) || String(e));

// ---------- 拿不准就问（src/questions.js） ----------
// 设置 reqtree.askQuestions：notify 弹通知问（默认）| panel 只在侧栏图标上显示个数 | off 不问，记录员的默认做法直接算数
const askMode = () => {
  const cfg = vscode.workspace.getConfiguration ? vscode.workspace.getConfiguration('reqtree') : null;
  const v = cfg ? cfg.get('askQuestions', 'notify') : 'notify';
  return v === 'panel' || v === 'off' ? v : 'notify';
};
// 问题和选项的文字：程序生成的（久未动）带结构化 t，按界面语言显示；记录员和体检的按用户的语言写好了
const tx = (t, fallback) => (t && t.k in STRINGS.zh ? T(t.k, ...(t.a || [])) : fallback);
const qText = q => tx(q.t, q.text);
const optLabel = o => tx(o.t, o.label);
// 同时最多弹几个问题通知，其余的等前面的答完（或在「待回答的问题」里答）
const NOTIFY_MAX = 3;

// 设置 reqtree.memoryMode：dedupe（默认）留着 Claude Code 的自动记忆，体检时查和需求树重复的；
// treeOnly 在项目的 .claude/settings.local.json 写 "autoMemoryEnabled": false 关掉自动记忆（键名见官方文档 code.claude.com/docs/en/memory）
const memoryMode = () => {
  const cfg = vscode.workspace.getConfiguration ? vscode.workspace.getConfiguration('reqtree') : null;
  return cfg && cfg.get('memoryMode', 'dedupe') === 'treeOnly' ? 'treeOnly' : 'dedupe';
};
// 按设置开关每个项目的自动记忆。改了文件才提示一次（新开会话后生效）
// changed：用户刚在设置里改了 memoryMode。启动时只在 treeOnly 下关掉自动记忆；默认模式下不碰设置——
// 不然用户自己在 Claude Code 里关掉的自动记忆，每次启动都会被悄悄打开（评审发现的 bug）
function applyMemoryMode(changed = false) {
  const off = memoryMode() === 'treeOnly';
  if (!off && !changed) return;
  for (const f of (vscode.workspace.workspaceFolders || []).filter(x => x.uri.scheme === 'file')) {
    const dir = f.uri.fsPath;
    if (!store.findTree(dir)) continue;
    try { if (memory.setAutoMemory(dir, !off)) vscode.window.showInformationMessage(T(off ? 'mem.off' : 'mem.on')); }
    catch (e) { vscode.window.showWarningMessage(T('mem.fail', errText(e))); }
  }
}
const SNOOZE_KEY = 'reqtree.snoozedQuestions';

// 和 hook 用同一个规则：每个工作区文件夹根目录下的 需求树.md / *.tree.md
function findTrees() {
  return (vscode.workspace.workspaceFolders || [])
    .filter(f => f.uri.scheme === 'file')
    .map(f => store.findTree(f.uri.fsPath))
    .filter(Boolean);
}

const openDoc = p => vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && samePath(d.uri.fsPath, p));
// 树现在的内容：编辑器里有没保存的改动就以编辑器为准
const currentText = p => { const doc = openDoc(p); return doc && doc.isDirty ? doc.getText() : fs.readFileSync(p, 'utf8'); };

// 写树：编辑器里有未保存的改动时改编辑器内容并保存（保留用户的改动），否则加锁写文件。
// 插件里所有写树都走这里（store.applyChange/undoChange/flushQueue 的 write 参数也传它）。
// 加锁用异步重试，不在插件宿主里同步等锁（见 store.updateTreeAsync）
async function writeTree(treePath, update) {
  const doc = openDoc(treePath);
  if (doc && doc.isDirty) {
    const updated = update(doc.getText());
    if (updated === doc.getText()) return;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), updated);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
  } else {
    await store.updateTreeAsync(treePath, update);
  }
}

// 面板操作没改动时告诉用户为什么，按操作区分（文字在 strings.js 的 x.nc.<op>）
const noChangeWhy = op => { const k = 'x.nc.' + op; return k in STRINGS.zh ? T(k) : T('x.noChangeAny'); };

// 最近一周 AI 改过、但现在仍不属于任何需求的文件（面板上可以一键归到需求）
function unmappedFiles(treePath) {
  const root = parse(fs.readFileSync(treePath, 'utf8'));
  const files = new Set(store.readActivity(treePath, 7 * 86400000).map(e => e.file));
  return [...files].filter(f => !nodeForFile(root, f)).slice(-8);
}

class Panel {
  constructor(context) {
    this.context = context;
    this.trees = [];
    this.view = null;
    this.notified = new Set(); // 这次打开 VS Code 已经弹过通知的问题
    this.showing = 0;
    this.asking = Promise.resolve(); // 测试用：等通知走完
  }

  load() {
    this.trees = findTrees().map(p => {
      // 树一变就编译成原生规则（内容没变不会重写）。不等锁：锁被占着说明别人正在写树，它释放前会编译
      try { store.compileTree(p, { wait: false }); } catch (e) { console.error(e); }
      // 记下开始跟踪的时间，顺便把旧版本拆开存的状态文件迁移进 state.json
      let state;
      try { state = store.ensureTracking(p); } catch (e) { console.error(e); state = store.readState(p); }
      return {
        path: p,
        uri: vscode.Uri.file(p).toString(),
        name: vscode.workspace.asRelativePath(p),
        text: fs.readFileSync(p, 'utf8'),
        activity: store.readActivity(p, ACTIVE_FOR_MS).filter(e => e.node),
        config: store.readConfig(p),
        since: state.since,
        touched: state.touched,
        recorder: state.recorder,
        compile: state.compile,
        changes: store.readChanges(p, 8),
        unmapped: unmappedFiles(p),
        context: store.readContext(p, CONTEXT_WINDOW_MS),
        questions: openQuestionsOf(p),
        categories: require('./src/categories').read(p), // 体检分好的规则分类，只改面板显示
        dir: path.dirname(p), // 查挂的文档在不在
      };
    });
    this.push();
    this.handleQuestions();
  }

  // 侧栏和导图收到同一份数据
  push() {
    // askQuestions 为 off 时不问用户，面板也就当没有问题（「久未动」提示照常显示）
    const data = viewData(askMode() === 'off' ? this.trees.map(t => ({ ...t, questions: [] })) : this.trees);
    // 侧栏图标上的数字：有问题等回答时显示问题个数（设置为 off 时不显示），否则记录员出错时显示 1
    const asks = askMode() === 'off' ? 0 : this.trees.reduce((n, t) => n + (t.questions || []).length, 0);
    if (vscode.commands.executeCommand) Promise.resolve(vscode.commands.executeCommand('setContext', 'reqtree.hasQuestions', asks > 0)).catch(() => {});
    if (this.view) {
      const err = data.files.some(f => f.recorder && !f.recorder.ok);
      this.view.badge = asks ? { value: asks, tooltip: T('q.badge', asks) } : err ? { value: 1, tooltip: T('x.recorderBadge') } : undefined;
      this.view.webview.postMessage(data);
    }
    if (this.map) this.map.webview.postMessage(data);
  }

  // 两个网页共用：只允许自己的样式和带 nonce 的脚本。分支颜色靠元素上的 style="--branch:…"，所以样式要放行 inline。
  setHtml(webview, styles, scripts, body) {
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    webview.options = { enableScripts: true, localResourceRoots: [media] };
    const u = f => webview.asWebviewUri(vscode.Uri.joinPath(media, f));
    const nonce = Math.random().toString(36).slice(2);
    const lg = lang();
    webview.html = `<!doctype html><html lang="${lg === 'en' ? 'en' : 'zh-CN'}"><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
      ${styles.map(s => `<link rel="stylesheet" href="${u(s)}">`).join('')}</head>
      <body data-lang="${lg}">${body}${['strings.js', ...scripts].map(s => `<script nonce="${nonce}" src="${u(s)}"></script>`).join("")}</body></html>`;
    if (!webview.__reqtreeListening) {
      webview.__reqtreeListening = true;
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
    this.map = vscode.window.createWebviewPanel('reqtree.map', T('x.mapTitle'), vscode.ViewColumn.Active, { retainContextWhenHidden: true });
    this.map.iconPath = new vscode.ThemeIcon('type-hierarchy');
    this.setHtml(this.map.webview, ...MAP_HTML);
    this.map.onDidDispose(() => { this.map = null; });
  }

  // 改了界面语言：两个网页按新语言重新生成（网页自己记的状态还在），再推一次数据
  relang() {
    if (this.view) this.setHtml(this.view.webview, ...VIEW_HTML);
    if (this.map) { this.map.title = T('x.mapTitle'); this.setHtml(this.map.webview, ...MAP_HTML); }
  }

  treeOf(uri) { return this.trees.find(t => t.uri === uri); }

  // ---------- 拿不准就问 ----------
  snoozed() { const st = this.context.workspaceState; return (st && st.get(SNOOZE_KEY)) || []; }
  snooze(id) {
    const st = this.context.workspaceState;
    if (st) return Promise.resolve(st.update(SNOOZE_KEY, [...this.snoozed().filter(x => x !== id), id].slice(-200))).catch(() => {});
  }

  // 新出现的问题：notify 弹通知；off 时记录员的问题按默认做法算数（体检的问题是用户主动要的，留着）
  handleQuestions() {
    const mode = askMode();
    const snoozed = new Set(this.snoozed());
    let accepted = false;
    for (const t of this.trees) {
      for (const q of t.questions || []) {
        if (mode === 'off') {
          if (q.defaultApplied) try { accepted = Q.acceptDefault(t.path, q.id) || accepted; } catch (e) { console.error(e); }
          continue;
        }
        if (mode !== 'notify' || this.notified.has(q.id) || snoozed.has(q.id) || this.showing >= NOTIFY_MAX) continue;
        this.notified.add(q.id);
        const p = this.notify(t.path, q).catch(e => console.error(e));
        this.asking = Promise.all([this.asking, p]);
      }
    }
    if (accepted) this.load();
  }

  // 不挡操作的通知：问题 + 最多 3 个选项 +「以后再说」。选项多于 3 个时放 2 个，其余在「其他选项…」里
  async notify(treePath, q) {
    this.showing++;
    let pick;
    try {
      const def = q.options[q.default];
      const msg = q.defaultApplied ? T('q.notify', qText(q), optLabel(def)) : T('q.notifySuggest', qText(q), optLabel(def));
      const many = q.options.length > 3;
      const items = (many ? q.options.slice(0, 2) : q.options).map((o, i) => ({ title: optLabel(o) + (i === q.default && q.defaultApplied ? T('q.current') : ''), i }));
      if (many) items.push({ title: T('q.more'), more: true });
      items.push({ title: T('q.later'), later: true });
      pick = await vscode.window.showInformationMessage(msg, ...items);
    } finally { this.showing--; }
    // 关掉通知和「以后再说」一样：不再弹，问题留着（侧栏图标上的数字、「待回答的问题」里还能答）
    if (!pick || typeof pick !== 'object' || pick.later) return this.snooze(q.id);
    if (pick.more) return this.chooseOption(treePath, q);
    return this.answer(treePath, q, pick.i);
  }

  async answer(treePath, q, k) {
    const r = await Q.answerQuestion(treePath, q.id, k, { write: writeTree });
    if (!r.ok && r.reason !== 'busy') vscode.window.showWarningMessage(T('q.gone'));
    this.load();
    return r;
  }

  // 选择框：全部选项（标出现在用的、建议的）+「保持现在这样」
  async chooseOption(treePath, q) {
    const items = q.options.map((o, i) => ({
      label: optLabel(o), i,
      description: i === q.default ? (q.defaultApplied ? T('q.applied') : T('q.suggested')) : undefined,
    }));
    items.push({ label: T('q.keep'), description: T('q.keepTip'), keep: true });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: qText(q), ignoreFocusOut: true });
    if (!pick) return;
    if (pick.keep) { Q.dismissQuestion(treePath, q.id); this.load(); return; }
    return this.answer(treePath, q, pick.i);
  }

  // 命令「需求树：待回答的问题」
  async questionsCommand() {
    this.load();
    const all = this.trees.flatMap(t => (t.questions || []).map(q => ({ t, q })));
    if (!all.length) { vscode.window.showInformationMessage(T('q.none')); return; }
    let one = all[0];
    if (all.length > 1) {
      const pick = await vscode.window.showQuickPick(all.map(x => ({
        label: qText(x.q),
        description: `${x.q.defaultApplied ? T('q.applied') : T('q.suggested')} · ${optLabel(x.q.options[x.q.default])}`,
        detail: this.trees.length > 1 ? x.t.name : undefined, x,
      })), { placeHolder: T('q.pickQuestion') });
      if (!pick) return;
      one = pick.x;
    }
    return this.chooseOption(one.t.path, one.q);
  }

  // 命令「需求树：体检」：合并重复规则，久未动和可能冲突的规则变成问题（冲突要调用一次模型）
  async checkupCommand() {
    const trees = findTrees();
    if (!trees.length) { vscode.window.showWarningMessage(T('x.openFolder')); return; }
    let p = trees[0];
    if (trees.length > 1) {
      const pick = await vscode.window.showQuickPick(trees.map(t => ({ label: vscode.workspace.asRelativePath(t), p: t })), { placeHolder: T('q.whichTree') });
      if (!pick) return;
      p = pick.p;
    }
    // 查什么：规则、记忆、文档（含 CLAUDE.md / AGENTS.md），默认全选，记住上次的选择；「全部重查」不管上次查过没有
    const memOff = memoryMode() === 'treeOnly';
    const st = this.context.workspaceState;
    const last = (st && st.get(CHECK_PICK_KEY)) || ['rules', 'memory', 'docs'];
    const items = [
      { id: 'rules', label: T('q.pickRules'), detail: T('q.pickRulesTip') },
      ...(memOff ? [] : [{ id: 'memory', label: T('q.pickMemory'), detail: T('q.pickMemoryTip') }]),
      { id: 'docs', label: T('q.pickDocs'), detail: T('q.pickDocsTip') },
      { id: 'full', label: T('q.pickFull'), detail: T('q.pickFullTip') },
    ].map(i => ({ ...i, picked: last.includes(i.id) }));
    const chosen = await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: T('q.pickWhat'), ignoreFocusOut: true });
    if (!chosen || !chosen.some(c => c.id !== 'full')) return;
    const ids = chosen.map(c => c.id);
    if (st) st.update(CHECK_PICK_KEY, ids.filter(i => i !== 'full'));
    const parts = { rules: ids.includes('rules'), memory: ids.includes('memory'), docs: ids.includes('docs') };
    const full = ids.includes('full');
    const memory = memOff ? false : undefined;
    // 要调用好几次模型时先说一声
    let plan = null;
    try { plan = checkPlan(p, { read: currentText, parts, full, memory }); } catch {}
    if (plan && plan.calls > 1) {
      const go = await vscode.window.showInformationMessage(T('q.checkPlan', plan.notes.length, plan.docs.length, plan.calls), { modal: true }, T('q.checkGo'));
      if (go !== T('q.checkGo')) return;
    }
    const run = bar => runCheckup(p, { read: currentText, write: writeTree, memory, parts, full,
      progress: (i, n) => { if (bar && n > 1) bar.report({ message: `${i}/${n}` }); } });
    const r = vscode.window.withProgress && vscode.ProgressLocation
      ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: T('q.checking') }, run)
      : await run();
    this.load();
    const newQs = [...r.questions, ...r.stale, ...r.memory, ...(r.scope || []), ...(r.docs || [])];
    const asked = newQs.length;
    // 结果写成一份报告（通知过几秒就收起，报告随时能再打开）
    const notes = [];
    if (r.error) notes.push(T('q.checkFail', errText(r.error), r.checked.failed, r.checked.calls));
    if (r.noFiles && r.noFiles.length) notes.push(T('q.noFiles', r.noFiles));
    if (r.missing && r.missing.length) notes.push(T('q.missing', r.missing));
    if (r.docMissing && r.docMissing.length) notes.push(T('q.docMissing', r.docMissing));
    if (r.docUnlinked && r.docUnlinked.length) notes.push(T('q.docUnlinked', r.docUnlinked));
    if (r.toDoc && r.toDoc.length) notes.push(T('q.toDoc', r.toDoc));
    const auto = r.auto || [], split = r.split || [];
    const done = T('q.checkDone', r.merged.length, asked, (r.removed || []).length, (r.categorized || []).length, auto.length, split.length);
    const report = [`# ${T('q.reportTitle')}`, '', new Date().toLocaleString(), '', done, '', T('q.reportChecked', r.checked.notes, r.checked.docs, r.checked.calls, r.checked.failed), ''];
    if (asked) report.push(T('q.reportQuestions', asked), '', ...newQs.map(q => `- ${qText(q)}`), '');
    // 要你动手的在前，做完了的、只给你知道的在后
    if (notes.length) report.push(T('q.reportNotes'), '', ...notes.map(n => `- ${n}`), '');
    // 直接处理了的：问题记录写「问的事 → 按哪个做的」，删文档重复的直接写做了什么
    if (auto.length) report.push(T('q.reportAuto', auto.length), '', ...auto.map(a => `- ${qText(a)}${a.options ? ` → ${optLabel(a.options[a.default])}` : ''}`), '');
    if (split.length) report.push(T('q.reportSplit'), '', ...split.map(s => `- ${T('q.splitLine', s.title, s.id, s.node, s.globs.join(', '), s.rules)}`), '');
    if (r.merged.length) report.push(T('q.reportMerged'), '', ...r.merged.map(o => `- ${o.node}：${o.text}`), '');
    if (!asked && !notes.length && !auto.length && !split.length && !r.merged.length) report.push(T('q.reportNone'), '');
    const reportFile = store.metaFile(p, 'checkup-report.md');
    try { fs.mkdirSync(path.dirname(reportFile), { recursive: true }); fs.writeFileSync(reportFile, report.join('\n')); } catch {}
    const buttons = [T('q.report'), ...(asked ? [T('q.answer')] : [])];
    const show = r.error ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    Promise.resolve(show(r.error ? `${done}\n${notes[0]}` : done, ...buttons)).then(b => {
      if (b === T('q.report')) vscode.window.showTextDocument(vscode.Uri.file(reportFile));
      else if (b === T('q.answer')) this.questionsCommand();
    }, () => {});
    // 不弹通知的设置下，用户刚主动体检、正等着结果：直接打开问题列表
    if (asked && askMode() !== 'notify') await this.questionsCommand();
    return r;
  }

  // 命令「需求树：查看体检报告」：打开上次体检写下的报告（.reqtree/checkup-report.md）
  async reportCommand() {
    const f = findTrees().map(t => store.metaFile(t, 'checkup-report.md')).find(x => fs.existsSync(x));
    if (!f) { vscode.window.showInformationMessage(T('q.noReport')); return; }
    await vscode.window.showTextDocument(vscode.Uri.file(f));
  }

  // 面板上的编辑操作（树行和详情面板都发 edit 消息）。按需求 ID 定位（不怕文件被改过导致行号错位），
  // 输入用 VS Code 自带的输入框和文件选择框。这些改动都记进改动记录，面板上可以撤销。
  async edit(treePath, msg) {
    const root = parse(currentText(treePath));
    const node = msg.node && findById(root, msg.node);
    const ask = (prompt, value = '') => vscode.window.showInputBox({ prompt, value, ignoreFocusOut: true, validateInput: v => (v.trim() ? null : T('x.notEmpty')) });
    const apply = async ops => {
      const done = await store.applyChange(treePath, ops, { source: '你', write: writeTree });
      if (!done.length) vscode.window.showInformationMessage(T('x.noChange', noChangeWhy(ops[0].op)));
      this.load();
      return done;
    };
    switch (msg.action) {
      case 'addChild': {
        const title = await ask(T('x.askNew', node ? node.title : T('x.top')));
        if (!title) return;
        const [added] = await apply([{ op: 'add_node', parent: msg.node, title }]);
        if (added) await this.offerFiles(treePath, added.id, apply);
        return;
      }
      case 'rename': {
        // 面板里直接改名时带着新名字（msg.title）；空名字不收。没带就弹输入框
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
        const count = [...walk(node)].length;
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
        const globs = await this.pickFiles(treePath, node);
        if (globs) await apply([{ op: 'set_files', node: node.id, globs }]);
        return;
      }
      case 'assignFile': {
        // AI 改了还没归属的文件：选它属于哪个需求，再选只要这个文件还是整个文件夹
        const items = [...walk(root)].map(n => ({ label: `${n.id} ${n.title}`, description: n.files.join(', '), id: n.id }));
        const pick = await vscode.window.showQuickPick(items, { placeHolder: T('x.whichNode', msg.file) });
        if (!pick) return;
        const dir = path.posix.dirname(msg.file);
        const scope = await vscode.window.showQuickPick([
          { label: `${dir === '.' ? '' : dir + '/'}**`, description: T('x.wholeFolder') },
          { label: msg.file, description: T('x.onlyFile') },
        ], { placeHolder: T('x.scopePick') });
        if (scope) await apply([{ op: 'add_files', node: pick.id, globs: [scope.label] }]);
      }
    }
  }

  // 选文件夹或文件，转成相对项目根目录的路径规则；也可以手写或清空
  async pickFiles(treePath, node) {
    const projectDir = path.dirname(treePath);
    const how = await vscode.window.showQuickPick([
      { label: T('x.pickFiles'), id: 'pick' },
      { label: T('x.typeGlob'), description: T('x.typeGlobEg'), id: 'type' },
      ...(node.files.length ? [{ label: T('x.clear'), description: T('x.now', node.files.join(', ')), id: 'clear' }] : []),
    ], { placeHolder: T('x.filesFor', node.title) });
    if (!how) return null;
    if (how.id === 'clear') return [];
    if (how.id === 'type') {
      const v = await vscode.window.showInputBox({ prompt: T('x.globPrompt'), value: node.files.join(', ') });
      return v == null ? null : splitGlobs(v); // 花括号里的逗号不拆（{ch18,ch19}-*.html）
    }
    return this.pickDialog(projectDir);
  }

  // 新建的需求还没有文件对应：按名字猜一个（第3章 → ch03-*.html，英文词对上文件夹名），让用户一键用上。
  // 在上级的范围里猜；上级都没有文件对应就在项目顶层文件夹里猜。猜不到就不打扰（不设时沿用上级的范围）
  async offerFiles(treePath, id, apply) {
    const n = findById(parse(currentText(treePath)), id);
    if (!n || n.files.length) return;
    const scope = pathOf(n).slice(0, -1).reverse().find(a => a.files.length);
    const projectDir = path.dirname(treePath);
    let guesses = [];
    try { guesses = suggest(projectDir, n.title, scope ? scope.files : []); } catch (e) { console.error(e); }
    if (!guesses.length) return;
    const pick = await vscode.window.showQuickPick([
      ...guesses.map(g => ({ label: T('x.useGuess', g), description: T('x.guessed'), globs: [g] })),
      { label: T('x.pickFolder'), id: 'pick' },
      { label: T('x.later'), description: scope ? T('x.inherit', scope.title) : T('x.laterTip'), id: 'none' },
    ], { placeHolder: T('x.filesFor', n.title) });
    if (!pick || pick.id === 'none') return;
    const globs = pick.globs || await this.pickDialog(projectDir);
    if (globs) await apply([{ op: 'set_files', node: id, globs }]);
  }

  // 系统的文件选择框：选文件夹或文件，转成相对项目根目录的路径规则
  async pickDialog(projectDir) {
    const uris =await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: true, canSelectMany: true, defaultUri: vscode.Uri.file(projectDir), openLabel: T('x.pickThese') });
    if (!uris) return null;
    const globs = [];
    for (const u of uris) {
      const rel = path.relative(projectDir, u.fsPath).split(path.sep).join('/');
      if (rel.startsWith('..')) { vscode.window.showWarningMessage(T('x.outside', u.fsPath)); continue; }
      globs.push(fs.statSync(u.fsPath).isDirectory() ? (rel ? `${rel}/**` : '**') : rel);
    }
    return globs.length ? globs : null;
  }

  // 网页发来的消息。改树的操作都走 edit（进改动记录、可撤销）；没列出的消息类型一律忽略
  async handle(msg) {
    const t = msg.uri && this.treeOf(msg.uri);
    const p = t && t.path;
    switch (msg.type) {
      case 'ready': return this.push();
      case 'openMap': return this.openMap();
      case 'checkup': return this.checkupCommand();
      case 'checkupReport': return this.reportCommand();
      case 'create': return create(this);
      case 'disable': return vscode.commands.executeCommand('reqtree.disable');
      case 'openDoc': {
        // 打开需求挂的文档；只开项目里的文件
        // 只挂了一节（路径#节名）：打开后跳到那一节
        const Docs = require('./src/docs');
        const f = p && Docs.resolve(path.dirname(p), String(msg.doc || ''));
        if (!f || !fs.existsSync(f)) { vscode.window.showWarningMessage(T('x.docGone', String(msg.doc || ''))); return; }
        const sec = Docs.splitRef(msg.doc).section;
        const h = sec ? Docs.findSection(fs.readFileSync(f, 'utf8'), sec) : null;
        const line = h ? h.start - 1 : 0;
        await vscode.window.showTextDocument(vscode.Uri.file(f), h && vscode.Range ? { selection: new vscode.Range(line, 0, line, 0) } : undefined);
        return;
      }
      case 'open': {
        if (!p) return;
        // 面板上的行号可能已经过时（记录员刚改过文件）：按当时那一行的原文找回来，找不到就用原行号
        const l = relocate(currentText(p), msg.line, msg.expect);
        const line = l < 0 ? msg.line : l;
        await vscode.window.showTextDocument(vscode.Uri.file(p), { selection: new vscode.Range(line, 0, line, 0) });
        return;
      }
      case 'setConfig':
        // 「每轮记录 / 暂停记录员」和「记下 AI 发现的做法」（writeConfig 只认 DEFAULT_CONFIG 里的键）。只影响记录员下一次怎么做，不用重编
        // 写不进去（state.lock 一直被占）时要告诉用户，不然点了没反应、菜单还停在旧选项
        if (!p) return;
        try { store.writeConfig(p, msg.patch || {}); applyConfigEffects(p, msg.patch || {}); }
        catch (e) { vscode.window.showWarningMessage(T('x.saveFail', errText(e))); }
        this.load();
        return;
      case 'edit': return p && this.edit(p, msg);
      case 'undo':
        if (p && !(await store.undoChange(p, msg.id, { write: writeTree }))) vscode.window.showWarningMessage(T('x.undoFail'));
        return this.load();
    }
  }
}

// 导图页面骨架；预览工具 tools/preview.js 用同一份
const MAP_BODY = require('./media/map-body');
const VIEW_HTML = [['view.css', 'detail.css'], ['detail.js', 'view.js'], '<div id="app" style="display:contents"></div>'];
const MAP_HTML = [['view.css', 'detail.css', 'map.css'], ['detail.js', 'map.js'], MAP_BODY];

// 打开着的问题；顺便把标着 🔨 很久没动的需求变成问题（不调用模型，每个需求每个周期只问一次）
function openQuestionsOf(p) {
  try { Q.staleQuestions(p); } catch (e) { console.error(e); }
  try { return Q.openQuestions(p); } catch (e) { console.error(e); return []; }
}

// 改了这些要马上生效的：动手原则 → 重编总目录；代码地图 → 重建或删掉
function applyConfigEffects(treePath, patch) {
  if ('principles' in patch) try { store.compileTree(treePath, { force: true }); } catch (e) { console.error(e); }
  if ('codeMap' in patch) setTimeout(() => { try { require('./src/codemap').refresh(treePath); } catch (e) { console.error(e); } }, 0);
}

// 「新建需求树」= 在这个项目启用：装 hook、建模板、编译（只建一个模板文件的话，记录员和按需加载都不会工作）
async function create(panel) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { vscode.window.showWarningMessage(T('x.openFolder')); return; }
  if (!reqtree.hasHooks(folder.uri.fsPath)) await enableIn(folder.uri.fsPath, panel);
  const uri = vscode.Uri.joinPath(folder.uri, '需求树.md');
  try { await vscode.workspace.fs.stat(uri); } catch {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(store.TEMPLATE, 'utf8'));
  }
  await vscode.window.showTextDocument(uri);
}

function activate(context) {
  const panel = new Panel(context);
  let timer = null;
  // 连续多次文件变化合并成一次刷新
  const refresh = () => { clearTimeout(timer); timer = setTimeout(() => { try { panel.load(); } catch (e) { console.error(e); } }, 150); };
  const isTree = doc => doc.uri.scheme === 'file' && panel.trees.some(t => samePath(t.path, doc.uri.fsPath));

  const watchers = (vscode.workspace.workspaceFolders || []).flatMap(f => [
    vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(f, '{需求树.md,*.tree.md}')),
    vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(f, '.reqtree/*.{json,jsonl}')),
  ]);
  for (const w of watchers) { w.onDidChange(refresh); w.onDidCreate(refresh); w.onDidDelete(refresh); }
  // 定时刷新，让"AI 正在改"过期消失
  const tick = setInterval(refresh, 60 * 1000);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('reqtree.panel', panel, { webviewOptions: { retainContextWhenHidden: true } }),
    ...watchers, { dispose: () => { clearInterval(tick); clearTimeout(timer); } },
    // 用户有未保存改动时告诉记录员排队；保存后把排队的改动写进去
    vscode.workspace.onDidChangeTextDocument(e => { if (isTree(e.document)) store.setEditing(e.document.uri.fsPath, e.document.isDirty); }),
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (!isTree(doc)) return;
      store.setEditing(doc.uri.fsPath, false);
      Promise.resolve().then(() => store.flushQueue(doc.uri.fsPath, { write: writeTree }))
        .catch(e => vscode.window.showErrorMessage(T('x.error', errText(e))));
    }),
    vscode.workspace.onDidCloseTextDocument(doc => { if (isTree(doc)) store.setEditing(doc.uri.fsPath, false); }),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    vscode.commands.registerCommand('reqtree.refresh', refresh),
    vscode.commands.registerCommand('reqtree.openMap', () => panel.openMap()),
    vscode.commands.registerCommand('reqtree.create', () => create(panel)),
    vscode.commands.registerCommand('reqtree.disable', () => disableCommand(context, panel)),
    vscode.commands.registerCommand('reqtree.enable', () => enableCommand(panel)),
    vscode.commands.registerCommand('reqtree.questions', () => panel.questionsCommand()),
    vscode.commands.registerCommand('reqtree.checkup', () => panel.checkupCommand()),
    vscode.commands.registerCommand('reqtree.checkupReport', () => panel.reportCommand()),
  );
  // 改了 reqtree.language：界面马上换语言
  if (vscode.workspace.onDidChangeConfiguration) {
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('reqtree.language')) { panel.relang(); panel.load(); }
      else if (e.affectsConfiguration('reqtree.askQuestions')) panel.load();
      else if (e.affectsConfiguration('reqtree.memoryMode')) applyMemoryMode(true);
    }));
  }
  panel.load();
  applyMemoryMode();
  // 插件升级后，~/.reqtree/runtime 里的 hook 程序还是旧版：悄悄换成新的（从没启用过就不建）
  try { reqtree.refreshRuntimeIfOlder(); } catch (e) { console.error(e); }
  const prompted = offerEnable(context, panel).catch(e => console.error(e));
  return { prompted, panel }; // 测试用：等提示走完
}

// ---------- 一键启用：在项目里装 hook（和命令行 init 同一套逻辑） ----------

const fileFolders = () => (vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme === 'file');
const neverKey = dir => `reqtree.neverOfferEnable:${store.pathKey(dir)}`;

async function enableIn(dir, panel) {
  try { reqtree.init(dir, { log: () => {} }); }
  catch (e) { vscode.window.showErrorMessage(T('x.enableFail', errText(e))); return false; }
  try { panel.load(); } catch (e) { console.error(e); }
  vscode.window.showInformationMessage(T('x.enabled'));
  return true;
}

// 工作区里没装需求树 hook 的项目：弹一次不挡操作的提示。「不再提示」按工作区记住；直接关掉下次还问
async function offerEnable(context, panel) {
  const state = context.workspaceState;
  const folders = fileFolders();
  for (const f of folders) {
    const dir = f.uri.fsPath;
    if (reqtree.hasHooks(dir) || (state && state.get(neverKey(dir)))) continue;
    const where = folders.length > 1 ? (lang() === 'en' ? ` (${path.basename(dir)})` : `（${path.basename(dir)}）`) : '';
    const pick = await vscode.window.showInformationMessage(T('x.askEnable', where), T('x.enable'), T('x.never'));
    if (pick === T('x.enable')) await enableIn(dir, panel);
    else if (pick === T('x.never') && state) await state.update(neverKey(dir), true);
    return; // 一次只问一个
  }
}

// 命令「需求树：在本项目停用」：去掉 hook 和编译出的规则，需求树.md 留着；以后不再弹「启用？」（想用时运行「在本项目启用」）
async function disableCommand(context, panel) {
  const folders = fileFolders().filter(f => reqtree.hasHooks(f.uri.fsPath));
  if (!folders.length) { vscode.window.showInformationMessage(T('x.notEnabled')); return; }
  const dir = folders[0].uri.fsPath;
  const ok = await vscode.window.showWarningMessage(T('x.askDisable', path.basename(dir)), { modal: true }, T('x.disable'));
  if (ok !== T('x.disable')) return;
  try { reqtree.disable(dir); } catch (e) { vscode.window.showErrorMessage(T('x.error', errText(e))); return; }
  if (context.workspaceState) await context.workspaceState.update(neverKey(dir), true);
  try { panel.load(); } catch {}
  vscode.window.showInformationMessage(T('x.disabled'));
}

// 命令「需求树：在本项目启用」：多个工作区文件夹时先选一个
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
