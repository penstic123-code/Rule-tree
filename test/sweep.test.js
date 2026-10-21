'use strict';
// 补漏：每 N 轮、压缩前把最近的用户原话再交给记录员查一遍（用假模型，不花额度）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'reqtree-sweep-'));
process.env.TEMP = process.env.TMP = process.env.TMPDIR = SANDBOX;
process.env.REQTREE_HOME = path.join(SANDBOX, 'home', '.reqtree');

const store = require('../src/store');
const { buildSweepPrompt, SWEEP_OPS } = require('../hooks/recorder');
const HOOK = path.join(__dirname, '..', 'hooks', 'hook.js');
const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');

const TREE = `# P 测试项目
- [段落] 段落不超过 4 行

## C2 数据科学课 🔨
> 文件：DataScience/**
- 不引原话

### C2.1 第1章 ⏳
> 文件：DataScience/ch01-*.html
- 开场用霍乱
`;

function project() {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'proj-'));
  fs.writeFileSync(path.join(dir, '需求树.md'), TREE);
  return dir;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (fn()) return true;
  return false;
}
const readLog = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l).input) : []);
const isSweep = p => p.includes('补漏检查');

// 一轮：用户发话（同步 hook）+ 回复结束（Stop），等记录员跑完（假模型每次调用记一行，看 recorder 状态时间变化）
async function turn(dir, env, session, prompt) {
  const run = input => {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: session, cwd: dir, ...input }), encoding: 'utf8', env: { ...process.env, ...env } });
    assert.strictEqual(r.status, 0, r.stderr);
  };
  const tree = path.join(dir, '需求树.md');
  const before = (store.readRecorderStatus(tree) || {}).time || 0;
  run({ hook_event_name: 'UserPromptSubmit', prompt });
  run({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: '好的' });
  assert.ok(await waitFor(() => ((store.readRecorderStatus(tree) || {}).time || 0) > before), `记录员没跑完：${prompt}`);
}
function preCompact(dir, env, session) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'PreCompact', session_id: session, cwd: dir, trigger: 'auto' }), encoding: 'utf8', env: { ...process.env, ...env } });
  assert.strictEqual(r.status, 0, r.stderr);
}
const fakeEnv = (dir, extra = {}) => ({ REQTREE_CLAUDE_CMD: `"${process.execPath}" "${FAKE}"`, FAKE_LOG: path.join(dir, 'fake.log'), REQTREE_SWEEP_EVERY: '3', ...extra });

test('每 3 轮补漏一次：第 3、6 轮多一次补漏调用，带上这 3 轮的原话；其余轮只有单轮判断', async () => {
  const dir = project();
  const env = fakeEnv(dir);
  const msgs = ['第1章开头用霍乱的故事吧', '第2章开头用冰淇淋的例子', '以后例子都要配图', '第3章用地铁图举例', '练习题都带解析', '第4章开场放一张地图'];
  for (let i = 0; i < msgs.length; i++) {
    await turn(dir, env, 's1', msgs[i]);
    const sweeps = readLog(env.FAKE_LOG).filter(isSweep);
    assert.strictEqual(sweeps.length, Math.floor((i + 1) / 3), `第 ${i + 1} 轮后补漏次数`);
  }
  const sweeps = readLog(env.FAKE_LOG).filter(isSweep);
  assert.ok(msgs.slice(0, 3).every(m => sweeps[0].includes(m)) && !sweeps[0].includes(msgs[3]));
  assert.ok(msgs.slice(3).every(m => sweeps[1].includes(m)) && !sweeps[1].includes(msgs[0]), '第二次只查上次之后的');
  assert.strictEqual(readLog(env.FAKE_LOG).filter(p => !isSweep(p)).length, 6, '每轮的单轮判断照常');
  assert.match((store.readRecorderStatus(path.join(dir, '需求树.md')) || {}).message, /补漏查了 3 句/);
});

test('这几轮全是「好」「继续」：到了轮数也不调用模型，计数照样往前走', async () => {
  const dir = project();
  const env = fakeEnv(dir);
  for (const m of ['好', '继续', '好的']) await turn(dir, env, 's2', m);
  assert.strictEqual(readLog(env.FAKE_LOG).length, 0, '短消息既不做单轮判断也不补漏');
  for (const m of ['第5章开头用彩票的例子', '继续', '好']) await turn(dir, env, 's2', m);
  const sweeps = readLog(env.FAKE_LOG).filter(isSweep);
  assert.strictEqual(sweeps.length, 1);
  assert.ok(sweeps[0].includes('彩票') && !/1\. 好\n/.test(sweeps[0]), '只查上次之后的三句');
});

