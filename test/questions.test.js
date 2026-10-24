'use strict';
// 拿不准就问：记录员的问题、回答/关掉/过期、排队、久未动、体检、插件的通知和命令。
// 模型一律用假的 claude（test/fixtures/fake-claude.js），不花钱
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SANDBOX = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reqtree-sandbox-')));
process.env.TEMP = process.env.TMP = process.env.TMPDIR = SANDBOX;
process.env.REQTREE_HOME = path.join(SANDBOX, 'home', '.reqtree');
// 体检会找 Claude Code 的自动记忆：换到沙盒，别碰真实的 ~/.claude
process.env.CLAUDE_CONFIG_DIR = path.join(SANDBOX, 'claude-config');
const ROOT = path.join(__dirname, '..');
const RECORDER = path.join(ROOT, 'hooks', 'recorder.js');
const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
// 体检在本进程里调用模型：recorder.js 加载时读这个环境变量
process.env.REQTREE_CLAUDE_CMD = `"${process.execPath}" "${FAKE}"`;

const store = require('../src/store');
const Q = require('../src/questions');
const rec = require('../hooks/recorder');
const { runCheckup, duplicateOps } = require('../src/checkup');

const TREE = `# P 测试项目
- 每章互动不超过4个
- 段落不超过 4 行

## C1 AI 课 🔨
> 文件：ai/**
- 手账风

### C1.1 第1章 🔨
> 文件：ai/ch01-*.html
- 开场用霍乱

### C1.5 第5章 ⏳
> 文件：ai/ch05-*.html
`;

function project(text = TREE) {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'proj-'));
  fs.writeFileSync(path.join(dir, '需求树.md'), text);
  return { dir, tree: path.join(dir, '需求树.md') };
}
const read = tree => fs.readFileSync(tree, 'utf8');

function runRecorder(dir, out, job = {}) {
  const jobFile = path.join(dir, `job-${Math.random()}.json`);
  fs.writeFileSync(jobFile, JSON.stringify({ treePath: path.join(dir, '需求树.md'), touched: [], unmapped: [], turns: [{ user: '第5章的互动可以多一点，大概六个', ai: '好的' }], ...job }));
  const log = path.join(dir, 'fake.log');
  spawnSync(process.execPath, [RECORDER, jobFile], { encoding: 'utf8', env: { ...process.env, FAKE_OUT: JSON.stringify(out), FAKE_LOG: log } });
  return {
    status: store.readRecorderStatus(path.join(dir, '需求树.md')),
    calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [],
  };
}

// 第5章例外 vs 全项目改成 6：典型的范围歧义
const OVERRIDE = { op: 'override_rule', node: 'C1.5', from: 'P', text: '每章互动不超过4个', new: '本章互动可以到6个' };
const GLOBAL = { op: 'replace_rule', node: 'P', old: '每章互动不超过4个', text: '每章互动不超过6个' };
const SCOPE_Q = { text: '「互动可以多一点」只管第5章，还是所有章？', options: [{ label: '只第5章', ops: [OVERRIDE] }, { label: '所有章', ops: [GLOBAL] }], default: 0 };

test('记录员：问题和默认做法——默认做法写进树（只写一次），问题记进 questions.jsonl，状态里说问了', () => {
  const { dir, tree } = project();
  const { status, calls } = runRecorder(dir, { ops: [OVERRIDE, { op: 'add_rule', node: 'C1.1', text: '例子配插图' }], questions: [SCOPE_Q] });
  assert.ok(status.ok, JSON.stringify(status));
  assert.match(calls[0].input, /questions/, '提示词里要说可以问');
  const text = read(tree);
  assert.strictEqual((text.match(/本章互动可以到6个/g) || []).length, 1, '默认做法只写一次');
  assert.match(text, /^- \[改写1\] 每章互动不超过4个$/m, 'override_rule 给上级补了键');
  assert.match(text, /- 例子配插图/);
  const [q] = Q.openQuestions(tree);
  assert.strictEqual(q.text, SCOPE_Q.text);
  assert.strictEqual(q.default, 0);
  assert.ok(q.defaultApplied && q.changeId);
  // 默认做法单独一条改动，和这一轮别的改动分开（撤销默认做法不能连带撤掉别的）
  const changes = store.readChanges(tree);
  assert.strictEqual(changes.length, 2);
  assert.ok(changes.some(c => c.id === q.changeId && c.ops.length === 1 && c.ops[0].op === 'override_rule'));
  assert.match(status.message, /1 件事拿不准/);
  assert.deepStrictEqual(status.parts.map(p => p.k), ['rec.rules', 'rec.asked']);
});

