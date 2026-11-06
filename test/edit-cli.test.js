'use strict';
// edit 命令：面板通过标准输入送 JSON，改规则或撤销，走和 VS Code 扩展同一条 store 路径
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const store = require('../src/store');

const BIN = path.join(__dirname, '..', 'bin', 'ruletree.js');
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ruletree-edit-')));
process.on('exit', () => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });

let n = 0;
function project() {
  const dir = path.join(base, `项目 ${++n}`);
  const rules = path.join(dir, '.claude', 'rules', 'ruletree');
  fs.mkdirSync(rules, { recursive: true });
  fs.writeFileSync(path.join(rules, 'R1-源码.md'), '---\npaths:\n  - "src/**"\n---\n# R1 源码 🔨\n- 先写测试\n');
  fs.writeFileSync(path.join(rules, 'R2-文档.md'), '---\npaths:\n  - "docs/**"\n---\n# R2 文档 🔨\n- 写短句\n');
  return { dir, rules };
}
const edit = (dir, input) => {
  const r = spawnSync('node', [BIN, 'edit', dir, '--json'], { input: JSON.stringify(input), encoding: 'utf8' });
  return { code: r.status, out: JSON.parse(r.stdout) };
};
const read = (rules, f) => fs.readFileSync(path.join(rules, f), 'utf8');

test('applies an op and records it as undoable', () => {
  const { dir, rules } = project();
  const r = edit(dir, { ops: [{ op: 'add_rule', node: 'R1', text: '小步提交' }] });
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(r.out, { ok: true, result: 'done' });
  assert.match(read(rules, 'R1-源码.md'), /- 小步提交/);
  const changes = store.changeSummaries(dir, 1);
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0].undoable, true);
  // 撤销后规则没了
  assert.strictEqual(edit(dir, { undo: changes[0].id }).out.result, 'done');
  assert.doesNotMatch(read(rules, 'R1-源码.md'), /小步提交/);
});

test('rejects an op outside the list', () => {
  const { dir, rules } = project();
  const before = read(rules, 'R1-源码.md');
  const r = edit(dir, { ops: [{ op: 'delete_node', node: 'R1' }] });
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.out.ok, false);
  assert.strictEqual(read(rules, 'R1-源码.md'), before);
  assert.strictEqual(store.changeSummaries(dir, 5).length, 0);
});

test('reports nochange when the op does nothing', () => {
  const { dir } = project();
  const r = edit(dir, { ops: [{ op: 'remove_rule', node: 'R9', text: '没有这个需求' }] });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.out.result, 'nochange');
  assert.ok(r.out.message);
});

test('reports a partial undo', () => {
  const { dir, rules } = project();
  // 一条改动动了两个文件；其中一个随后被手改同一行，那个撤不回去，另一个能撤
  edit(dir, { ops: [{ op: 'add_rule', node: 'R1', text: '甲规则' }, { op: 'add_rule', node: 'R2', text: '乙规则' }] });
  const id = store.changeSummaries(dir, 1)[0].id;
  fs.writeFileSync(path.join(rules, 'R2-文档.md'), read(rules, 'R2-文档.md').replace('- 乙规则', '- 乙规则（手改）'));
  const r = edit(dir, { undo: id });
  assert.strictEqual(r.out.result, 'partial');
  assert.ok(r.out.message);
  assert.doesNotMatch(read(rules, 'R1-源码.md'), /甲规则/);
});

test('undo of an unknown id fails with a message', () => {
  const { dir } = project();
  const r = edit(dir, { undo: 'nope' });
  assert.strictEqual(r.out.result, 'failed');
  assert.ok(r.out.message);
});

test('edit messages follow the project language', () => {
  const dir = path.join(base, 'english project');
  const rules = path.join(dir, '.claude', 'rules', 'ruletree');
  fs.mkdirSync(rules, { recursive: true });
  fs.writeFileSync(path.join(rules, 'R1-Src.md'), '---\npaths:\n  - "src/**"\n---\n# R1 Src 🔨\n- Write tests first\n');
  const r = edit(dir, { ops: [{ op: 'add_rule', node: 'R1', text: 'Write tests first' }] });
  assert.strictEqual(r.out.result, 'nochange');
  assert.ok(!/[一-鿿]/.test(r.out.message), r.out.message);
  const z = project();
  assert.match(edit(z.dir, { ops: [{ op: 'add_rule', node: 'R1', text: '先写测试' }] }).out.message, /同样的规则/);
});
