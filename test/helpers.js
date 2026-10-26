'use strict';
// 测试共用：独立的沙盒（临时目录、~/.ruletree、假 claude），建项目、跑 hook、假 VS Code。
// 要在 require 任何 src 模块之前先 require 这个文件
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// 真实路径：Windows CI 上 os.tmpdir() 是 8.3 短路径，hook 记的是 realpath，两边要一致
const SANDBOX = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ruletree-sandbox-')));
process.env.TEMP = process.env.TMP = process.env.TMPDIR = SANDBOX;
process.on('exit', () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {} }); // 以前从不清，每跑一次留一个临时目录
process.env.RULETREE_HOME = path.join(SANDBOX, 'home', '.ruletree');
const ROOT = path.join(__dirname, '..');
const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
process.env.RULETREE_CLAUDE_CMD = `"${process.execPath}" "${FAKE}"`;

const store = require('../src/store');
const { convert } = require('../src/migrate');

// 写法和旧版的一整份树一样，方便在测试里一眼看清结构；建项目时拆成规则文件
const TREE = `# P 测试项目
- 段落不超过 4 行

## C2 数据科学课 🔨
> 文件：DataScience/**
- 不引原话

### C2.1 第1章 ⏳
> 文件：DataScience/ch01-*.html
- 开场用霍乱
`;

// 新项目：规则文件、文件夹（folders 里的每个路径建一个空文件）、快照。返回项目目录
function project(tree = TREE, { files = ['DataScience/ch01-cholera.html', 'DataScience/index.html'], snapshot = true } = {}) {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'proj-'));
  for (const f of files) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), ''); }
  fs.mkdirSync(store.rulesDir(dir), { recursive: true });
  for (const [n, t] of convert(tree).files) fs.writeFileSync(path.join(store.rulesDir(dir), n), t);
  if (snapshot) store.syncFiles(dir, null, '其他');
  return dir;
}
const ruleFile = (dir, name) => path.join(store.rulesDir(dir), name);
const readRule = (dir, name) => fs.readFileSync(ruleFile(dir, name), 'utf8');

let session = 0;
const sid = () => `s${process.pid}-${++session}`;
function hook(dir, input, { script = path.join(ROOT, 'hooks', 'hook.js'), env = {} } = {}) {
  const res = spawnSync(process.execPath, [script], {
    input: JSON.stringify({ cwd: dir, session_id: input.session_id || sid(), ...input }),
    encoding: 'utf8', env: { ...process.env, ...env },
  });
  if (res.stderr) throw new Error(res.stderr);
  return res.stdout;
}
const edit = (dir, rel, extra = {}) => ({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dir, rel) }, ...extra });

// 假的 VS Code：够插件启动、面板收发消息、弹输入框和选择框
function fakeVscode(dirs, { input, pick, warn } = {}) {
  const shown = [], opened = [], handlers = { save: [] };
  const disposable = { dispose() {} };
  const Uri = { file: p => ({ scheme: 'file', fsPath: p, toString: () => 'file:///' + p.replace(/\\/g, '/') }), joinPath: (u, ...s) => Uri.file(path.join(u.fsPath, ...s)) };
  let panel = null;
  const config = {};
  const vscode = {
    Uri,
    Range: class { constructor(...a) { this.a = a; } },
    RelativePattern: class {},
    ThemeIcon: class {},
    ViewColumn: { Active: 1 },
    env: { language: 'zh-cn' },
    workspace: {
      workspaceFolders: [].concat(dirs).map(d => ({ uri: Uri.file(d) })),
      textDocuments: [],
      getConfiguration: () => ({ get: (k, d) => (k in config ? config[k] : d) }),
      asRelativePath: p => path.basename(p),
      createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }),
      onDidSaveTextDocument: fn => { handlers.save.push(fn); return disposable; },
      onDidChangeWorkspaceFolders: () => disposable, onDidChangeConfiguration: () => disposable,
    },
    window: {
      registerWebviewViewProvider: (id, p) => { panel = p; return disposable; },
      createWebviewPanel: () => ({ webview: { postMessage() {}, onDidReceiveMessage() {}, asWebviewUri: u => u }, onDidDispose() {}, reveal() {} }),
      showInputBox: async () => input,
      showQuickPick: async items => (pick ? pick(items) : undefined),
      showInformationMessage: async (m, ...b) => { shown.push(m); return undefined; },
      showWarningMessage: async (m, ...b) => { shown.push(m); return warn ? warn(m, b) : b.find(x => typeof x === 'string'); },
      showErrorMessage: async m => { shown.push(m); },
      showTextDocument: async (uri, opts) => { opened.push({ file: uri.fsPath, opts }); },
    },
    commands: { registerCommand: () => disposable, executeCommand: async () => {} },
  };
  return { vscode, shown, opened, config, save: doc => handlers.save.forEach(fn => fn(doc)), panel: () => panel };
}
function activateWith(fake, extra = {}) {
  const Module = require('module');
  const load = Module._load;
  Module._load = function (req, ...rest) { return req === 'vscode' ? fake.vscode : load.call(this, req, ...rest); };
  try {
    delete require.cache[require.resolve('../extension')];
    const ext = require('../extension');
    const state = new Map();
    const context = { subscriptions: [], extensionUri: fake.vscode.Uri.file(ROOT), workspaceState: { get: k => state.get(k), update: async (k, v) => state.set(k, v) }, ...extra };
    const api = ext.activate(context);
    return { panel: fake.panel() || api.panel, api, dispose: () => context.subscriptions.forEach(d => d.dispose && d.dispose()) };
  } finally { Module._load = load; }
}

module.exports = { SANDBOX, ROOT, FAKE, TREE, project, ruleFile, readRule, hook, edit, sid, fakeVscode, activateWith };