test('回答：选别的选项 → 撤销默认做法，按选的改，记成「你」的改动；选默认的只记一下；关掉保留默认', async () => {
  {
    const { dir, tree } = project();
    runRecorder(dir, { ops: [OVERRIDE], questions: [SCOPE_Q] });
    const [q] = Q.openQuestions(tree);
    const r = await Q.answerQuestion(tree, q.id, 1);
    assert.ok(r.ok);
    const text = read(tree);
    assert.ok(!text.includes('本章互动可以到6个'), '默认做法没撤销');
    assert.ok(!text.includes('[改写1]'), '撤销时补的键也要去掉');
    assert.match(text, /^- 每章互动不超过6个$/m);
    assert.strictEqual(store.readChanges(tree)[0].source, '你');
    const after = Q.readQuestions(tree).find(x => x.id === q.id);
    assert.strictEqual(after.status, 'answered');
    assert.strictEqual(after.choice, 1);
    assert.strictEqual(Q.openQuestions(tree).length, 0);
    assert.strictEqual((await Q.answerQuestion(tree, q.id, 0)).reason, 'gone', '回答过的不能再答');
  }
  {
    const { dir, tree } = project();
    runRecorder(dir, { ops: [OVERRIDE], questions: [SCOPE_Q] });
    const before = read(tree);
    const [q] = Q.openQuestions(tree);
    assert.ok((await Q.answerQuestion(tree, q.id, 0)).ok);
    assert.strictEqual(read(tree), before, '选默认的不改树');
    assert.strictEqual(Q.readQuestions(tree)[0].status, 'answered');
  }
  {
    const { dir, tree } = project();
    runRecorder(dir, { ops: [OVERRIDE], questions: [SCOPE_Q] });
    const before = read(tree);
    const [q] = Q.openQuestions(tree);
    assert.ok(Q.dismissQuestion(tree, q.id));
    assert.strictEqual(read(tree), before);
    assert.strictEqual(Q.readQuestions(tree)[0].status, 'dismissed');
    assert.strictEqual((await Q.answerQuestion(tree, q.id, 1)).reason, 'gone');
  }
});

test('回答：用户已经在面板上撤销了默认做法，再选别的也能写进去', async () => {
  const { dir, tree } = project();
  runRecorder(dir, { ops: [], questions: [SCOPE_Q] }); // 模型没把默认做法写进 ops：照样按 default 写
  const [q] = Q.openQuestions(tree);
  assert.match(read(tree), /本章互动可以到6个/);
  assert.ok(store.undoChange(tree, q.changeId));
  assert.ok((await Q.answerQuestion(tree, q.id, 1)).ok);
  assert.match(read(tree), /^- 每章互动不超过6个$/m);
});

test('过期：开着超过 7 天的问题算过期，不再出现在待回答里，默认做法保留', () => {
  const { tree } = project();
  const q = Q.addQuestion(tree, { text: '旧问题', options: [{ label: 'a', ops: [] }, { label: 'b', ops: [] }], default: 0, defaultApplied: true });
  const later = Date.now() + 8 * 86400000;
  assert.strictEqual(Q.readQuestions(tree, later).find(x => x.id === q.id).status, 'expired');
  assert.strictEqual(Q.openQuestions(tree, later).length, 0);
  assert.strictEqual(Q.openQuestions(tree).length, 1);
});

