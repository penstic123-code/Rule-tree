'use strict';
// Claude Code 自动记忆和需求树：设置 reqtree.memoryMode（dedupe / treeOnly）。记忆文件夹用沙盒里的假目录
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SANDBOX = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reqtree-sandbox-')));
process.env.TEMP = process.env.TMP = process.env.TMPDIR = SANDBOX;
process.env.REQTREE_HOME = path.join(SANDBOX, 'home', '.reqtree');
const CONFIG = path.join(SANDBOX, 'claude-config');
process.env.CLAUDE_CONFIG_DIR = CONFIG;
const ROOT = path.join(__dirname, '..');
const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
process.env.REQTREE_CLAUDE_CMD = `"${process.execPath}" "${FAKE}"`;

const store = require('../src/store');
const Q = require('../src/questions');
const M = require('../src/memory');
const { runCheckup } = require('../src/checkup');

const TREE = `# P 项目
- 交流用中文，回答先给结论
- 段落不超过 4 行

## C1 课
> 文件：c/**
- 每章配三张图
`;

// 项目 + 它的假记忆文件夹（按 Claude Code 的规则从项目路径得出文件夹名）
function project() {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'proj-'));
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '需求树.md'), TREE);
  const mem = path.join(CONFIG, 'projects', M.slugOf(dir), 'memory');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), '- [沟通](talk.md) — 交流用中文\n- [文风](style.md) — 文风平实\n');
  fs.writeFileSync(path.join(mem, 'talk.md'), '---\nname: talk\ndescription: 沟通偏好\nmetadata:\n  type: feedback\n---\n\n交流用中文，回答先给结论。\n');
  fs.writeFileSync(path.join(mem, 'style.md'), '---\nname: style\ndescription: 文风\n---\n\n- 文风要平实\n- 段落不超过 4 行\n- 少用第二人称\n');
  return { dir, tree: path.join(dir, '需求树.md'), mem };
}
const read = f => fs.readFileSync(f, 'utf8');

test('记忆文件夹：路径里不是字母数字的都换成 -（和本机 Claude Code 的命名一致），按 git 根目录找，不分大小写', () => {
  assert.strictEqual(M.slugOf('c:\\Users\\张小明\\Desktop\\Vibelearning'), 'c--Users-----Desktop-Vibelearning');
  assert.strictEqual(M.slugOf('C:\\Users\\张小明\\Desktop\\reqtree'), 'C--Users-----Desktop-reqtree');
  const { dir, mem } = project();
  fs.mkdirSync(path.join(dir, 'sub'));
  assert.strictEqual(M.memoryDir(path.join(dir, 'sub')), mem, '子目录也找 git 根的记忆');
  // 盘符大小写不同（VS Code 里启动是 c:，终端里是 C:）：文件夹名按不分大小写找
  const flipped = path.join(CONFIG, 'projects', M.slugOf(dir).replace(/^./, c => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())));
  fs.renameSync(path.dirname(mem), flipped);
  assert.strictEqual(M.memoryDir(dir), path.join(flipped, 'memory'));
  fs.renameSync(flipped, path.dirname(mem));
  // autoMemoryDirectory 设置优先
  const custom = path.join(SANDBOX, 'custom-mem');
  fs.mkdirSync(custom, { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({ autoMemoryDirectory: custom }));
  assert.strictEqual(M.memoryDir(dir), custom);
});

