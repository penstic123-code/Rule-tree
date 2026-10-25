'use strict';
// 直接改还是问（Q.decide）之外的几种情况：初始化 → 体检 → 撤销的先后、几件事同时发生、模型答偏了。模型一律是假的
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SANDBOX = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reqtree-sandbox-')));
process.env.TEMP = process.env.TMP = process.env.TMPDIR = SANDBOX;
process.env.REQTREE_HOME = path.join(SANDBOX, 'home', '.reqtree');
process.env.CLAUDE_CONFIG_DIR = path.join(SANDBOX, 'claude-config');
const ROOT = path.join(__dirname, '..');
const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
process.env.REQTREE_CLAUDE_CMD = `"${process.execPath}" "${FAKE}"`;

const store = require('../src/store');
const Q = require('../src/questions');
const Init = require('../src/init');
const { runCheckup } = require('../src/checkup');
const { parse, findById } = require('../src/parser');

function project(files) {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'proj-'));
  for (const [f, t] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), t);
  }
  return dir;
}
const read = p => fs.readFileSync(p, 'utf8');
const rulesOf = (treePath, id) => findById(parse(read(treePath)), id).rules.map(r => r.text);
// 体检只查规则（不查记忆和文档），模型换成 ask
const check = (treePath, ask) => runCheckup(treePath, { ask, memory: false, parts: { docs: false } });

// 同一需求里前后两条冲突：模型有把握，默认留后面那条
const sameNodeConflict = (node, older, newer) => ({ questions: [{
  text: `「${older}」和「${newer}」冲突`, sure: true, default: 0, options: [
    { label: '留后面那条', ops: [{ op: 'remove_rule', node, text: older }] },
    { label: '留前面那条', ops: [{ op: 'remove_rule', node, text: newer }] },
    { label: '都留着', ops: [] }],
}] });

// ---------- 先后 ----------

test('先后：初始化 → 体检自动处理 → 撤销体检 → 撤销初始化，每一步都回到上一步的样子', async () => {
  const dir = project({ 'game/city.gd': '', 'game/ui.gd': '' });
  fs.writeFileSync(path.join(dir, '需求树.md'), store.TEMPLATE.replace('- [语气]', '- 街道宽 2 格\n- 街道宽 3 格\n- [语气]'));
  const before = read(path.join(dir, '需求树.md'));
  const r = await Init.initProject(dir, { ask: async () => ({ project: '小猪', nodes: [{ id: 'R1', title: '城市', files: ['game/**'] }], split: [], rules: [{ i: 1, node: 'R1' }, { i: 2, node: 'R1' }] }) });
  assert.strictEqual(r.ai, true);
  const afterInit = read(r.treePath);
  const c = await check(r.treePath, async () => sameNodeConflict('R1', '街道宽 2 格', '街道宽 3 格'));
  assert.ifError(c.error);
  assert.strictEqual(c.questions.length, 0, '同一需求里后写的为准，不问');
  assert.deepStrictEqual(rulesOf(r.treePath, 'R1'), ['街道宽 3 格']);
  assert.ok(store.undoChange(r.treePath, c.auto[0].changeId));
  assert.strictEqual(read(r.treePath), afterInit);
  assert.ok(store.undoChange(r.treePath, r.changeId));
  assert.strictEqual(read(r.treePath), before);
  // 再体检一次：同一个判断处理过（用户撤销了），不再自动改
  const again = await check(r.treePath, async () => sameNodeConflict('P', '街道宽 2 格', '街道宽 3 格'));
  assert.strictEqual(again.auto.length + again.questions.length, 0);
  assert.strictEqual(read(r.treePath), before);
});

test('先后：体检改了初始化生成的需求，再先撤销初始化：树回到初始化前，之后体检那条不能再撤（不会落到同号的别的需求上）', async () => {
  const dir = project({ 'game/city.gd': '' });
  fs.writeFileSync(path.join(dir, '需求树.md'), store.TEMPLATE.replace('- [语气]', '- 街道宽 2 格\n- 街道宽 3 格\n- [语气]'));
  const before = read(path.join(dir, '需求树.md'));
  const r = await Init.initProject(dir, { ask: async () => ({ project: '小猪', nodes: [{ id: 'R1', title: '城市', files: ['game/**'] }], split: [], rules: [{ i: 1, node: 'R1' }, { i: 2, node: 'R1' }] }) });
  const c = await check(r.treePath, async () => sameNodeConflict('R1', '街道宽 2 格', '街道宽 3 格'));
  assert.ok(store.undoChange(r.treePath, r.changeId));
  const restored = read(r.treePath);
  assert.ok(restored.includes('街道宽 2 格') && restored.includes('街道宽 3 格'), '回到初始化前（两条都在）');
  assert.strictEqual(restored.replace(/\r\n/g, '\n'), before.replace(/\r\n/g, '\n'));
  assert.strictEqual(store.readChanges(r.treePath).find(e => e.id === c.auto[0].changeId).undoable, false, '面板上不再给撤销');
  assert.strictEqual(store.undoChange(r.treePath, c.auto[0].changeId), false);
  assert.strictEqual(read(r.treePath), restored, '模板里也有个 R1，规则不能被加到它上面');
  assert.doesNotThrow(() => parse(read(r.treePath)));
});

// ---------- 同时发生 ----------