test('格式不对的问题安全丢掉：选项的改动过同样的筛子（白名单、add_files 要有根据、换行压平、对不上树的不要）', () => {
  const { dir, tree } = project();
  const bad = [
    'not an object',
    { text: '', options: [{ label: 'a', ops: [] }, { label: 'b', ops: [] }] }, // 没有问题文字
    { text: '只有一个选项', options: [{ label: 'a', ops: [] }] },
    { text: '选项里删整个需求', options: [{ label: '删掉', ops: [{ op: 'delete_node', node: 'C1' }] }, { label: '不删', ops: [] }], default: 0 },
    { text: '默认选项不存在', options: [{ label: 'a', ops: [] }, { label: 'b', ops: [] }], default: 5 },
    { text: '没根据的文件对应', options: [{ label: '设文件', ops: [{ op: 'add_files', node: 'C1.5', globs: ['zzz/**'] }] }, { label: '不设', ops: [] }], default: 0 },
    { text: '指向不存在的需求', options: [{ label: 'x', ops: [{ op: 'add_rule', node: 'Z9', text: '找不到' }] }, { label: 'y', ops: [] }], default: 0 },
    { text: 'ops 不是数组', options: [{ label: 'a', ops: 'add_rule' }, { label: 'b', ops: [] }] },
  ];
  const { status } = runRecorder(dir, { ops: [{ op: 'add_rule', node: 'C1.1', text: '例子配插图' }], questions: bad });
  assert.ok(status.ok, JSON.stringify(status));
  assert.strictEqual(Q.openQuestions(tree).length, 0, '格式不对的问题都丢掉：' + JSON.stringify(Q.openQuestions(tree)));
  const text = read(tree);
  assert.match(text, /例子配插图/, '这一轮正常的改动照常生效');
  assert.match(text, /## C1 AI 课/, '删需求的选项没被执行');
  assert.ok(!text.includes('zzz') && !text.includes('找不到'));
  // ops 不是数组、questions 也不是数组：报错，和以前没有 ops 一样
  const bad2 = runRecorder(dir, { questions: 'x' });
  assert.strictEqual(bad2.status.ok, false);
  // 只有 questions 没有 ops 也行
  const only = runRecorder(dir, { questions: [] });
  assert.ok(only.status.ok);
});

test('格式：合格的问题里换行压平，最多 2 个，选项最多 4 个', () => {
  const { tree } = project();
  const text = read(tree);
  const opts = n => Array.from({ length: n }, (_, i) => ({ label: `选${i}`, ops: i ? [{ op: 'add_rule', node: 'C1.5', text: `规则${i}` }] : [] }));
  const raw = [
    { text: '换行\n## X 注入', options: [{ label: '甲\n## Y', ops: [{ op: 'add_rule', node: 'C1.5', text: '第一行\n## Z 注入' }] }, { label: '乙', ops: [] }], default: 0 },
    { text: '五个选项', options: opts(5), default: 0 },
    { text: '第三个问题', options: opts(2), default: 0 },
  ];
  const ctx = { root: require('../src/parser').parse(text), unmapped: [], user: '' };
  const { questions } = rec.pickQuestions(raw, { text, ops: [], ctx });
  assert.strictEqual(questions.length, 2);
  assert.strictEqual(questions[0].text, '换行 ## X 注入');
  assert.strictEqual(questions[0].options[0].label, '甲 ## Y');
  assert.strictEqual(questions[0].options[0].ops[0].text, '第一行 ## Z 注入');
  assert.strictEqual(questions[1].options.length, 4);
  // 默认选项被丢掉时整个问题不要；被丢掉的问题，写在 ops 里的改动留着
  const o = { op: 'add_rule', node: 'Z9', text: '找不到' };
  const r = rec.pickQuestions([{ text: 'q', options: [{ label: 'a', ops: [o] }, { label: 'b', ops: [] }], default: 0 }], { text, ops: [o], ctx });
  assert.strictEqual(r.questions.length, 0);
  assert.deepStrictEqual(r.ops, [o]);
});

test('丢掉的问题：模型写在 ops 里的默认做法照常生效', () => {
  const { dir, tree } = project();
  const q = { text: '默认选项不存在', options: [{ label: 'a', ops: [OVERRIDE] }, { label: 'b', ops: [GLOBAL] }], default: 7 };
  runRecorder(dir, { ops: [OVERRIDE], questions: [q] });
  assert.match(read(tree), /本章互动可以到6个/);
  assert.strictEqual(Q.openQuestions(tree).length, 0);
});

test('排队：用户正在编辑需求树时，默认做法带着问题编号排队；保存后单独记一条改动并补进问题，之后改选能撤销', async () => {
  const { dir, tree } = project();
  store.setEditing(tree, true);
  runRecorder(dir, { ops: [OVERRIDE, { op: 'add_rule', node: 'C1.1', text: '例子配插图' }], questions: [SCOPE_Q] });
  let [q] = Q.openQuestions(tree);
  assert.ok(q.queued && !q.changeId);
  assert.ok(!read(tree).includes('本章互动'), '编辑中不该写树');
  store.setEditing(tree, false);
  store.flushQueue(tree);
  assert.match(read(tree), /本章互动可以到6个/);
  assert.match(read(tree), /例子配插图/);
  [q] = Q.openQuestions(tree);
  assert.ok(q.changeId, '写入后问题里补上改动编号');
  assert.strictEqual(store.readChanges(tree).length, 2, '问题的默认做法单独一条');
  await Q.answerQuestion(tree, q.id, 1);
  assert.ok(!read(tree).includes('本章互动'));
  assert.match(read(tree), /例子配插图/, '别的改动不受影响');
});

test('排队：插件保存时（异步写）也按问题分组写入、补上改动编号', async () => {
  const { dir, tree } = project();
  store.setEditing(tree, true);
  runRecorder(dir, { ops: [OVERRIDE, { op: 'add_rule', node: 'C1.1', text: '例子配插图' }], questions: [SCOPE_Q] });
  store.setEditing(tree, false);
  const writes = [];
  const applied = await store.flushQueue(tree, { write: (p, update) => { writes.push(p); return store.updateTreeAsync(p, update); } });
  assert.strictEqual(writes.length, 2);
  assert.strictEqual(applied.length, 2);
  const [q] = Q.openQuestions(tree);
  assert.ok(store.readChanges(tree).some(c => c.id === q.changeId && c.ops[0].op === 'override_rule'));
});

test('排队：还没保存就改选了别的，排着的默认做法从队列里拿掉', async () => {
  const { dir, tree } = project();
  store.setEditing(tree, true);
  runRecorder(dir, { ops: [OVERRIDE], questions: [SCOPE_Q] });
  const [q] = Q.openQuestions(tree);
  store.setEditing(tree, false);
  await Q.answerQuestion(tree, q.id, 1);
  store.flushQueue(tree);
  assert.ok(!read(tree).includes('本章互动'), '排着的默认做法应该被拿掉');
  assert.match(read(tree), /^- 每章互动不超过6个$/m);
});

test('状态：明确做完 → 完成；待定 → ❓；拿不准是否做完 → 问，默认不改', async () => {
  const { dir, tree } = project();
  runRecorder(dir, { ops: [{ op: 'set_status', node: 'C1.1', status: 'done' }, { op: 'set_status', node: 'C1.5', status: 'question' }] });
  assert.match(read(tree), /### C1\.1 第1章 ✅/);
  assert.match(read(tree), /### C1\.5 第5章 ❓/);
  const p2 = project();
  const doneQ = { text: '「第1章」看起来做完了，标成完成？', options: [{ label: '完成', ops: [{ op: 'set_status', node: 'C1.1', status: 'done' }] }, { label: '还没', ops: [] }], default: 1 };
  const { status } = runRecorder(p2.dir, { ops: [], questions: [doneQ] }, { turns: [{ user: '第1章的练习写好了', ai: '练习部分完成了' }] });
  assert.ok(status.ok);
  assert.match(read(p2.tree), /### C1\.1 第1章 🔨/, '默认是还没：不改');
  const [q] = Q.openQuestions(p2.tree);
  assert.ok(q.defaultApplied && !q.changeId);
  await Q.answerQuestion(p2.tree, q.id, 0);
  assert.match(read(p2.tree), /### C1\.1 第1章 ✅/);
});

test('提示词：有「拿不准就问」、最新为准的例子、override_rule、状态规则', () => {
  const p = rec.buildPrompt(TREE, [{ user: 'x', ai: 'y' }], [], []);
  for (const s of ['questions', 'default', '以最新的为准', '像素风探险地图', '手账风只属于第一篇', '第5章互动可以多一点', 'override_rule', 'set_status question', '先放着', '每轮最多 2 个问题']) assert.ok(p.includes(s), s);
});

// ---------- 久未动 ----------

function staleProject() {
  const p = project();
  store.updateState(p.tree, s => ({ ...s, since: Date.now() - 5 * 86400000, touched: {} }));
  return p;
}

test('久未动：🔨 很久没动的需求变成问题（不调用模型），每个周期只问一次；「还在做」重新开始算', async () => {
  const { tree } = staleProject();
  const added = Q.staleQuestions(tree);
  assert.deepStrictEqual(added.map(q => q.node), ['C1.1'], 'C1 有 🔨 的子需求撑着，只问叶子');
  const q = added[0];
  assert.strictEqual(q.text, '「第1章」5 天没动了，做完了吗？');
  assert.deepStrictEqual(q.options.map(o => o.label), ['完成', '暂停（待定）', '还在做']);
  assert.strictEqual(q.default, 2);
  assert.strictEqual(Q.staleQuestions(tree).length, 0, '同一周期不再问');
  await Q.answerQuestion(tree, q.id, 2);
  assert.match(read(tree), /### C1\.1 第1章 🔨/);
  assert.ok(store.readTouched(tree)['C1.1'] > Date.now() - 60000, '「还在做」重新开始算');
  assert.strictEqual(Q.staleQuestions(tree).length, 0);
  assert.strictEqual(Q.staleQuestions(tree, Date.now() + 4 * 86400000).length, 1, '过一个周期再问');
});

test('久未动：选「暂停」标成待定；AI 又改了它，开着的问题自动收起', async () => {
  {
    const { tree } = staleProject();
    const [q] = Q.staleQuestions(tree);
    await Q.answerQuestion(tree, q.id, 1);
    assert.match(read(tree), /### C1\.1 第1章 ❓/);
  }
  {
    const { tree } = staleProject();
    const [q] = Q.staleQuestions(tree);
    store.touch(tree, ['C1.1']);
    Q.staleQuestions(tree);
    const after = Q.readQuestions(tree).find(x => x.id === q.id);
    assert.strictEqual(after.status, 'dismissed');
  }
});

test('久未动：同时最多开着 3 个', () => {
  const kids = Array.from({ length: 6 }, (_, i) => `### C1.${i + 1} 第${i + 1}章 🔨\n`).join('\n');
  const { tree } = project(`# P 项目\n\n## C1 课 🔨\n${kids}`);
  store.updateState(tree, s => ({ ...s, since: Date.now() - 5 * 86400000 }));
  assert.strictEqual(Q.staleQuestions(tree).length, 3);
  assert.strictEqual(Q.staleQuestions(tree).length, 0);
});

test('记录员每轮顺便生成久未动的问题', () => {
  const { dir, tree } = staleProject();
  runRecorder(dir, { ops: [] }, { turns: [{ user: '好', ai: '' }] });
  assert.strictEqual(Q.openQuestions(tree).filter(q => q.kind === 'stale').length, 1);
});

// ---------- 体检 ----------

test('体检：同一需求里几乎一样的、同键的规则合并（留后写的），不调用模型时不问冲突', async () => {
  const text = `# P 项目
- 段落都不超过 4 行
- [图] 每章 3 张图
- 段落不超过 4 行
- [图] 每章 5 张图

## C1 课
> 文件：c1/**
- 开场用伦敦地图
- 开场用勇士
`;
  const { dir, tree } = project(text);
  assert.strictEqual(duplicateOps(text).length, 2);
  // 只读的 check 提醒但不改
  const res = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'reqtree.js'), 'check', tree], { encoding: 'utf8' });
  assert.match(res.stdout, /check --fix/);
  assert.strictEqual(read(tree), text);
  const r = await runCheckup(tree, { model: false });
  assert.strictEqual(r.merged.length, 2);
  const after = read(tree);
  assert.ok(!after.includes('段落都不超过'));
  assert.match(after, /^- 段落不超过 4 行$/m);
  assert.ok(!after.includes('每章 3 张图'));
  assert.match(after, /^- \[图\] 每章 5 张图$/m);
  assert.match(after, /开场用伦敦地图/);
  assert.match(after, /开场用勇士/, '不像的不合并');
  assert.ok(store.undoChange(tree, store.readChanges(tree)[0].id), '合并能撤销');
  assert.strictEqual(read(tree), text);
  assert.ok(!fs.existsSync(path.join(dir, 'fake.log')));
});

const CONFLICT_TREE = `# P 项目
- 每章互动不超过4个

## C1 AI 课
> 文件：ai/**
- 每章互动不超过5个
`;
const CONFLICT_Q = {
  text: '全局写每章互动不超过4个，AI 课写不超过5个：',
  options: [
    { label: 'AI 课用5（本课例外）', ops: [{ op: 'remove_rule', node: 'C1', text: '每章互动不超过5个' }, { op: 'override_rule', node: 'C1', from: 'P', text: '每章互动不超过4个', new: '每章互动不超过5个' }] },
    { label: '统一用4', ops: [{ op: 'remove_rule', node: 'C1', text: '每章互动不超过5个' }] },
    { label: '两条都留着', ops: [] },
  ],
  default: 0,
};

test('体检：可能冲突的规则交给（假）模型——拿不准的什么都不改、只问你；有把握的直接改、不问，撤销过的不再提', async () => {
  const { tree } = project(CONFLICT_TREE);
  process.env.FAKE_OUT = JSON.stringify({ questions: [CONFLICT_Q, { text: '坏的', options: [{ label: 'x', ops: [{ op: 'delete_node', node: 'C1' }] }, { label: 'y', ops: [] }] }] });
  try {
    const r = await runCheckup(tree);
    assert.ifError(r.error);
    assert.strictEqual(r.questions.length, 1, '坏的问题丢掉');
    assert.strictEqual(read(tree), CONFLICT_TREE, '拿不准：先不改树');
    const [q] = Q.openQuestions(tree);
    assert.strictEqual(q.source, '体检');
    assert.strictEqual(q.default, 2, '默认选「两条都留着」');
    // 再体检一次：同样的问题还开着，不重复问
    assert.strictEqual((await runCheckup(tree)).questions.length, 0);
    // 选「统一用4」：按选的改
    await Q.answerQuestion(tree, q.id, 1);
    assert.ok(!read(tree).includes('不超过5个'));
    // 有把握的：直接改，不问；撤销以后下次体检不再提
    const p2 = project(CONFLICT_TREE);
    process.env.FAKE_OUT = JSON.stringify({ questions: [{ ...CONFLICT_Q, default: 1, sure: true }] });
    const r2 = await runCheckup(p2.tree);
    assert.strictEqual(r2.questions.length, 0);
    assert.strictEqual(r2.auto.length, 1);
    assert.ok(!read(p2.tree).includes('不超过5个'));
    assert.strictEqual(Q.openQuestions(p2.tree).length, 0);
    assert.ok(store.undoChange(p2.tree, store.readChanges(p2.tree)[0].id));
    assert.match(read(p2.tree), /不超过5个/);
    const r3 = await runCheckup(p2.tree);
    assert.strictEqual(r3.auto.length + r3.questions.length, 0);
    assert.match(read(p2.tree), /不超过5个/, '撤销过的不再改');
  } finally { delete process.env.FAKE_OUT; }
});

test('体检：模型出错时，合并和久未动照样做完，错误带回去', async () => {
  const { tree } = project(CONFLICT_TREE + '- 每章互动都不超过5个\n');
  process.env.FAKE_EXIT = '1';
  try {
    const r = await runCheckup(tree);
    assert.ok(r.error);
    assert.strictEqual(r.merged.length, 1);
  } finally { delete process.env.FAKE_EXIT; }
});

test('命令行：check --fix 体检并列出问题，questions 列出，answer 回答', () => {
  const { tree } = project(CONFLICT_TREE);
  const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'reqtree.js'), ...a], { encoding: 'utf8', env: { ...process.env, FAKE_OUT: JSON.stringify({ questions: [CONFLICT_Q] }) } });
  const fix = cli('check', tree, '--fix');
  assert.strictEqual(fix.status, 0, fix.stderr);
  assert.match(fix.stdout, /AI 课用5/);
  const list = cli('questions', tree);
  assert.match(list.stdout, /共 1 个问题/);
  const id = list.stdout.match(/^(q\S+)/m)[1];
  const ans = cli('answer', tree, id, '2');
  assert.strictEqual(ans.status, 0, ans.stderr);
  assert.ok(!read(tree).includes('不超过5个'));
  assert.strictEqual(cli('answer', tree, id, '1').status, 1, '回答过的不能再答');
});

// ---------- 插件 ----------

function fakeVscode(dir, { mode = 'notify', answer } = {}) {
  const shown = [], notes = [], picks = [], ctx = {};
  const disposable = { dispose() {} };
  const Uri = { file: p => ({ scheme: 'file', fsPath: p, toString: () => 'file:///' + p.replace(/\\/g, '/') }), joinPath: (u, ...s) => Uri.file(path.join(u.fsPath, ...s)) };
  let panel = null;
  const vscode = {
    Uri, Range: class {}, RelativePattern: class {}, ThemeIcon: class {}, ViewColumn: { Active: 1 }, WorkspaceEdit: class {},
    workspace: {
      workspaceFolders: [{ uri: Uri.file(dir) }], textDocuments: [], asRelativePath: p => path.basename(p),
      createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }),
      onDidChangeTextDocument: () => disposable, onDidSaveTextDocument: () => disposable,
      onDidCloseTextDocument: () => disposable, onDidChangeWorkspaceFolders: () => disposable,
      getConfiguration: () => ({ get: (k, d) => (k === 'askQuestions' ? mode : d) }),
    },
    window: {
      registerWebviewViewProvider: (id, p) => { panel = p; return disposable; },
      showInformationMessage: async (m, ...items) => { shown.push(m); if (items.length) { notes.push({ m, items }); return answer ? answer(m, items) : undefined; } },
      showWarningMessage: async m => { shown.push(m); }, showErrorMessage: m => shown.push(m),
      showQuickPick: async (items, opts) => { picks.push({ items, opts }); return fakeVscode.pick ? fakeVscode.pick(items, opts) : undefined; },
    },
    commands: {
      registerCommand: (id, fn) => { ctx[id] = fn; return disposable; },
      executeCommand: async (...a) => { ctx.lastContext = a; },
    },
  };
  return { vscode, shown, notes, picks, commands: ctx, panel: () => panel };
}

