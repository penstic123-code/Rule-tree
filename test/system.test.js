'use strict';
// 各部分串起来：hook（真的启动子进程）、命令行 init / 升级 / 停用、插件（假 VS Code）、面板数据
const H = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const store = require('../src/store');
const T = require('../src/tree');
const { guideText } = require('../src/guide');
const cli = require('../bin/ruletree');
const { viewData, contextData } = require('../src/viewmodel');
const STRINGS = require('../media/strings');

const C21 = 'C2.1-第1章.md';
const activity = dir => store.readActivity(dir, 3600000);

// ---------- hook ----------

test('hook：记下 AI 改了哪个需求（最深的那个，含子 agent），不属于任何需求的记 null；需求的最后改动时间也记下', () => {
  const dir = H.project();
  assert.strictEqual(H.hook(dir, H.edit(dir, 'DataScience/ch01-cholera.html')), '', '不往 AI 上下文里塞东西');
  H.hook(dir, H.edit(dir, 'DataScience/index.html', { agent_id: 'a1' }));
  H.hook(dir, H.edit(dir, 'README.md'));
  H.hook(dir, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'echo > DataScience/x.html' } });
  assert.deepStrictEqual(activity(dir).map(e => [e.node, e.file, e.agent]), [['C2.1', 'DataScience/ch01-cholera.html', null], ['C2', 'DataScience/index.html', 'a1'], [null, 'README.md', null]]);
  assert.ok(store.readState(dir).touched['C2.1']);
});

test('hook：AI 改了规则文件，记一条「AI」的改动（面板上能撤销），活动里记成在改这个需求', () => {
  const dir = H.project();
  fs.writeFileSync(H.ruleFile(dir, C21), H.readRule(dir, C21) + '- 每章配三张图\n');
  H.hook(dir, H.edit(dir, `.claude/rules/ruletree/${C21}`));
  const [c] = store.readChanges(dir);
  assert.strictEqual(c.source, 'AI');
  assert.deepStrictEqual(c.summary, ['给 C2.1 加规则「每章配三张图」']);
  assert.deepStrictEqual(activity(dir).map(e => [e.node, e.rule]), [['C2.1', true]]);
  H.hook(dir, H.edit(dir, `.claude/rules/ruletree/${C21}`));
  assert.strictEqual(store.readChanges(dir).length, 1, '没变就不再记');
  assert.ok(store.undoChange(dir, c.id));
  assert.doesNotMatch(H.readRule(dir, C21), /三张图/);
});

test('hook：在子文件夹里启动也找得到项目；不是用需求树的项目什么都不做', () => {
  const dir = H.project();
  H.hook(path.join(dir, 'DataScience'), H.edit(dir, 'DataScience/index.html'));
  assert.strictEqual(activity(dir).length, 1);
  const plain = fs.mkdtempSync(path.join(H.SANDBOX, 'plain-'));
  H.hook(plain, H.edit(plain, 'a.js'));
  assert.ok(!fs.existsSync(path.join(plain, '.ruletree')));
});

test('hook：InstructionsLoaded 记下加载了哪个规则文件、多少字（按字符），需求编号从文件里取；加载说明书时把旧版换新', () => {
  const dir = H.project();
  const guide = H.ruleFile(dir, '_guide.md');
  fs.writeFileSync(guide, '<!-- ruletree:guide 0 -->\n旧的说明书');
  const s = H.sid();
  H.hook(dir, { hook_event_name: 'InstructionsLoaded', session_id: s, file_path: guide, load_reason: 'session_start' });
  H.hook(dir, { hook_event_name: 'InstructionsLoaded', session_id: s, file_path: H.ruleFile(dir, C21), load_reason: 'path_glob_match', trigger_file_path: path.join(dir, 'DataScience', 'ch01-cholera.html') });
  H.hook(dir, { hook_event_name: 'InstructionsLoaded', session_id: s, file_path: path.join(dir, 'CLAUDE.md'), load_reason: 'session_start' });
  const ctx = store.readContext(dir, 3600000);
  assert.deepStrictEqual(ctx.map(e => [e.file, e.source, e.node]), [['.claude/rules/ruletree/_guide.md', 'ruletree', null], [`.claude/rules/ruletree/${C21}`, 'ruletree', 'C2.1'], ['CLAUDE.md', 'claude-md', null]]);
  assert.strictEqual(ctx[0].chars, [...'<!-- ruletree:guide 0 -->\n旧的说明书'].length);
  assert.strictEqual(ctx[1].trigger, 'DataScience/ch01-cholera.html');
  assert.strictEqual(fs.readFileSync(guide, 'utf8'), guideText());
});

