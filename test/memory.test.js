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

// 体检时假模型返回的东西（体检在本进程里调用模型）
async function checkWith(tree, out, opts = {}) {
  process.env.FAKE_OUT = JSON.stringify(out);
  try { return await runCheckup(tree, opts); } finally { delete process.env.FAKE_OUT; }
}

test('体检（假模型）：记忆按分工逐份判断——有把握的直接处理（可撤销，撤销过的不再动），拿不准的问你，该留的不动', async () => {
  const { tree, mem } = project();
  fs.writeFileSync(path.join(mem, 'pics.md'), '---\nname: pics\ndescription: 配图\nmetadata:\n  type: feedback\n---\n\n每一章都要有 3 幅插图\n');
  fs.writeFileSync(path.join(mem, 'agents.md'), '---\nname: agents\nmetadata:\n  type: feedback\n---\n\nC1 课最多开 5 个 agent 并行。\n');
  fs.writeFileSync(path.join(mem, 'old.md'), '---\nname: old\nmetadata:\n  type: project\n---\n\n十二门徒课下一步做彼得关。\n');
  fs.writeFileSync(path.join(mem, 'me.md'), '---\nname: me\nmetadata:\n  type: user\n---\n\n用户是课程作者。\n');
  fs.writeFileSync(path.join(mem, 'many.md'), '---\nname: many\nmetadata:\n  type: feedback\n---\n\n每章三张图。\n');
  fs.writeFileSync(path.join(mem, 'para.md'), '---\nname: para\nmetadata:\n  type: feedback\n---\n\n段落不超过 6 行。\n');
  const r = await checkWith(tree, {
    questions: [],
    memory: [
      { file: 'talk.md', kind: 'covered', where: 'P' },
      { file: 'me.md', kind: 'covered', where: 'P' },              // 用户本人：不自动删
      { file: 'many.md', kind: 'covered', where: 'Z9' },           // 对不上需求：丢掉
      { file: 'agents.md', kind: 'move', node: 'C1', rules: ['最多开 5 个 agent 并行'], whole: true },
      { file: 'pics.md', kind: 'conflict', node: 'C1', rule: '每章配三张图', text: '每章配 3 幅插图', newer: 'memory', whole: true },
      { file: 'para.md', kind: 'conflict', node: 'P', rule: '段落不超过 4 行', text: '段落不超过 6 行', newer: 'tree', sure: false, whole: true },
      { file: 'old.md', kind: 'stale', why: '那门课已经删了' },
      { file: 'style.md', kind: 'keep' },
      { file: '../escape.md', kind: 'stale' },
      { file: 'nope.md', kind: 'stale' },
    ],
  });
  assert.ifError(r.error);
  // 已经在树里的：直接删 talk.md（用户本人、对不上需求的、该留的不动）
  assert.deepStrictEqual(r.removed.map(o => o.file), ['talk.md']);
  assert.ok(!fs.existsSync(path.join(mem, 'talk.md')));
  assert.ok(!read(path.join(mem, 'MEMORY.md')).includes('talk.md'), '索引那一行也删了');
  for (const f of ['me.md', 'many.md', 'style.md']) assert.ok(fs.existsSync(path.join(mem, f)), f);
  const changeOf = f => store.readChanges(tree, 50).find(e => !e.undone && e.ops.some(o => o.file === f));
  const c = changeOf('talk.md');
  assert.strictEqual(c.source, '体检');
  assert.ok(store.undoChange(tree, c.id));
  assert.ok(fs.existsSync(path.join(mem, 'talk.md')), '撤销后放回');
  // 有把握的直接处理：搬进树、按更新的记忆改树、删过时的
  assert.strictEqual(r.auto.length, 3, r.auto.map(q => q.text).join('\n'));
  assert.match(read(tree), /## C1 课[\s\S]*- 最多开 5 个 agent 并行/);
  assert.ok(!fs.existsSync(path.join(mem, 'agents.md')), '搬进树后删掉记忆');
  assert.match(read(tree), /- 每章配 3 幅插图/);
  assert.ok(!read(tree).includes('每章配三张图'));
  assert.ok(!fs.existsSync(path.join(mem, 'old.md')));
  // 拿不准哪边新的：默认做法（按需求树，删掉记忆）先写进去，同时问你
  assert.strictEqual(r.memory.length, 1);
  const q = r.memory[0];
  assert.match(q.text, /para\.md/);
  assert.strictEqual(q.defaultApplied, true);
  assert.ok(!fs.existsSync(path.join(mem, 'para.md')));
  await Q.answerQuestion(tree, q.id, 0);
  assert.match(read(tree), /段落不超过 6 行/, '改选「按记忆」：先撤销默认做法，再按记忆改');
  // 撤销一项直接处理的：放回去，下次体检不会再删它
  assert.ok(store.undoChange(tree, changeOf('old.md').id));
  assert.ok(fs.existsSync(path.join(mem, 'old.md')));
  const again = await checkWith(tree, { questions: [], memory: [{ file: 'old.md', kind: 'stale', why: 'x' }] }, { full: true });
  assert.strictEqual(again.auto.length + again.memory.length, 0);
  assert.ok(fs.existsSync(path.join(mem, 'old.md')), '撤销过的不再动');
  // memory=false 不查记忆
  const p2 = project();
  assert.strictEqual((await runCheckup(p2.tree, { model: false, memory: false })).memory.length, 0);
});

test('体检：记忆混着别的内容（whole: false）时只往树里加，不删记忆', async () => {
  const { tree, mem } = project();
  fs.writeFileSync(path.join(mem, 'mix.md'), '---\nname: mix\n---\n\n服务器是 1.2.3.4。C1 每章开头放一个小故事。\n');
  const r = await checkWith(tree, { questions: [], memory: [{ file: 'mix.md', kind: 'move', node: 'C1', rules: ['每章开头放一个小故事'], whole: false }] });
  const q = r.auto[0];
  assert.deepStrictEqual(q.options[0].ops.map(o => o.op), ['add_rule']);
  assert.match(read(tree), /每章开头放一个小故事/);
  assert.ok(fs.existsSync(path.join(mem, 'mix.md')));
});

test('体检提示词：每份记忆整份给模型（带类型和日期），带上 CLAUDE.md；没有记忆时不提记忆', () => {
  const { buildCheckPrompt } = require('../src/checkup');
  const p = buildCheckPrompt(TREE, '### pics.md（类型 feedback，更新于 2026-10-21）\n配图', '# 规范');
  assert.match(p, /pics\.md（类型 feedback/);
  assert.match(p, /<CLAUDE\.md/);
  assert.match(p, /covered/);
  assert.ok(!/covered/.test(buildCheckPrompt(TREE, '')));
});

test('体检：有规则却永远不加载的需求报出来；AI 改过、现在文件全找不到的需求变成问题；🔨 却从没见过文件的只提醒；⏳ 的不管（不调用模型）', async () => {
  const { tree, dir } = project();
  fs.writeFileSync(tree, TREE + '\n## C2 删掉的课\n> 文件：gone/**\n- 一条规则\n\n## C3 写错路径 🔨\n> 文件：typo/**\n\n## C4 还没开始 ⏳\n> 文件：later/**\n\n## K1 组件库\n- 没有文件的规则\n');
  fs.mkdirSync(path.join(dir, 'c'));
  fs.writeFileSync(path.join(dir, 'c', 'ch01.html'), '');
  store.touch(tree, ['C2']);
  const r = await runCheckup(tree, { model: false, memory: false });
  assert.deepStrictEqual(r.noFiles, ['K1']);
  assert.deepStrictEqual(r.missing.map(m => m.node), ['C3']);
  assert.strictEqual(r.scope.length, 1);
  assert.match(r.scope[0].text, /删掉的课/);
  await Q.answerQuestion(tree, r.scope[0].id, 0);
  assert.ok(!read(tree).includes('删掉的课'));
  // 问过的不再问
  fs.writeFileSync(tree, TREE + '\n## C2 删掉的课\n> 文件：gone/**\n');
  assert.strictEqual((await runCheckup(tree, { model: false, memory: false })).scope.length, 0);
});

test('收编：AI 这一轮写进记忆的其实是项目规则，记录员把它收进树并删掉记忆；树里没写进去就不删', () => {
  const { tree, mem, dir } = project();
  fs.writeFileSync(path.join(mem, 'new.md'), '---\nname: new\n---\n\nC1 每章结尾加一道思考题。\n');
  const run = out => {
    const job = path.join(dir, `job-${Math.random()}.json`);
    fs.writeFileSync(job, JSON.stringify({ treePath: tree, touched: [], unmapped: [], turns: [{ user: '好', ai: '记下了' }], memory: [{ dir: mem, file: 'new.md' }, { dir: mem, file: 'other.md' }] }));
    const log = path.join(dir, 'fake.log');
    spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'recorder.js'), job], { encoding: 'utf8', env: { ...process.env, FAKE_OUT: JSON.stringify(out), FAKE_LOG: log } });
    return fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).pop();
  };
  // 找不到需求：规则没写进去，记忆留着
  run({ ops: [{ op: 'add_rule', node: 'Z9', text: '每章结尾加一道思考题' }, { op: 'memory_absorb', file: 'new.md' }] });
  assert.ok(fs.existsSync(path.join(mem, 'new.md')));
  // 用户只说了「好」也调用模型（因为有新笔记），提示词里带上笔记；不是这一轮的笔记不认
  const call = run({ ops: [{ op: 'add_rule', node: 'C1', text: '每章结尾加一道思考题' }, { op: 'memory_absorb', file: 'new.md' }, { op: 'memory_absorb', file: 'talk.md' }] });
  assert.match(call.input, /每章结尾加一道思考题。/);
  assert.match(call.input, /memory_absorb/);
  assert.match(read(tree), /- 每章结尾加一道思考题/);
  assert.ok(!fs.existsSync(path.join(mem, 'new.md')));
  assert.ok(fs.existsSync(path.join(mem, 'talk.md')), '不是这一轮写的不删');
  assert.match(store.readRecorderStatus(tree).message, /把 1 份记忆收进需求树/);
});