function activateWith(fake) {
  const Module = require('module');
  const load = Module._load;
  Module._load = function (req, ...rest) { return req === 'vscode' ? fake.vscode : load.call(this, req, ...rest); };
  try {
    delete require.cache[require.resolve('../extension')];
    const ext = require('../extension');
    const mem = new Map();
    const context = { subscriptions: [], extensionUri: fake.vscode.Uri.file(ROOT), workspaceState: { get: k => mem.get(k), update: async (k, v) => { mem.set(k, v); } } };
    const api = ext.activate(context);
    return { panel: api.panel, api, mem, dispose: () => context.subscriptions.forEach(d => d.dispose && d.dispose()) };
  } finally { Module._load = load; }
}

function withQuestion() {
  const p = project();
  runRecorder(p.dir, { ops: [OVERRIDE], questions: [SCOPE_Q] });
  // 插件启用提示别混进来
  fs.mkdirSync(path.join(p.dir, '.claude'), { recursive: true });
  return p;
}

test('插件：新问题弹不挡操作的通知（问题 + 选项 +「以后再说」），点了别的选项就改；图标上显示个数', async () => {
  const { dir, tree } = withQuestion();
  const fake = fakeVscode(dir, { answer: (m, items) => (/拿不准|只管第5章/.test(m) ? items[1] : undefined) });
  const { panel, api, dispose } = activateWith(fake);
  try {
    await api.prompted;
    await panel.asking;
    const note = fake.notes.find(n => n.m.includes('只管第5章'));
    assert.ok(note, fake.shown.join('\n'));
    assert.match(note.m, /先按「只第5章」记了/);
    assert.deepStrictEqual(note.items.map(i => i.title), ['只第5章（现在）', '所有章', '以后再说']);
    await panel.asking;
    assert.match(read(tree), /^- 每章互动不超过6个$/m);
    assert.ok(!read(tree).includes('本章互动'));
    assert.strictEqual(Q.openQuestions(tree).length, 0);
    // 同一个问题不会再弹
    panel.load();
    assert.strictEqual(fake.notes.filter(n => n.m.includes('只管第5章')).length, 1);
  } finally { dispose(); }
});

