'use strict';
// 独立审查找出的问题（2026-10-22）：每条先写测试、确认旧代码不过，再修。模型一律用假的 claude
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SANDBOX = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reqtree-sandbox-')));
process.env.TEMP = process.env.TMP = process.env.TMPDIR = SANDBOX;
process.env.REQTREE_HOME = path.join(SANDBOX, 'home', '.reqtree');
const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'hooks', 'hook.js');
const RECORDER = path.join(ROOT, 'hooks', 'recorder.js');
const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');

const P = require('../src/parser');
const store = require('../src/store');

const TREE = `# P 项目
- 每章结尾都加一道思考题

## C1 课 🔨
> 文件：c/**
- 每章练习题不超过 5 道并带解析

### C1.2 第2章
> 文件：c/ch02*.html
`;

function project(text = TREE) {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'proj-'));
  fs.writeFileSync(path.join(dir, '需求树.md'), text);
  return { dir, tree: path.join(dir, '需求树.md') };
}
const read = f => fs.readFileSync(f, 'utf8');

// ---------- 1. 例外被去重吞掉 ----------

test('1. 下级写和上级相似、但数字不同的规则：不当重复吞掉，改成覆盖（两边自动补同一个键）', () => {
  const r = P.applyOps(TREE, [{ op: 'add_rule', node: 'C1.2', text: '每章练习题不超过 3 道并带解析' }]);
  assert.strictEqual(r.applied.length, 1, '被当成重复吞掉了');
  assert.strictEqual(r.applied[0].op, 'override_rule');
  assert.match(r.text, /^- \[改写1\] 每章练习题不超过 5 道并带解析$/m);
  assert.match(r.text, /### C1\.2 第2章\n> 文件：c\/ch02\*\.html\n- \[改写1\] 每章练习题不超过 3 道并带解析/);
  // 能撤销回原样
  const undo = r.applied.flatMap(o => o.undo);
  assert.strictEqual(P.applyOps(r.text, undo).text, TREE);
});

test('1. 同一个需求里只改了数字：以最新为准改写那条（不是吞掉，也不是并存）', () => {
  const r = P.applyOps(TREE, [{ op: 'add_rule', node: 'C1', text: '每章练习题不超过 8 道并带解析' }]);
  assert.strictEqual(r.applied.length, 1);
  assert.strictEqual(r.applied[0].op, 'replace_rule');
  assert.match(r.text, /^- 每章练习题不超过 8 道并带解析$/m);
  assert.ok(!r.text.includes('5 道'));
});

test('1. 真正的重复照样跳过：下级重说一遍上级的规则、同一需求里换个助词', () => {
  assert.strictEqual(P.applyOps(TREE, [{ op: 'add_rule', node: 'C1.2', text: '每章练习题不超过 5 道，并带解析' }]).applied.length, 0);
  assert.strictEqual(P.applyOps(TREE, [{ op: 'add_rule', node: 'C1', text: '每章练习题都不超过 5 道并带解析' }]).applied.length, 0);
  // 否定词不同：意思反了，不算重复
  const t = `# P 项目\n- 段落标题加粗显示\n`;
  const r = P.applyOps(t, [{ op: 'add_rule', node: 'P', text: '段落标题不加粗显示' }]);
  assert.strictEqual(r.applied.length, 1);
  assert.strictEqual(r.applied[0].op, 'replace_rule');
});

// ---------- 2. 短的中文要求被当成废话 ----------

test('2. 很短的中文要求不跳过；只有「好」「继续」这类白名单和短提问跳过', () => {
  const { isTrivial } = require('../hooks/recorder');
  for (const m of ['全用中文', '以后不加粗', '标题别加粗', '别用表情', '不要表情']) assert.strictEqual(isTrivial(m), false, m);
  for (const m of ['好', '好的', '继续', 'ok', '嗯', '/clear', '为啥？', '这是什么?']) assert.strictEqual(isTrivial(m), true, m);
});

// ---------- 3. 子目录里找不到树 ----------

function hook(input, env = {}) {
  const res = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: 's-' + Math.random(), ...input }), encoding: 'utf8', env: { ...process.env, ...env } });
  assert.strictEqual(res.stderr, '', res.stderr);
  return res.stdout;
}

test('3. Claude hook 在子目录里启动也能往上找到需求树', () => {
  const { dir, tree } = project();
  const sub = path.join(dir, 'c', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  hook({ cwd: sub, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'c', 'ch02-a.html') } });
  const acts = store.readActivity(tree, 60000);
  assert.strictEqual(acts.length, 1, '没找到树');
  assert.strictEqual(acts[0].node, 'C1.2');
});

// ---------- 4. remove_rule 不认转述 ----------

test('4. remove_rule：模型转述了原文也能删（同一需求里最像且唯一的一条，≥0.5）；数字不同、两条一样像的不删', () => {
  const r = P.applyOps(TREE, [{ op: 'remove_rule', node: 'C1', text: '练习题不超过5道，带解析' }]);
  assert.strictEqual(r.applied.length, 1);
  assert.ok(!r.text.includes('练习题'));
  assert.strictEqual(P.applyOps(TREE, [{ op: 'remove_rule', node: 'C1', text: '练习题不超过3道，带解析' }]).applied.length, 0, '数字不同是另一条规则');
  const two = `# P 项目\n- 开场用伦敦地图\n- 结尾用伦敦地图\n`;
  assert.strictEqual(P.applyOps(two, [{ op: 'remove_rule', node: 'P', text: '用伦敦地图' }]).applied.length, 0, '两条一样像，不知道删哪条');
});

