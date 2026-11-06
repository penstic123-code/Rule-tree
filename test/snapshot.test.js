'use strict';
// snapshot 命令：插件面板读的一份现状（不依赖 VS Code）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { snapshot } = require('../src/snapshot');

const BIN = path.join(__dirname, '..', 'bin', 'ruletree.js');
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ruletree-snap-')));
process.on('exit', () => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });

const emptyDir = path.join(base, 'empty');
const project = path.join(base, '项目 甲');
fs.mkdirSync(path.join(emptyDir), { recursive: true });
fs.mkdirSync(path.join(project, 'src', 'deep'), { recursive: true });
fs.mkdirSync(path.join(project, '.claude', 'rules', 'ruletree'), { recursive: true });
fs.writeFileSync(path.join(project, '.claude', 'rules', 'ruletree', 'R1-源码.md'), '---\npaths:\n  - "src/**"\n---\n# R1 源码 🔨\n- 先写测试\n');

const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o[k]]));

test('reports a project with no rules as not enabled', () => {
  assert.deepStrictEqual(pick(snapshot(emptyDir), ['enabled', 'nodes']), { enabled: false, nodes: [] });
  assert.deepStrictEqual(fs.readdirSync(emptyDir), []); // 没有规则的项目不创建任何文件
});
test('overview is filled for a project and null when disabled', () => {
  assert.strictEqual(snapshot(emptyDir).overview, null);
  assert.deepStrictEqual(snapshot(project).overview.totals, { done: 0, doing: 1, todo: 0, none: 0 });
});
test('finds the enclosing project from a subfolder', () => {
  assert.strictEqual(snapshot(path.join(project, 'src', 'deep')).dir, project);
});
test('working is the requirement that owns the edited file', () => {
  assert.strictEqual(snapshot(project, { file: path.join(project, 'src', 'a.js') }).working, 'R1');
});
test('a file outside the project leaves working null', () => {
  assert.strictEqual(snapshot(project, { file: path.join(os.tmpdir(), 'x.js') }).working, null);
});
test('handles spaces and Chinese in the path through the CLI', () => {
  const out = JSON.parse(execFileSync('node', [BIN, 'snapshot', project, '--json'], { encoding: 'utf8' }));
  assert.strictEqual(out.enabled, true);
  assert.ok(out.nodes.length > 0);
});
test('the CLI exits 0 with a JSON object when not enabled', () => {
  const out = JSON.parse(execFileSync('node', [BIN, 'snapshot', emptyDir, '--json'], { encoding: 'utf8' }));
  assert.strictEqual(out.enabled, false);
});

test('snapshot carries the project language; a project without rules is English', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const none = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-nolang-'));
  assert.strictEqual(require('../src/snapshot').snapshot(none).lang, 'en');
  const en = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-enlang-'));
  const rules = path.join(en, '.claude', 'rules', 'ruletree');
  fs.mkdirSync(rules, { recursive: true });
  fs.writeFileSync(path.join(rules, 'R1-Src.md'), '# R1 Src 🔨\n- Write tests first\n');
  assert.strictEqual(require('../src/snapshot').snapshot(en).lang, 'en');
  fs.writeFileSync(path.join(rules, 'R2-文档.md'), '# R2 文档 🔨\n- 写短句\n- 先写测试\n');
  assert.strictEqual(require('../src/snapshot').snapshot(en).lang, 'zh');
});