test('插件：「以后再说」不改树，问题留着、不再弹；图标上显示个数；「待回答的问题」命令里能答', async () => {
  const { dir, tree } = withQuestion();
  const before = read(tree);
  const fake = fakeVscode(dir, { answer: (m, items) => items.find(i => i.later) });
  const { panel, api, mem, dispose } = activateWith(fake);
  try {
    await api.prompted; await panel.asking;
    assert.strictEqual(read(tree), before);
    const [q] = Q.openQuestions(tree);
    assert.deepStrictEqual(mem.get('reqtree.snoozedQuestions'), [q.id]);
    const view = { webview: { options: {}, html: '', cspSource: 'x', asWebviewUri: u => u, onDidReceiveMessage() {}, postMessage() {} }, onDidChangeVisibility() {}, visible: true };
    panel.resolveWebviewView(view);
    panel.load();
    assert.deepStrictEqual(view.badge, { value: 1, tooltip: '1 个问题等你回答' });
    assert.deepStrictEqual(fake.commands.lastContext, ['setContext', 'reqtree.hasQuestions', true]);
    fakeVscode.pick = (items) => items.find(i => i.label === '所有章');
    try { await fake.commands['reqtree.questions'](); } finally { fakeVscode.pick = null; }
    const pick = fake.picks[fake.picks.length - 1];
    assert.strictEqual(pick.opts.placeHolder, '「互动可以多一点」只管第5章，还是所有章？');
    assert.deepStrictEqual(pick.items.map(i => [i.label, i.description]), [['只第5章', '现在是这样'], ['所有章', undefined], ['保持现在这样', '不再问这个问题']]);
    assert.match(read(tree), /^- 每章互动不超过6个$/m);
    assert.strictEqual(view.badge, undefined);
    await fake.commands['reqtree.questions']();
    assert.ok(fake.shown.includes('需求树：没有等你回答的问题'));
  } finally { dispose(); }
});