test('hook：AI 写了这个项目的记忆文件就记下来，Stop 时交给记录员；MEMORY.md 和别的项目外文件不算', () => {
  const M2 = require('../src/memory');
  const { dir, mem } = project();
  assert.deepStrictEqual(M2.noteOf(dir, path.join(mem, 'new.md')), { dir: mem, file: 'new.md' });
  assert.strictEqual(M2.noteOf(dir, path.join(mem, 'MEMORY.md')), null);
  assert.strictEqual(M2.noteOf(dir, path.join(SANDBOX, 'elsewhere.md')), null);
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

// ---------- 审查发现的问题（2026-10-23）----------

test('体检：没看全的记忆（长到要切成几段）、字面对不上的记忆，模型说已有也不自动删，改成问；用户选过留着的，下次不会被自动删', async () => {
  const { tree, mem } = project();
  fs.writeFileSync(path.join(mem, 'long.md'), '---\nname: long\n---\n\n交流用中文，回答先给结论。\n' + '这是一段很长的进度记录。'.repeat(1200) + '\n');
  fs.writeFileSync(path.join(mem, 'para.md'), '---\nname: para\n---\n\n对话里一律讲汉语，先说结论再展开。\n');
  const r = await checkWith(tree, { questions: [], memory: [{ file: 'long.md', kind: 'covered', where: 'P' }, { file: 'para.md', kind: 'covered', where: 'P' }] });
  assert.strictEqual(r.removed.length, 0);
  assert.ok(fs.existsSync(path.join(mem, 'long.md')) && fs.existsSync(path.join(mem, 'para.md')));
  assert.strictEqual(r.memory.length, 2);
  const q = r.memory.find(x => x.text.includes('para.md'));
  assert.match(q.text, /已经有了，删掉这份记忆吗/);
  assert.strictEqual(q.default, 1, "拿不准：默认留着");
  await Q.answerQuestion(tree, q.id, 1); // 留在记忆
  // 下次模型说 covered（而且字面对得上）也不删：这份记忆问过、没改过
  fs.writeFileSync(path.join(mem, 'talk2.md'), 'x');
  const again = await checkWith(tree, { questions: [], memory: [{ file: 'para.md', kind: 'covered', where: 'P' }] });
  assert.strictEqual(again.removed.length, 0);
  assert.ok(fs.existsSync(path.join(mem, 'para.md')));
});

test('体检：type 写成 "User"、带引号也算用户本人，不自动删', async () => {
  const { tree, mem } = project();
  fs.writeFileSync(path.join(mem, 'who.md'), '---\nname: who\nmetadata:\n  type: "User"\n---\n\n交流用中文，回答先给结论。\n');
  assert.strictEqual(M.readNote(mem, 'who.md').type, 'user');
  const r = await checkWith(tree, { questions: [], memory: [{ file: 'who.md', kind: 'covered', where: 'P' }] });
  assert.strictEqual(r.removed.length, 0);
  assert.ok(fs.existsSync(path.join(mem, 'who.md')));
});

test('改动里树的那部分没写进去（找不到需求），同一批的删记忆也不做；能撤销', () => {
  const { tree, mem } = project();
  const applied = store.applyChange(tree, [{ op: 'add_rule', node: 'Z9', text: '新规则' }, { op: 'memory_remove', dir: mem, file: 'talk.md', whole: true }], { source: '你' });
  assert.strictEqual(applied.length, 0);
  assert.ok(applied.skipped.some(s => s.reason === 'blocked'));
  assert.ok(fs.existsSync(path.join(mem, 'talk.md')));
  // 树里已经有（duplicate）不算没写进去
  const ok = store.applyChange(tree, [{ op: 'add_rule', node: 'P', text: '段落不超过 4 行' }, { op: 'memory_remove', dir: mem, file: 'talk.md', whole: true }], { source: '你' });
  assert.ok(ok.some(o => o.op === 'memory_remove'));
  assert.ok(!fs.existsSync(path.join(mem, 'talk.md')));
});

test('收编：用户本人、外部资源类的记忆和超过 1500 字的记忆不交给记录员，模型点名也不删', () => {
  const { tree, mem, dir } = project();
  fs.writeFileSync(path.join(mem, 'me.md'), '---\nname: me\nmetadata:\n  type: user\n---\n\nC1 每章结尾加一道思考题。\n');
  fs.writeFileSync(path.join(mem, 'big.md'), '---\nname: big\n---\n\nC1 每章结尾加一道思考题。' + '记录'.repeat(900) + '\n');
  const job = path.join(dir, 'job-x.json');
  fs.writeFileSync(job, JSON.stringify({ treePath: tree, touched: [], unmapped: [], turns: [{ user: '好', ai: '记下了' }], memory: [{ dir: mem, file: 'me.md' }, { dir: mem, file: 'big.md' }] }));
  const log = path.join(dir, 'fake.log');
  spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'recorder.js'), job], { encoding: 'utf8', env: { ...process.env, FAKE_OUT: JSON.stringify({ ops: [{ op: 'memory_absorb', file: 'me.md' }, { op: 'memory_absorb', file: 'big.md' }] }), FAKE_LOG: log } });
  assert.ok(fs.existsSync(path.join(mem, 'me.md')) && fs.existsSync(path.join(mem, 'big.md')));
  assert.ok(!fs.existsSync(log), '没有可收编的笔记、用户又只说了「好」：不调用模型');
});