test('体检（不调用模型）：记忆和需求树字面重复的变成问题；删记忆里的那一句（备份、可撤销）；问过的不再问', async () => {
  const { tree, mem, dir } = project();
  const r = await runCheckup(tree, { model: false });
  const texts = r.memory.map(q => q.text);
  assert.strictEqual(r.memory.length, 2, texts.join('\n'));
  assert.ok(texts.some(t => t.includes('段落不超过 4 行') && t.includes('style.md')));
  assert.ok(texts.some(t => t.includes('交流用中文') && t.includes('talk.md')));
  const q = r.memory.find(x => x.text.includes('style.md'));
  assert.deepStrictEqual(q.options.map(o => o.label), ['删记忆里的', '删需求树里的', '都留']);
  assert.strictEqual(q.defaultApplied, false);
  // 删记忆里的：style.md 还有别的内容，只删那一行
  assert.ok((await Q.answerQuestion(tree, q.id, 0)).ok);
  assert.ok(!read(path.join(mem, 'style.md')).includes('段落不超过'));
  assert.match(read(path.join(mem, 'style.md')), /文风要平实/);
  assert.match(read(tree), /段落不超过 4 行/, '树不动');
  assert.ok(fs.readdirSync(path.join(dir, '.reqtree', 'memory-backup')).some(f => f.endsWith('style.md')), '先备份');
  const [c] = store.readChanges(tree);
  assert.match(c.summary[0], /删掉记忆 style\.md 里的「段落不超过 4 行」/);
  assert.ok(store.undoChange(tree, c.id));
  assert.match(read(path.join(mem, 'style.md')), /段落不超过 4 行/, '撤销后放回');
  // 再体检：问过的不再问
  assert.strictEqual((await runCheckup(tree, { model: false })).memory.length, 0);
});

test('删记忆里的：整个文件只有这一条就删文件，连同 MEMORY.md 的那一行；撤销都放回', async () => {
  const { tree, mem } = project();
  const r = await runCheckup(tree, { model: false });
  const q = r.memory.find(x => x.text.includes('talk.md'));
  await Q.answerQuestion(tree, q.id, 0);
  assert.ok(!fs.existsSync(path.join(mem, 'talk.md')));
  assert.ok(!read(path.join(mem, 'MEMORY.md')).includes('talk.md'));
  assert.match(read(path.join(mem, 'MEMORY.md')), /style\.md/);
  assert.ok(store.undoChange(tree, store.readChanges(tree)[0].id));
  assert.ok(fs.existsSync(path.join(mem, 'talk.md')));
  assert.strictEqual(read(path.join(mem, 'MEMORY.md')).split('\n')[0], '- [沟通](talk.md) — 交流用中文');
});

test('删需求树里的 / 都留', async () => {
  const { tree, mem } = project();
  const r = await runCheckup(tree, { model: false });
  const q1 = r.memory.find(x => x.text.includes('style.md'));
  await Q.answerQuestion(tree, q1.id, 1);
  assert.ok(!read(tree).includes('段落不超过'));
  assert.match(read(path.join(mem, 'style.md')), /段落不超过/);
  const q2 = r.memory.find(x => x.text.includes('talk.md'));
  const before = read(tree);
  await Q.answerQuestion(tree, q2.id, 2);
  assert.strictEqual(read(tree), before);
  assert.ok(fs.existsSync(path.join(mem, 'talk.md')));
});

test('体检（假模型）：换了说法的重复由模型找；对不上文件或规则的丢掉；memory=false 不查记忆', async () => {
  const { tree, mem } = project();
  fs.writeFileSync(path.join(mem, 'pics.md'), '---\nname: pics\ndescription: 配图\n---\n\n每一章都要有 3 幅插图\n');
  process.env.FAKE_OUT = JSON.stringify({
    questions: [],
    memoryDuplicates: [
      { file: 'pics.md', memory: '每一章都要有 3 幅插图', node: 'C1', rule: '每章配三张图' },
      { file: '../escape.md', memory: 'x', node: 'C1', rule: '每章配三张图' },
      { file: 'nope.md', memory: 'x', node: 'C1', rule: '每章配三张图' },
      { file: 'pics.md', memory: '每一章都要有 3 幅插图', node: 'C1', rule: '树里没有这条' },
    ],
  });
  try {
    const r = await runCheckup(tree);
    assert.ifError(r.error);
    const pics = r.memory.filter(q => q.text.includes('pics.md'));
    assert.strictEqual(pics.length, 1);
    assert.match(pics[0].text, /每章配三张图/);
    const p2 = project();
    const none = await runCheckup(p2.tree, { model: false, memory: false });
    assert.strictEqual(none.memory.length, 0);
  } finally { delete process.env.FAKE_OUT; }
  // 提示词里带上了记忆
  const { buildCheckPrompt } = require('../src/checkup');
  assert.match(buildCheckPrompt(TREE, 'pics.md：配图'), /memoryDuplicates/);
  assert.ok(!/memoryDuplicates/.test(buildCheckPrompt(TREE, '')));
});