test('插件：设置 panel 只显示个数不弹通知；off 不问，记录员的默认做法直接算数', async () => {
  {
    const { dir, tree } = withQuestion();
    const fake = fakeVscode(dir, { mode: 'panel' });
    const { panel, api, dispose } = activateWith(fake);
    try {
      await api.prompted; await panel.asking;
      assert.strictEqual(fake.notes.filter(n => /只管第5章/.test(n.m)).length, 0);
      assert.strictEqual(Q.openQuestions(tree).length, 1);
    } finally { dispose(); }
  }
  {
    const { dir, tree } = withQuestion();
    const before = read(tree);
    const fake = fakeVscode(dir, { mode: 'off' });
    const { panel, api, dispose } = activateWith(fake);
    try {
      await api.prompted; await panel.asking;
      assert.strictEqual(fake.notes.filter(n => /只管第5章/.test(n.m)).length, 0);
      assert.strictEqual(Q.openQuestions(tree).length, 0);
      const q = Q.readQuestions(tree)[0];
      assert.strictEqual(q.status, 'answered');
      assert.ok(q.auto);
      assert.strictEqual(read(tree), before, '默认做法留着');
    } finally { dispose(); }
  }
});

test('插件：久未动的问题按界面语言显示（英文）', async () => {
  const { dir, tree } = staleProject();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  const fake = fakeVscode(dir, { answer: (m, items) => items[0] });
  fake.vscode.env = { language: 'en' };
  // 需求树是中文写的，auto 会跟着树用中文；这里要看英文，明确设成 en
  fake.vscode.workspace.getConfiguration = () => ({ get: (k, d) => (k === 'language' ? 'en' : d) });
  const { panel, api, dispose } = activateWith(fake);
  try {
    await api.prompted; await panel.asking;
    const note = fake.notes.find(n => /touched/.test(n.m));
    assert.ok(note, fake.shown.join('\n'));
    assert.match(note.m, /^ReqTree: "第1章" hasn't been touched for 5 days\. Is it done\? \(recorded as "Still working on it" for now\)$/);
    assert.deepStrictEqual(note.items.map(i => i.title), ['Done', 'Pause (undecided)', 'Still working on it (current)', 'Later']);
    await panel.asking;
    assert.match(read(tree), /### C1\.1 第1章 ✅/);
  } finally { dispose(); }
});

test('插件：「需求树：体检」合并重复、调用（假）模型，拿不准的冲突不改、弹通知问你，选了就按选的改', async () => {
  const { dir, tree } = project(CONFLICT_TREE + '- 例子要配插图\n- 例子都要配插图\n');
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  const fake = fakeVscode(dir, { answer: (m, items) => (/全局写/.test(m) ? items.find(i => i.title === '统一用4') : undefined) });
  const { panel, api, dispose } = activateWith(fake);
  process.env.FAKE_OUT = JSON.stringify({ questions: [CONFLICT_Q] });
  try {
    await api.prompted;
    // 「查什么」的多选框：用默认勾选的（全选）
    fakeVscode.pick = (items, opts) => (opts && opts.canPickMany ? items.filter(i => i.picked && i.id !== 'full') : undefined);
    const r = await fake.commands['reqtree.checkup']();
    assert.strictEqual(r.merged.length, 1);
    assert.ok(fake.shown.includes('需求树体检：合并了 1 条重复规则（都可以在「最近改动」里撤销），有 1 个拿不准的问题等你回答'), fake.shown.join('\n'));
    await panel.asking;
    const note = fake.notes.find(n => /全局写/.test(n.m));
    assert.ok(note.items.some(i => /两条都留着（现在）/.test(i.title)), '拿不准：现在是「两条都留着」，树没改');
    assert.ok(!read(tree).includes('不超过5个'), '改选「统一用4」');
    assert.ok(fs.existsSync(path.join(dir, '.reqtree', 'checkup-report.md')), '写了报告');
  } finally { delete process.env.FAKE_OUT; fakeVscode.pick = null; dispose(); }
});