test('hook：git worktree 里改的文件按 worktree 的根归到需求；worktree 里的规则文件不记改动（合并回来时再记）', () => {
  const dir = H.project();
  fs.mkdirSync(path.join(dir, '.git', 'worktrees', 'w1'), { recursive: true });
  const wt = path.join(dir, '.claude', 'worktrees', 'w1');
  fs.mkdirSync(path.join(wt, 'DataScience'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(dir, '.git', 'worktrees', 'w1')}\n`);
  fs.mkdirSync(path.join(wt, '.claude', 'rules', 'ruletree'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.claude', 'rules', 'ruletree', C21), '# C2.1 第1章\n- worktree 里的\n');
  H.hook(wt, H.edit(wt, 'DataScience/ch01-cholera.html'));
  H.hook(wt, H.edit(wt, `.claude/rules/ruletree/${C21}`));
  assert.deepStrictEqual(activity(dir).map(e => e.node), ['C2.1', 'C2.1']);
  assert.strictEqual(store.readChanges(dir).length, 0);
});

// ---------- 命令行 ----------

const settingsOf = dir => JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8'));
const runtime = () => cli.runtimeDir();

test('init：复制运行时、装两个后台 hook、忽略 .ruletree/、按文件夹建需求、写说明书；重复运行不重复装', () => {
  const dir = fs.mkdtempSync(path.join(H.SANDBOX, 'new-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), '');
  cli.init(dir, { log: () => {} });
  cli.init(dir, { log: () => {} });
  const s = settingsOf(dir);
  assert.deepStrictEqual(Object.keys(s.hooks).sort(), ['InstructionsLoaded', 'PostToolUse']);
  for (const groups of Object.values(s.hooks)) {
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].hooks[0].async, true);
    assert.ok(groups[0].hooks[0].command.includes(path.join(runtime(), 'hooks', 'hook.js').replace(/\\/g, '/').replace(/^\w:/, m => m)) || groups[0].hooks[0].command.includes(runtime()));
  }
  assert.strictEqual(s.hooks.PostToolUse[0].matcher, 'Edit|Write|MultiEdit|NotebookEdit');
  assert.ok(fs.existsSync(path.join(runtime(), 'hooks', 'hook.js')) && fs.existsSync(path.join(runtime(), 'src', 'tree.js')));
  assert.deepStrictEqual([...store.readFiles(dir).keys()], ['R1-src.md', '_root.md']);
  assert.strictEqual(fs.readFileSync(H.ruleFile(dir, '_guide.md'), 'utf8'), guideText());
  assert.strictEqual(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '.ruletree/\n');
  assert.ok(cli.enabledIn(dir));
});

test('init 升级旧版：拆开 需求树.md、去掉旧版的 hook（别人的 hook 留着，共享 settings.json 里的也去掉）', () => {
  const dir = fs.mkdtempSync(path.join(H.SANDBOX, 'old-'));
  fs.writeFileSync(path.join(dir, '需求树.md'), H.TREE);
  fs.mkdirSync(path.join(dir, '.claude'));
  const old = { type: 'command', command: 'node "C:/Users/x/.reqtree/runtime/hooks/hook.js"' };
  const mine = { type: 'command', command: 'node my-hook.js' };
  fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [old, mine] }], UserPromptSubmit: [{ hooks: [old] }] }, other: 1 }));
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreCompact: [{ hooks: [old] }] } }));
  assert.ok(cli.hasOldHooks(dir) && !cli.enabledIn(dir));
  const r = cli.init(dir, { log: () => {} });
  assert.strictEqual(r.upgraded.count, 2);
  const s = settingsOf(dir);
  assert.deepStrictEqual(s.hooks.Stop, [{ hooks: [mine] }]);
  assert.ok(!s.hooks.UserPromptSubmit && s.other === 1);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8')), {});
  assert.ok(!cli.hasOldHooks(dir) && cli.enabledIn(dir));
  assert.ok(!fs.existsSync(path.join(dir, '需求树.md')));
  assert.strictEqual(T.findById(store.readTree(dir), 'C2.1').rules[0].text, '开场用霍乱');
});

test('disable：去掉 hook，规则文件留着', () => {
  const dir = H.project();
  cli.init(dir, { log: () => {} });
  assert.deepStrictEqual(cli.disable(dir), ['.claude/settings.local.json']);
  assert.ok(!cli.enabledIn(dir));
  assert.ok(store.hasRules(dir));
});

test('hook 命令的引号：posix 用单引号（$、反引号、单引号都不会被 shell 解释），Windows 用双引号、正斜杠', () => {
  assert.strictEqual(cli.hookCommand("/home/o'neil/$x/hook.js", 'linux'), `node '/home/o'\\''neil/$x/hook.js'`);
  assert.strictEqual(cli.hookCommand('C:\\Users\\a b\\hook.js', 'win32'), 'node "C:/Users/a b/hook.js"');
  assert.ok(cli.isOurs({ command: 'node "/x/.reqtree/runtime/hooks/hook.js"' }) && cli.isOurs({ command: "node '/x/.ruletree/runtime/hooks/hook.js'" }));
  assert.ok(!cli.isOurs({ command: 'node /x/hooks/hook.js' }));
});

test('命令行：tree、rules、check 只读', () => {
  const dir = H.project();
  const run = (...a) => spawnSync(process.execPath, [path.join(H.ROOT, 'bin', 'ruletree.js'), ...a], { encoding: 'utf8', env: process.env });
  const before = store.readFiles(dir);
  assert.match(run('tree', dir).stdout, /\n {2}C2 数据科学课 🔨 {2}\(规则 1\)\n {4}C2\.1 第1章 ⏳/);
  assert.match(run('rules', 'C2.1', dir).stdout, /- 段落不超过 4 行（来自 P）\n- 不引原话（来自 C2）\n- 开场用霍乱\n/);
  const c = run('check', dir);
  assert.strictEqual(c.status, 0, c.stdout + c.stderr);
  assert.deepStrictEqual(store.readFiles(dir), before);
  assert.strictEqual(run('nope').status, 1);
});

// ---------- 插件 ----------

test('插件：面板数据来自规则文件；面板上加规则、改状态写进文件并记成「你」，撤销还原', async () => {
  const dir = H.project();
  const fake = H.fakeVscode(dir, { input: '例子要足' });
  const { panel, dispose } = H.activateWith(fake);
  try {
    const t = panel.trees[0];
    assert.strictEqual(t.dir, dir);
    await panel.handle({ type: 'edit', uri: t.uri, action: 'addRule', node: 'C2.1' });
    await panel.handle({ type: 'edit', uri: panel.trees[0].uri, action: 'setStatus', node: 'C2.1', status: 'doing' });
    assert.match(H.readRule(dir, C21), /# C2\.1 第1章 🔨[\s\S]*- 例子要足/);
    const [last, first] = store.readChanges(dir);
    assert.strictEqual(first.source, '你');
    await panel.handle({ type: 'undo', uri: panel.trees[0].uri, id: first.id });
    assert.doesNotMatch(H.readRule(dir, C21), /例子要足/);
    assert.match(H.readRule(dir, C21), /🔨/, '后来改的状态留着');
    await panel.handle({ type: 'edit', uri: panel.trees[0].uri, action: 'rename', node: 'C2', title: '  ' });
    assert.strictEqual(store.readChanges(dir).length, 2, '空名字不改');
    await panel.handle({ type: 'edit', uri: panel.trees[0].uri, action: 'rename', node: 'C2', title: '数据课' });
    assert.ok(store.readFiles(dir).has('C2-数据课.md'));
  } finally { dispose(); }
});

test('插件：「打开规则文件」按当时那一行的原文找回行号；只开规则文件夹里的文件', async () => {
  const dir = H.project();
  const fake = H.fakeVscode(dir);
  const { panel, dispose } = H.activateWith(fake);
  try {
    fs.writeFileSync(H.ruleFile(dir, C21), '- 插到前面\n' + H.readRule(dir, C21));
    const uri = panel.trees[0].uri;
    await panel.handle({ type: 'open', uri, file: C21, line: 4, expect: '# C2.1 第1章 ⏳' });
    assert.strictEqual(fake.opened[0].file, H.ruleFile(dir, C21));
    assert.deepStrictEqual(fake.opened[0].opts.selection.a, [5, 0, 5, 0]);
    await panel.handle({ type: 'open', uri, file: '../../../x.md', line: 0 });
    assert.strictEqual(fake.opened.length, 1);
  } finally { dispose(); }
});

test('插件：在编辑器里改规则文件、保存，记成「你」；别处改的刷新时补记成「其他」', async () => {
  const dir = H.project();
  const fake = H.fakeVscode(dir);
  const { panel, dispose } = H.activateWith(fake);
  try {
    fs.writeFileSync(H.ruleFile(dir, C21), H.readRule(dir, C21) + '- 手改的\n');
    fake.save({ uri: fake.vscode.Uri.file(H.ruleFile(dir, C21)) });
    assert.strictEqual(store.readChanges(dir)[0].source, '你');
    const f = H.ruleFile(dir, 'C2-数据科学课.md');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8') + '- git 拉下来的\n');
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(f, old, old);
    panel.load();
    assert.strictEqual(store.readChanges(dir)[0].source, '其他');
    assert.deepStrictEqual(panel.trees[0].changes.map(c => c.source), ['其他', '你']);
  } finally { dispose(); }
});

test('插件：打开旧版项目自动升级（拆开 需求树.md、换 hook），告诉用户；不再弹「启用？」', async () => {
  const dir = fs.mkdtempSync(path.join(H.SANDBOX, 'oldext-'));
  fs.writeFileSync(path.join(dir, '需求树.md'), H.TREE);
  const fake = H.fakeVscode(dir);
  const { panel, api, dispose } = H.activateWith(fake);
  try {
    await api.prompted;
    assert.ok(store.hasRules(dir) && cli.enabledIn(dir));
    assert.ok(fake.shown.some(m => /已升级/.test(m)), fake.shown.join('\n'));
    assert.ok(!fake.shown.some(m => /启用需求树？/.test(m)));
    assert.strictEqual(panel.trees[0].files.size, 3);
  } finally { dispose(); }
});

test('插件：没启用的项目问一次「启用？」；新建 = 启用，按文件夹建需求', async () => {
  const dir = fs.mkdtempSync(path.join(H.SANDBOX, 'fresh-'));
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'lib', 'a.js'), '');
  const fake = H.fakeVscode(dir);
  const { panel, api, dispose } = H.activateWith(fake);
  try {
    await api.prompted;
    assert.ok(fake.shown.some(m => /启用需求树？/.test(m)));
    assert.strictEqual(panel.trees.length, 0);
    await panel.handle({ type: 'create' });
    assert.ok(cli.enabledIn(dir));
    assert.deepStrictEqual(panel.trees[0].files.size, 2);
    assert.strictEqual(fake.opened[0].file, H.ruleFile(dir, '_root.md'));
  } finally { dispose(); }
});