test('treeOnly：写 "autoMemoryEnabled": false，别的设置原样保留；切回 dedupe 去掉；坏的 JSON 不碰', () => {
  const { dir } = project();
  const f = path.join(dir, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '\uFEFF' + JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [] } }));
  assert.strictEqual(M.setAutoMemory(dir, false), true);
  const s = JSON.parse(read(f));
  assert.strictEqual(s.autoMemoryEnabled, false);
  assert.deepStrictEqual(s.permissions, { allow: ['Bash(ls)'] });
  assert.deepStrictEqual(s.hooks, { Stop: [] });
  assert.strictEqual(M.setAutoMemory(dir, false), false, '已经是了');
  assert.strictEqual(M.setAutoMemory(dir, true), true);
  assert.ok(!('autoMemoryEnabled' in JSON.parse(read(f))));
  assert.deepStrictEqual(JSON.parse(read(f)).permissions, { allow: ['Bash(ls)'] });
  fs.writeFileSync(f, '{ bad json');
  assert.throws(() => M.setAutoMemory(dir, false), /不是合法的 JSON/);
  assert.strictEqual(read(f), '{ bad json');
});

test('插件：设置 memoryMode 为 treeOnly 时启动就关掉自动记忆并提示；dedupe 时去掉', () => {
  const { dir } = project();
  const f = path.join(dir, '.claude', 'settings.local.json');
  for (const [mode, want] of [['treeOnly', false], ['dedupe', undefined]]) {
    const shown = [];
    const disposable = { dispose() {} };
    const Uri = { file: p => ({ scheme: 'file', fsPath: p, toString: () => 'file:///' + p }), joinPath: (u, ...s) => Uri.file(path.join(u.fsPath, ...s)) };
    const vscode = {
      Uri, Range: class {}, RelativePattern: class {}, ThemeIcon: class {}, ViewColumn: { Active: 1 }, WorkspaceEdit: class {},
      workspace: {
        workspaceFolders: [{ uri: Uri.file(dir) }], textDocuments: [], asRelativePath: p => path.basename(p),
        createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }),
        onDidChangeTextDocument: () => disposable, onDidSaveTextDocument: () => disposable, onDidCloseTextDocument: () => disposable, onDidChangeWorkspaceFolders: () => disposable,
        getConfiguration: () => ({ get: (k, d) => (k === 'memoryMode' ? mode : d) }),
      },
      window: { registerWebviewViewProvider: () => disposable, showInformationMessage: async m => { shown.push(m); }, showWarningMessage: async m => { shown.push(m); }, showErrorMessage: m => shown.push(m) },
      commands: { registerCommand: () => disposable },
    };
    const Module = require('module');
    const load = Module._load;
    Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : load.call(this, req, ...rest); };
    let context;
    try {
      delete require.cache[require.resolve('../extension')];
      context = { subscriptions: [], extensionUri: Uri.file(ROOT), workspaceState: { get() {}, update: async () => {} } };
      require('../extension').activate(context);
    } finally { Module._load = load; }
    context.subscriptions.forEach(d => d.dispose && d.dispose());
    assert.strictEqual(JSON.parse(read(f)).autoMemoryEnabled, want, mode);
    assert.ok(shown.some(m => (want === false ? /关闭 Claude Code 的自动记忆/ : /恢复/).test(m)), shown.join('\n'));
  }
});

test('命令行：check --fix 也查记忆（--no-memory 不查）', () => {
  const { tree } = project();
  const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'reqtree.js'), ...a], { encoding: 'utf8' });
  const no = cli('check', tree, '--fix', '--no-model', '--no-memory');
  assert.strictEqual(no.status, 0, no.stderr);
  assert.ok(!/记忆/.test(no.stdout));
  const yes = cli('check', tree, '--fix', '--no-model');
  assert.match(yes.stdout, /在记忆（style\.md）和需求树（P）里各有一份/);
});