test('同时：体检等模型的时候记录员记了一条，体检的自动处理写进去以后这条还在', async () => {
  const dir = project({});
  const treePath = path.join(dir, '需求树.md');
  fs.writeFileSync(treePath, '# P x\n- 段落不超过 4 行\n- 段落不超过 6 行\n');
  const c = await check(treePath, async () => {
    store.applyChange(treePath, [{ op: 'add_rule', node: 'P', text: '标题不加粗' }], { source: '记录员' });
    return sameNodeConflict('P', '段落不超过 4 行', '段落不超过 6 行');
  });
  assert.ifError(c.error);
  assert.deepStrictEqual(rulesOf(treePath, 'P'), ['段落不超过 6 行', '标题不加粗']);
});

test('同时：两个体检同时跑（插件和命令行），同一个判断只改一次，也不会因为第二次「没做成」开着问', async () => {
  const dir = project({});
  const treePath = path.join(dir, '需求树.md');
  fs.writeFileSync(treePath, '# P x\n- 段落不超过 4 行\n- 段落不超过 6 行\n');
  const ask = async () => { await new Promise(r => setTimeout(r, 30)); return sameNodeConflict('P', '段落不超过 4 行', '段落不超过 6 行'); };
  const [a, b] = await Promise.all([check(treePath, ask), check(treePath, ask)]);
  assert.ifError(a.error); assert.ifError(b.error);
  assert.deepStrictEqual(rulesOf(treePath, 'P'), ['段落不超过 6 行']);
  assert.strictEqual(Q.openQuestions(treePath).length, 0);
});

// ---------- 模型答偏 ----------

test('模型答偏（体检）：字段类型不对、ID 不存在、default 越界、规则对不上、多余的键——都安全丢掉，树不动、不问', async () => {
  const dir = project({});
  const treePath = path.join(dir, '需求树.md');
  const TREE = '# P x\n- 段落不超过 4 行\n\n## C1 课\n> 文件：c/**\n- 手账风\n';
  fs.writeFileSync(treePath, TREE);
  const outs = [
    { questions: 'not an array' },
    { questions: [{ text: '没选项' }, { text: 'default 越界', default: 5, options: [{ label: 'a', ops: [{ op: 'remove_rule', node: 'P', text: '段落不超过 4 行' }] }, { label: 'b', ops: [] }] }] },
    { questions: [{ text: '需求不存在', default: 0, options: [{ label: 'a', ops: [{ op: 'remove_rule', node: 'Z9', text: '手账风' }] }, { label: 'b', ops: [] }] }] },
    { questions: [{ text: '规则对不上', default: 0, options: [{ label: 'a', ops: [{ op: 'remove_rule', node: 'C1', text: '树里根本没有这句' }] }, { label: 'b', ops: [] }] }] },
    { questions: [{ text: '不许的操作', default: 0, options: [{ label: 'a', ops: [{ op: 'delete_node', node: 'C1' }] }, { label: 'b', ops: [] }] }] },
    { questions: [{ text: 'ops 不是数组', default: 0, options: [{ label: 'a', ops: 'remove' }, { label: 'b', ops: [] }] }] },
    { questions: null, categories: 'x', memory: 7, docs: {} },
    [],
  ];
  for (const out of outs) {
    const c = await check(treePath, async () => out);
    assert.ifError(c.error);
    assert.strictEqual(read(treePath), TREE, JSON.stringify(out));
    assert.strictEqual(c.questions.length + c.auto.length, 0, JSON.stringify(out));
  }
  assert.strictEqual(Q.readQuestions(treePath).length, 0);
});

function runRecorder(dir, stdout) {
  const jobFile = path.join(dir, `job-${Math.random()}.json`);
  fs.writeFileSync(jobFile, JSON.stringify({ treePath: path.join(dir, '需求树.md'), touched: [], unmapped: [], turns: [{ user: '以后每章结尾加一道思考题', ai: '好的' }] }));
  spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'recorder.js'), jobFile], { encoding: 'utf8', env: { ...process.env, FAKE_OUT: stdout } });
  return store.readRecorderStatus(path.join(dir, '需求树.md'));
}

test('模型答偏（记录员）：JSON 前后带话或代码块照样认；不是 JSON、没有 ops、ops 写成对象，报错不改树；问题格式坏的丢掉、改动照常', () => {
  const TREE = '# P x\n- 段落不超过 4 行\n\n## C1 课\n> 文件：c/**\n';
  const fresh = () => { const dir = project({}); fs.writeFileSync(path.join(dir, '需求树.md'), TREE); return dir; };
  const add = { op: 'add_rule', node: 'C1', text: '每章结尾加一道思考题' };
  {
    const dir = fresh();
    const st = runRecorder(dir, '好的，改动如下：\n```json\n' + JSON.stringify({ ops: [add] }) + '\n```\n');
    assert.ok(st.ok, JSON.stringify(st));
    assert.match(read(path.join(dir, '需求树.md')), /- 每章结尾加一道思考题/);
  }
  for (const bad of ['我觉得没什么要记的', '{"ops": [', JSON.stringify({ result: 'none' }), JSON.stringify({ ops: { op: 'add_rule' } })]) {
    const dir = fresh();
    const st = runRecorder(dir, bad);
    assert.strictEqual(read(path.join(dir, '需求树.md')), TREE, bad);
    assert.ok(st && (st.ok === false || /没有新要求/.test(st.message)), `${bad} → ${JSON.stringify(st)}`);
  }
  {
    const dir = fresh();
    const st = runRecorder(dir, JSON.stringify({ ops: [add], questions: [{ text: '坏的', options: 'x' }, 'y', null] }));
    assert.ok(st.ok, JSON.stringify(st));
    assert.match(read(path.join(dir, '需求树.md')), /- 每章结尾加一道思考题/);
    assert.strictEqual(Q.readQuestions(path.join(dir, '需求树.md')).length, 0);
  }
});