test('插件：界面语言——设置优先；auto 时 VS Code 中文就中文，英文界面看规则写的什么语言', async () => {
  const dir = H.project();
  const fake = H.fakeVscode(dir);
  fake.vscode.env.language = 'en';
  const html = () => { const v = { webview: { html: '', options: {}, cspSource: 'x', asWebviewUri: u => u, postMessage() {}, onDidReceiveMessage() {} }, onDidChangeVisibility() {} }; panel.resolveWebviewView(v); return v.webview.html; };
  const { panel, dispose } = H.activateWith(fake);
  try {
    assert.match(html(), /data-lang="zh"/, '规则是中文');
    fake.config.language = 'en';
    assert.match(html(), /data-lang="en"/);
  } finally { dispose(); }
});

// ---------- 面板数据 ----------

test('面板数据：取代上级的规则标出来（显示时去掉说明）、被取代的标「被覆盖」；没写范围的需求标出来；行号和原文跟着所在文件', () => {
  const dir = H.project(`# P x\n- 段落不超过 4 行\n\n## C2 课\n> 文件：c/**\n\n### C2.1 章\n- [段落] 可以到 6 行\n\n## C3 杂项\n- 每次都加载\n`.replace('### C2.1 章\n- [段落]', '### C2.1 章\n- [段落]'));
  // 旧格式的键：C2.1 的 [段落] 没有上级同键（P 那条没写键），手写一条取代说明
  store.commit(dir, [{ op: 'replace_rule', node: 'C2.1', old: '可以到 6 行', text: '段落可以到 6 行（在本范围内取代 P 的「段落不超过 4 行」）' }]);
  const data = viewData([{ uri: 'u', name: 'x', dir, files: store.readFiles(dir) }]);
  const nodes = [];
  const walk = list => list.forEach(n => { nodes.push(n); walk(n.children); });
  walk(data.files[0].nodes);
  const c21 = nodes.find(n => n.id === 'C2.1');
  const own = c21.groups.find(g => g.self).rules[0];
  assert.deepStrictEqual([own.state, own.ref, own.shown], ['overrides', 'P', '段落可以到 6 行']);
  assert.deepStrictEqual(c21.groups.find(g => g.ownerId === 'P').rules.map(r => [r.state, r.ref]), [['overridden', 'C2.1']]);
  assert.strictEqual(c21.file, 'C2.1-章.md');
  assert.strictEqual(c21.raw, '# C2.1 章');
  assert.strictEqual(own.raw, `- ${own.text}`);
  assert.ok(nodes.find(n => n.id === 'C3').global && !c21.global && !nodes[0].global);
});

