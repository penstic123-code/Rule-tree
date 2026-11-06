'use strict';
// setup 命令和 src/propose.js：AI 提出的第一棵树怎么检查、怎么写成规则文件
require('./helpers'); // 先建沙盒（init 会碰 ~/.ruletree）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { validate, apply } = require('../src/propose');
const { snapshot } = require('../src/snapshot');
const store = require('../src/store');

const BIN = path.join(__dirname, '..', 'bin', 'ruletree.js');
const fx = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'proposals', name + '.json'), 'utf8'));
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ruletree-propose-')));
process.on('exit', () => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });

let n = 0;
function app(files = ['src/server.js', 'src/routes/a.js', 'src/routes/b.js', 'src/db.js', 'src/cache.js', 'test/a.test.js']) {
  const dir = path.join(base, 'p' + ++n);
  for (const f of files) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), '// x\n'); }
  return dir;
}
const ruleNames = dir => [...store.readFiles(dir).keys()].sort();

test('rejects a path that matches no file', () => {
  const r = validate(app(), fx('no-match'));
  assert.strictEqual(r.ok, false);
  assert.ok(r.problems.some(p => p.includes('nowhere/**')), r.problems.join('\n'));
});
test('rejects a child whose paths fall outside its parent', () => {
  const r = validate(app(), fx('child-outside'));
  assert.strictEqual(r.ok, false);
  assert.ok(r.problems.some(p => p.includes('R1.1') && p.includes('R1')), r.problems.join('\n'));
});
test('rejects a one-level tree in a project with more than one area', () => {
  const r = validate(app(), fx('one-level'));
  assert.strictEqual(r.ok, false);
  assert.ok(r.problems.some(p => /sub-requirement|one level/i.test(p)), r.problems.join('\n'));
});
test('rejects malformed proposals without throwing', () => {
  const dir = app();
  for (const bad of [null, {}, { requirements: [] }, { requirements: [{ id: 'x y', title: '', paths: [] }] }, { requirements: [{ id: 'R1', title: 'A', paths: ['../x'] }] }]) {
    assert.strictEqual(validate(dir, bad).ok, false);
  }
});
test('applies a valid proposal and the map shows it', () => {
  const dir = app();
  const p = fx('flat-app');
  assert.deepStrictEqual(validate(dir, p), { ok: true, problems: [] });
  apply(dir, p);
  const top = p.requirements.filter(r => !r.id.includes('.')).length;
  assert.strictEqual(snapshot(dir).overview.blocks.length, top);
  assert.ok(top > 1);
});
test('writes files in the exact existing format', () => {
  const dir = app();
  apply(dir, fx('flat-app'));
  const files = store.readFiles(dir);
  const child = files.get('R1.1-Routes.md');
  assert.strictEqual(child, '---\npaths:\n  - "src/routes/**"\n---\n# R1.1 Routes\nParent: R1 Server\n- Every route returns JSON\n');
  assert.strictEqual(files.get('R1-Server.md'), '---\npaths:\n  - "src/server.js"\n  - "src/routes/**"\n---\n# R1 Server 🔨\n');
  assert.ok(files.has('_root.md'));
});
test('a project with no rules and no hint gets English; a chosen language is used', () => {
  const en = app(); apply(en, fx('flat-app'));
  assert.ok(!/[一-鿿]/.test(fs.readFileSync(path.join(store.rulesDir(en), '_guide.md'), 'utf8')));
  const zh = app(); apply(zh, fx('flat-app-zh'));
  assert.strictEqual(store.readFiles(zh).get('R1.1-路由.md'), '---\npaths:\n  - "src/routes/**"\n---\n# R1.1 路由\n上级：R1 服务端\n- 所有路由返回 JSON\n');
  assert.ok(/[一-鿿]/.test(fs.readFileSync(path.join(store.rulesDir(zh), '_guide.md'), 'utf8')));
});
test('refuses to overwrite a project that already has rules', () => {
  const dir = app();
  apply(dir, fx('flat-app'));
  const before = ruleNames(dir);
  assert.strictEqual(validate(dir, fx('flat-app')).ok, false);
  assert.throws(() => apply(dir, fx('flat-app')), /already/i);
  assert.deepStrictEqual(ruleNames(dir), before);
});
test('a folder of documents works', () => {
  const dir = app(['notes/a.md', 'notes/b.md', 'plans/q1.md', 'plans/q2.md', 'README.md']);
  const p = { requirements: [
    { id: 'R1', title: 'Notes', paths: ['notes/**'] },
    { id: 'R2', title: 'Plans', paths: ['plans/**'] },
    { id: 'R2.1', title: 'Q1', paths: ['plans/q1.md'] },
  ] };
  assert.strictEqual(validate(dir, p).ok, true);
});
test('setup command: reads stdin, writes rules, installs allow rule only', () => {
  const dir = app();
  const run = input => spawnSync(process.execPath, [BIN, 'setup', dir, '--json'], { input: JSON.stringify(input), encoding: 'utf8' });
  const bad = run(fx('no-match'));
  assert.strictEqual(bad.status, 1);
  assert.strictEqual(JSON.parse(bad.stdout).ok, false);
  assert.strictEqual(store.hasRules(dir), false);
  const ok = run(fx('flat-app'));
  assert.strictEqual(ok.status, 0, ok.stderr);
  const out = JSON.parse(ok.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.blocks, 3);
  const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8'));
  assert.ok(settings.permissions.allow.length && !settings.hooks);
  assert.strictEqual(run(fx('flat-app')).status, 1); // 第二次不覆盖
});
test('setup command: --proposal reads a file (works from any shell)', () => {
  const dir = app();
  const f = path.join(base, 'proposal.json');
  fs.writeFileSync(f, JSON.stringify(fx('flat-app')));
  const r = spawnSync(process.execPath, [BIN, 'setup', '--json', '--proposal', f], { cwd: dir, input: '', encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).blocks, 3);
  assert.ok(store.hasRules(dir));
});