test('补漏不加重复：模型给回树里已有的规则、同键规则，树不变；补漏不能删规则、改状态、设文件', async () => {
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  const out = JSON.stringify({ ops: [
    { op: 'add_rule', node: 'C2', text: '不引原话！' }, // 换说法的重复由模型判断，代码只拦几乎逐字的
    { op: 'add_rule', node: 'C2.1', text: '开场用霍乱。' },
    { op: 'add_rule', node: 'P', key: '段落', text: '段落不超过 4 行' },
    { op: 'remove_rule', node: 'C2', text: '不引原话' },
    { op: 'set_status', node: 'C2.1', status: 'done' },
    { op: 'add_files', node: 'C2.1', globs: ['x/**'] },
  ] });
  const env = fakeEnv(dir, { FAKE_OUT: out });
  // 先攒两句（不到 3 句不补漏），再压缩前补漏（只补漏，不做单轮判断）
  const run = input => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: 's3', cwd: dir, ...input }), encoding: 'utf8', env: { ...process.env, ...env } });
  run({ hook_event_name: 'UserPromptSubmit', prompt: '数据科学课不要引原话' });
  run({ hook_event_name: 'UserPromptSubmit', prompt: '第1章开场用霍乱' });
  preCompact(dir, env, 's3');
  assert.ok(await waitFor(() => store.readRecorderStatus(tree)), '补漏跑完');
  assert.strictEqual(fs.readFileSync(tree, 'utf8'), TREE, '树没变');
  const calls = readLog(env.FAKE_LOG);
  assert.strictEqual(calls.length, 1);
  assert.ok(isSweep(calls[0]) && calls[0].includes('第1章开场用霍乱'));
  assert.match(store.readRecorderStatus(tree).message, /补漏查了 2 句，没有漏的/);
  // 再压缩一次：上次之后没有新的话，不调用
  preCompact(dir, env, 's3');
  await sleep(1500);
  assert.strictEqual(readLog(env.FAKE_LOG).length, 1);
});

test('补漏补上漏记的：模型给出新规则就写进树', async () => {
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  const env = fakeEnv(dir, { FAKE_OUT: JSON.stringify({ ops: [{ op: 'add_rule', node: 'C2.1', text: '霍乱故事里画出斯诺地图' }] }) });
  const run = input => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: 's4', cwd: dir, ...input }), encoding: 'utf8', env: { ...process.env, ...env } });
  run({ hook_event_name: 'UserPromptSubmit', prompt: '第1章霍乱故事里要画出斯诺的那张地图' });
  preCompact(dir, env, 's4');
  assert.ok(await waitFor(() => fs.readFileSync(tree, 'utf8').includes('斯诺地图') && store.readRecorderStatus(tree)));
  assert.match(store.readRecorderStatus(tree).message, /补漏记下 1 条/);
});

test('sweepEvery = 0 关掉补漏；默认 8；状态文件里最多留 20 句、每句 1000 字', async () => {
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  assert.strictEqual(store.readConfig(tree).sweepEvery, 8);
  const env = fakeEnv(dir, { REQTREE_SWEEP_EVERY: '0' });
  for (let i = 0; i < 3; i++) await turn(dir, env, 's5', `第${i + 1}章开头用一个新例子，编号 ${i}`);
  assert.strictEqual(readLog(env.FAKE_LOG).filter(isSweep).length, 0);
  // 状态文件大小
  const run = input => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: 's6', cwd: dir, ...input }), encoding: 'utf8', env: { ...process.env, ...env } });
  for (let i = 0; i < 25; i++) run({ hook_event_name: 'UserPromptSubmit', prompt: `第${i}句` + '长'.repeat(3000) });
  const files = fs.readdirSync(path.join(SANDBOX, 'reqtree')).filter(f => /^[0-9a-f]{32}\.json$/.test(f)).map(f => store.readJson(path.join(SANDBOX, 'reqtree', f), {}));
  const st = files.find(s => (s.recent || []).some(t => t.user.startsWith('第24句')));
  assert.strictEqual(st.recent.length, 20);
  assert.ok(st.recent.every(t => t.user.length <= 1000));
  assert.strictEqual(st.recent[0].user.slice(0, 3), '第5句');
});

test('补漏提示词：列出原话、只许加（不改不删）', () => {
  const p = buildSweepPrompt(TREE, ['第1章开头用霍乱', '把这段改短']);
  assert.match(p, /1\. 第1章开头用霍乱\n2\. 把这段改短/);
  assert.deepStrictEqual([...SWEEP_OPS].sort(), ['add_node', 'add_rule']);
});