test('面板数据：上下文用量按会话汇总——同一文件只算一次，常驻、按需分开算，需求树自己的规则单算', () => {
  const now = Date.now();
  const e = (session, file, chars, reason, source = 'ruletree', node = null) => ({ session, file, chars, reason, source, node, time: now - 1000 });
  const [s] = contextData([e('a', '.claude/rules/ruletree/_guide.md', 300, 'session_start'), e('a', '.claude/rules/ruletree/C2.md', 200, 'path_glob_match', 'ruletree', 'C2'), e('a', '.claude/rules/ruletree/C2.md', 200, 'compact'), e('a', 'CLAUDE.md', 1000, 'session_start', 'claude-md')], now);
  assert.deepStrictEqual([s.total, s.resident, s.demand, s.ruletree], [1500, 1500, 0, 500]);
});

test('文字表：中英两张表的键一样；代码里用到的键都在表里', () => {
  assert.deepStrictEqual(Object.keys(STRINGS.en).sort(), Object.keys(STRINGS.zh).sort());
  const files = ['extension.js', 'media/detail.js', 'media/view.js', 'media/map.js', 'src/checkup.js'].map(f => fs.readFileSync(path.join(H.ROOT, f), 'utf8')).join('\n');
  const used = [...files.matchAll(/\bt?T\('([a-z]+\.[A-Za-z_.]+)'/g)].map(m => m[1]);
  assert.deepStrictEqual([...new Set(used.filter(k => !(k in STRINGS.zh)))], []);
});

test('审查回归：hook 从 Edit 的参数倒推改之前的样子，git 拉下来的需求不算成 AI 新建的', () => {
  const dir = H.project();
  const f = H.ruleFile(dir, 'C9-拉下来的.md');
  fs.writeFileSync(f, '# C9 拉下来的\n- 队友的规则\n');
  fs.writeFileSync(f, '# C9 拉下来的\n- 队友的规则\n- AI 加的\n');
  H.hook(dir, H.edit(dir, '.claude/rules/ruletree/C9-拉下来的.md', { tool_input: { file_path: f, old_string: '- 队友的规则\n', new_string: '- 队友的规则\n- AI 加的\n' } }));
  const [ai, other] = store.readChanges(dir);
  assert.deepStrictEqual(ai.summary, ['给 C9 加规则「AI 加的」']);
  assert.deepStrictEqual(other.summary, ['新需求 C9 拉下来的']);
});

test('审查回归：项目经过目录联接打开时，hook 照样记', { skip: process.platform !== 'win32' && '只在 Windows 上建目录联接' }, () => {
  const dir = H.project();
  const link = path.join(H.SANDBOX, 'junction-' + Date.now());
  fs.symlinkSync(dir, link, 'junction');
  H.hook(link, H.edit(link, 'DataScience/index.html'));
  assert.deepStrictEqual(activity(dir).map(e => e.node), ['C2']);
});
