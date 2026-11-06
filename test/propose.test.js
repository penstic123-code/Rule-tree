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
  // src/ 里有 routes 和 models 两个子文件夹：R1 还能拆
  const dir = app(['src/routes/a.js', 'src/models/b.js', 'src/server.js', 'test/a.test.js']);
  const r = validate(dir, fx('one-level'));
  assert.strictEqual(r.ok, false);
  assert.ok(r.problems.some(p => /one level/i.test(p) && p.includes('R1') && p.includes('Source')), r.problems.join(String.fromCharCode(10)));
  // 拆开以后通过
  const split = { requirements: [...fx('one-level').requirements, { id: 'R1.1', title: 'Routes', paths: ['src/routes/**'] }, { id: 'R1.2', title: 'Models', paths: ['src/models/**'] }] };
  assert.strictEqual(validate(dir, split).ok, true);
});
test('flat trees are accepted when no requirement has subfolders to split', () => {
  const mono = app(['packages/a/x.js', 'packages/a/y.js', 'packages/b/x.js', 'package.json']);
  assert.strictEqual(validate(mono, { requirements: [
    { id: 'R1', title: 'A', paths: ['packages/a/**'] }, { id: 'R2', title: 'B', paths: ['packages/b/**'] }, { id: 'R3', title: 'Root', paths: ['package.json'] }] }).ok, true);
  const src = app(['src/a.js', 'src/b.js', 'README.md', 'package.json']);
  assert.strictEqual(validate(src, { requirements: [
    { id: 'R1', title: 'Source', paths: ['src/**'] }, { id: 'R2', title: 'Root files', paths: ['README.md', 'package.json'] }] }).ok, true);
  const docs = app(['notes/a.md', 'notes/b.md', 'plans/q1.md']);
  assert.strictEqual(validate(docs, { requirements: [
    { id: 'R1', title: 'Notes', paths: ['notes/**'] }, { id: 'R2', title: 'Plans', paths: ['plans/**'] }] }).ok, true);
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
test('rejects a title with a newline and an old-style tree file', () => {
  const dir = app();
  assert.strictEqual(validate(dir, { requirements: [{ id: 'R1', title: 'A' + String.fromCharCode(10) + 'B', paths: ['src/db.js'] }] }).ok, false);
  const old = app(); fs.writeFileSync(path.join(old, '需求树.md'), '# old' + String.fromCharCode(10));
  const r = validate(old, { requirements: [{ id: 'R1', title: 'A', paths: ['src/db.js'] }] });
  assert.ok(!r.ok && r.problems.some(p => /old-style/.test(p)), r.problems.join(String.fromCharCode(10)));
  assert.throws(() => apply(old, { requirements: [{ id: 'R1', title: 'A', paths: ['src/db.js'] }] }), /already/);
});
test('language is derived from the text when absent, and a contradicting lang is reported', () => {
  const dir = app();
  const zh = { requirements: [{ id: 'R1', title: '服务端', paths: ['src/server.js'], rules: ['返回 JSON'] }] };
  apply(dir, zh);
  assert.ok(/[一-鿿]/.test(fs.readFileSync(path.join(store.rulesDir(dir), '_guide.md'), 'utf8')));
  assert.ok(/ 服务端/.test([...store.readFiles(dir).values()].join('')));
  assert.strictEqual(require('../src/propose').deriveLang(fx('flat-app')), 'en');
  const d2 = app();
  assert.ok(validate(d2, { lang: 'en', ...zh }).problems.some(p => /lang/.test(p)));
  assert.ok(validate(d2, { ...fx('flat-app'), lang: 'zh' }).problems.some(p => /lang/.test(p)));
  assert.ok(validate(d2, { lang: 'zh', ...zh }).ok);
});
test('a dot folder outside git is matched by paths', () => {
  const dir = app(['.github/workflows/ci.yml', 'src/a.js']);
  assert.strictEqual(validate(dir, { requirements: [{ id: 'R1', title: 'CI', paths: ['.github/**'] }, { id: 'R2', title: 'Src', paths: ['src/**'] }] }).ok, true);
  assert.ok(!require('../src/files').listFiles(dir).some(f => f.startsWith('.github'))); // 其他调用方行为不变
});
test('a failed setup leaves no rules behind and can be rerun after the fix', () => {
  const dir = app();
  const sf = path.join(dir, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(sf), { recursive: true });
  fs.writeFileSync(sf, '{ not json');
  const run = () => spawnSync(process.execPath, [BIN, 'setup', dir, '--json'], { input: JSON.stringify(fx('flat-app')), encoding: 'utf8' });
  const bad = run();
  assert.strictEqual(bad.status, 1);
  assert.strictEqual(JSON.parse(bad.stdout).ok, false);
  assert.strictEqual(store.hasRules(dir), false);
  assert.deepStrictEqual(fs.existsSync(store.rulesDir(dir)) ? fs.readdirSync(store.rulesDir(dir)) : [], []);
  fs.writeFileSync(sf, '{}');
  const ok = run();
  assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
  assert.ok(store.hasRules(dir));
});
test('an existing _guide.md is not overwritten', () => {
  const dir = app();
  fs.mkdirSync(store.rulesDir(dir), { recursive: true });
  fs.writeFileSync(path.join(store.rulesDir(dir), '_guide.md'), 'mine' + String.fromCharCode(10));
  apply(dir, fx('flat-app'));
  assert.strictEqual(fs.readFileSync(path.join(store.rulesDir(dir), '_guide.md'), 'utf8'), 'mine' + String.fromCharCode(10));
});