// ---------- 5. 没写进去的改动看不见 ----------

test('5. applyOps 返回跳过的改动和原因', () => {
  const r = P.applyOps(TREE, [
    { op: 'add_rule', node: 'Z9', text: 'x' },
    { op: 'add_rule', node: 'C1.2', text: '每章练习题不超过 5 道，并带解析' },
    { op: 'remove_rule', node: 'C1', text: '完全无关的一句话' },
  ]);
  assert.deepStrictEqual(r.skipped.map(s => s.reason), ['no-node', 'duplicate', 'no-rule']);
  assert.strictEqual(r.skipped[0].op.node, 'Z9');
});

function runRecorder(dir, out) {
  const jobFile = path.join(dir, `job-${Math.random()}.json`);
  fs.writeFileSync(jobFile, JSON.stringify({ treePath: path.join(dir, '需求树.md'), touched: [], unmapped: [], turns: [{ user: '第2章练习题最多三道', ai: '好' }] }));
  spawnSync(process.execPath, [RECORDER, jobFile], { encoding: 'utf8', env: { ...process.env, REQTREE_CLAUDE_CMD: `"${process.execPath}" "${FAKE}"`, FAKE_OUT: JSON.stringify(out) } });
  return store.readRecorderStatus(path.join(dir, '需求树.md'));
}

test('5. 记录员：没写进去的改动（找不到需求、被筛掉的操作）写进状态，面板能看到', () => {
  const { dir } = project();
  const s = runRecorder(dir, { ops: [{ op: 'add_rule', node: 'Z9', text: '找不到的需求' }, { op: 'delete_node', node: 'C1' }] });
  assert.ok(s.ok, JSON.stringify(s));
  const part = s.parts.find(p => p.k === 'rec.skipped');
  assert.ok(part, JSON.stringify(s.parts));
  assert.strictEqual(part.a[0], 2);
  assert.match(s.message, /2 条没写进去：/);
  assert.match(s.message, /删除需求 C1（记录员不许做这种改动）/);
  const S = require('../media/strings');
  assert.ok('rec.skipped' in S.zh && 'rec.skipped' in S.en);
  const log = read(path.join(SANDBOX, 'reqtree', 'recorder.log'));
  assert.match(log, /没写进去：给 Z9 加规则「找不到的需求」（找不到这个需求）/);
});

// ---------- 6. 机器消息前面带了一段说明 ----------

test('6. 机器消息：标记不在最开头（前面有「[SYSTEM NOTIFICATION…]」）也认得出', () => {
  const { isMachinePrompt } = require('../src/mention');
  assert.strictEqual(isMachinePrompt('[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event\n<task-notification>x</task-notification>'), true);
  assert.strictEqual(isMachinePrompt('第3章怎么设计'), false);
  assert.strictEqual(isMachinePrompt('x'.repeat(400) + '<task-notification>'), false, '很靠后的不算');
});

// ---------- 7. 编译失败只有面板看得到 ----------

test('7. 编译失败：写进 hook.log；下一句话时给 AI 一行提醒（每次失败只提醒一次）', () => {
  const { dir } = project();
  fs.mkdirSync(path.join(dir, '.claude', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'rules', 'reqtree'), 'x'); // 规则目录被一个文件占着，编译必然失败
  const session = 's-compile';
  const out = hook({ cwd: dir, session_id: session, hook_event_name: 'UserPromptSubmit', prompt: '随便聊聊' });
  assert.match(out, /需求树编译失败/, out);
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /规则可能是旧的/);
  const again = hook({ cwd: dir, session_id: session, hook_event_name: 'UserPromptSubmit', prompt: '再聊聊' });
  assert.ok(!/编译失败/.test(again), '同一次失败只提醒一次');
  assert.match(read(path.join(SANDBOX, 'reqtree', 'hook.log')), /编译失败/);
});

// ---------- 9. 共用的小模块 ----------

test('9. 共用：临时目录、isRoot、EDIT_TOOLS、findTreeUp 只有一份', () => {
  const C = require('../src/common');
  assert.strictEqual(C.tmpDir(), path.join(os.tmpdir(), 'reqtree'));
  assert.ok(C.EDIT_TOOLS.has('Edit'));
  const { dir, tree } = project();
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  assert.strictEqual(C.findTreeUp(path.join(dir, 'a', 'b')), tree);
  assert.strictEqual(require('../hooks/codex-hook').findTreeUp, C.findTreeUp);
  for (const f of ['hooks/hook.js', 'hooks/codex-hook.js', 'hooks/recorder.js', 'src/mention.js', 'src/compile.js', 'src/targets/codex.js']) {
    const src = read(path.join(ROOT, f));
    assert.ok(!/const isRoot = /.test(src), `${f} 还有自己的 isRoot`);
    assert.ok(!/path\.join\(os\.tmpdir\(\), 'reqtree'/.test(src), `${f} 还有自己的临时目录`);
  }
});

test('9. describe 由 describeParts 拼出来（一份数据）', () => {
  const { describe, describeParts } = require('../hooks/recorder');
  const src = read(RECORDER);
  const body = src.slice(src.indexOf('function describe('), src.indexOf('\n}\n', src.indexOf('function describe(')));
  assert.ok(body.includes('describeParts('), 'describe 应该用 describeParts');
  assert.strictEqual(describe([{ op: 'add_rule', node: 'C1' }], 0), '记下 1 条');
  assert.deepStrictEqual(describeParts([], 0), [{ k: 'rec.none', a: [] }]);
});
