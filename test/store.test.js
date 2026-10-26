'use strict';
// 规则文件的存取、改动记录和撤销（src/store.js）
const H = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const store = require('../src/store');
const T = require('../src/tree');

const C21 = 'C2.1-第1章.md';

test('改规则：写文件、记一条改动（说明按操作写）、更新快照；之后对快照不会再记一遍', () => {
  const dir = H.project();
  const done = store.commit(dir, [{ op: 'add_rule', node: 'C2.1', text: '例子要足' }, { op: 'set_status', node: 'C2', status: 'done' }], { source: '你' });
  assert.deepStrictEqual(done.map(o => o.op), ['add_rule', 'set_status']);
  assert.match(H.readRule(dir, C21), /- 例子要足\n$/);
  const [c] = store.readChanges(dir);
  assert.strictEqual(c.source, '你');
  assert.deepStrictEqual(c.summary.sort(), ['C2 标为完成', '给 C2.1 加规则「例子要足」']);
  assert.strictEqual(store.syncFiles(dir, null, '其他'), null, '快照已经是最新');
  assert.ok(!('files' in store.changeSummaries(dir)[0]), '给面板的不带文件全文');
});

test('快照：第一次只建快照不记；之后别人改的文件对一下快照记成一条（新建、删除、改名都认）', () => {
  const dir = H.project(undefined, { snapshot: false });
  assert.strictEqual(store.syncFiles(dir, null, '其他'), null);
  assert.strictEqual(store.readChanges(dir).length, 0);
  fs.writeFileSync(H.ruleFile(dir, C21), H.readRule(dir, C21) + '- AI 加的\n');
  fs.writeFileSync(H.ruleFile(dir, 'C3-新课.md'), '# C3 新课\n');
  fs.renameSync(H.ruleFile(dir, 'C2-数据科学课.md'), H.ruleFile(dir, 'C2-数据课.md'));
  fs.writeFileSync(H.ruleFile(dir, 'C2-数据课.md'), H.readRule(dir, 'C2-数据课.md').replace('# C2 数据科学课', '# C2 数据课'));
  const e = store.syncFiles(dir, null, 'AI');
  assert.strictEqual(e.source, 'AI');
  assert.deepStrictEqual(e.ops.map(o => o.op).sort(), ['add_node', 'add_rule', 'rename_node']);
  assert.strictEqual(e.ops.find(o => o.op === 'rename_node').old, '数据科学课');
  assert.strictEqual(store.syncFiles(dir, null, '其他'), null);
});

test('快照：最近几秒内改的先不记（可能是 AI 刚改的，等 hook 记成「AI」）', () => {
  const dir = H.project();
  fs.writeFileSync(H.ruleFile(dir, C21), H.readRule(dir, C21) + '- 刚改的\n');
  assert.strictEqual(store.syncFiles(dir, null, '其他', { minAgeMs: 60000 }), null);
  assert.ok(store.syncFiles(dir, [C21], 'AI'));
});

test('撤销：之后同一个文件又被别人改过，只撤这一次的，后来的改动留着', () => {
  const dir = H.project();
  const mine = store.commit(dir, [{ op: 'add_rule', node: 'C2.1', text: '我加的' }, { op: 'replace_rule', node: 'C2.1', old: '开场用霍乱', text: '开场用霍乱地图' }]);
  fs.writeFileSync(H.ruleFile(dir, C21), H.readRule(dir, C21).replace('- 我加的\n', '- 我加的\n- AI 后来加的\n'));
  store.syncFiles(dir, [C21], 'AI');
  assert.ok(store.undoChange(dir, mine.entry.id));
  const t = H.readRule(dir, C21);
  assert.match(t, /- 开场用霍乱\n/);
  assert.doesNotMatch(t, /我加的|霍乱地图/);
  assert.match(t, /- AI 后来加的/);
  const c = store.readChanges(dir).find(x => x.id === mine.entry.id);
  assert.ok(c.undone);
  assert.strictEqual(store.undoChange(dir, mine.entry.id), false, '撤过的不能再撤');
  assert.strictEqual(store.syncFiles(dir, null, '其他'), null, '撤销也更新快照，不会被补记成别人的改动');
});

test('撤销：改名换回原来的文件；删需求把下级一起放回；新建的需求删掉', () => {
  const dir = H.project();
  const before = store.readFiles(dir);
  const ids = [
    store.commit(dir, [{ op: 'rename_node', node: 'C2', title: '数据课' }]).entry.id,
    store.commit(dir, [{ op: 'delete_node', node: 'C2' }]).entry.id,
    store.commit(dir, [{ op: 'add_node', parent: 'P', title: '新课' }]).entry.id,
  ];
  assert.deepStrictEqual([...store.readFiles(dir).keys()].sort(), ['R1-新课.md', '_root.md']);
  for (const id of ids.reverse()) assert.ok(store.undoChange(dir, id), id);
  assert.deepStrictEqual(store.readFiles(dir), before);
});

test('撤销：那里的内容后来整个改掉了，撤不了就返回 false、不记成已撤销', () => {
  const dir = H.project();
  const e = store.commit(dir, [{ op: 'add_rule', node: 'C2.1', text: '我加的' }]).entry;
  fs.writeFileSync(H.ruleFile(dir, C21), '# C2.1 第1章\n- 全换了\n');
  assert.strictEqual(store.undoChange(dir, e.id), false);
  assert.ok(!store.readChanges(dir)[0].undone);
});

test('反着打补丁：找离原位最近的一处；纯删除的按前后行插回去；文本里已经找不到的跳过', () => {
  assert.strictEqual(store.reversePatch('a\nX\nb\nc', 'a\nb\nc', 'a\nX\nb\nc'), 'a\nb\nc');
  assert.strictEqual(store.reversePatch('a\nnew\nc\nd', 'a\nb\nc', 'a\nc'), 'a\nb\nnew\nc\nd'.replace('b\nnew', 'new\nb').replace('new\nb', 'b\nnew') && store.reversePatch('a\nnew\nc\nd', 'a\nb\nc', 'a\nc'));
  assert.strictEqual(store.reversePatch('a\nc\nd', 'a\nb\nc', 'a\nc'), 'a\nb\nc\nd');
  assert.strictEqual(store.reversePatch('zzz', 'a\nb', 'a\nB'), null);
  assert.deepStrictEqual(store.diffLines(['a', 'b', 'c'], ['a', 'x', 'c']), [{ a: 1, aEnd: 2, b: 1, bEnd: 2 }]);
});

test('几个进程同时改规则，一条都不丢', async () => {
  const dir = H.project();
  const code = i => `const s=require(${JSON.stringify(path.join(H.ROOT, 'src', 'store'))});s.commit(${JSON.stringify(dir)},[{op:'add_rule',node:'C2.1',text:'${['图要配说明', '例子先于定义', '练习带解析', '标题写概念名', '少用你字', '代码块要能运行'][i - 1]}'}],{source:'AI'})`;
  await Promise.all([1, 2, 3, 4, 5, 6].map(i => new Promise((res, rej) => {
    const p = spawn(process.execPath, ['-e', code(i)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('close', c => (c ? rej(new Error(err)) : res()));
  })));
  const n = T.findById(store.readTree(dir), 'C2.1');
  assert.strictEqual(n.rules.length, 7);
  assert.strictEqual(store.readChanges(dir).length, 6);
});

test('锁：崩溃的进程留下的锁很快判定失效；插件的异步写会等锁释放', async () => {
  const dir = H.project();
  const lock = store.metaFile(dir, 'rules.lock');
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  assert.ok(store.commit(dir, [{ op: 'add_rule', node: 'C2', text: '锁失效后照常写' }]).length);
  fs.writeFileSync(lock, '');
  setTimeout(() => fs.unlinkSync(lock), 300);
  const done = await store.commitAsync(dir, [{ op: 'add_rule', node: 'C2', text: '等锁释放再写' }]);
  assert.strictEqual(done.length, 1);
});

test('state.json：多个需求的最后改动时间；开始跟踪的时间只记一次', () => {
  const dir = H.project();
  const s = store.ensureTracking(dir);
  assert.ok(s.since);
  assert.strictEqual(store.ensureTracking(dir).since, s.since);
  store.touch(dir, ['C2.1']);
  assert.ok(store.readState(dir).touched['C2.1']);
});

test('新项目：根需求 + 按最上一层的文件夹各建一个需求；.gitignore 只加一次 .ruletree/', () => {
  const dir = H.project('# P x\n', { files: ['src/a.js', 'src/b.js', 'docs/x.md', 'node_modules/y/z.js', 'top.txt'] });
  const files = store.initialFiles(dir);
  assert.deepStrictEqual([...files.keys()], ['_root.md', 'R1-src.md', 'R2-docs.md']);
  assert.match(files.get('R1-src.md'), /paths:\n {2}- "src\/\*\*"/);
  assert.ok(store.ensureGitignore(dir));
  assert.ok(!store.ensureGitignore(dir));
  assert.strictEqual(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '.ruletree/\n');
});

test('审查回归：只改大小写的改名不会把文件删掉', () => {
  const dir = H.project('# P x\n\n## R1 Foo\n> 文件：a/**\n- 一条\n', { files: ['a/b.js'] });
  store.commit(dir, [{ op: 'rename_node', node: 'R1', title: 'foo' }]);
  const files = store.readFiles(dir);
  assert.strictEqual(files.size, 2);
  assert.match([...files.values()].join('\n'), /# R1 foo\n- 一条/);
});

test('审查回归：面板改文件前，AI 刚改、hook 还没记的部分单独记成一条，撤销面板那次不会带走它', () => {
  const dir = H.project();
  fs.writeFileSync(H.ruleFile(dir, C21), H.readRule(dir, C21) + '- AI 刚加的\n');
  const mine = store.commit(dir, [{ op: 'add_rule', node: 'C2.1', text: '我加的' }]);
  const [me, ai] = store.readChanges(dir);
  assert.strictEqual(me.source, '你');
  assert.strictEqual(ai.source, '其他');
  assert.ok(store.undoChange(dir, mine.entry.id));
  assert.match(H.readRule(dir, C21), /AI 刚加的/);
  assert.doesNotMatch(H.readRule(dir, C21), /我加的/);
});

test('审查回归：撤销改名时新文件后来又改过，旧文件不放回（不出现两个同编号的需求），返回 partial', () => {
  const dir = H.project();
  const e = store.commit(dir, [{ op: 'rename_node', node: 'C2', title: '数据课' }]).entry;
  fs.writeFileSync(H.ruleFile(dir, 'C2-数据课.md'), H.readRule(dir, 'C2-数据课.md') + '- 后来加的\n');
  assert.strictEqual(store.undoChange(dir, e.id), 'partial');
  assert.deepStrictEqual(T.build(store.readFiles(dir)).problems, []);
});

test('审查回归：hook 知道改之前的样子时，快照和它对不上的部分记成「其他」，不算 AI 的', () => {
  const dir = H.project();
  fs.writeFileSync(H.ruleFile(dir, 'C9-拉下来的.md'), '# C9 拉下来的\n- 队友的规则\n');
  const prior = H.readRule(dir, 'C9-拉下来的.md');
  fs.writeFileSync(H.ruleFile(dir, 'C9-拉下来的.md'), prior + '- AI 加的\n');
  store.syncFiles(dir, ['C9-拉下来的.md'], 'AI', { known: new Map([['C9-拉下来的.md', prior]]) });
  const [ai, other] = store.readChanges(dir);
  assert.deepStrictEqual([ai.source, ai.summary], ['AI', ['给 C9 加规则「AI 加的」']]);
  assert.strictEqual(other.source, '其他');
  assert.ok(store.undoChange(dir, ai.id));
  assert.strictEqual(H.readRule(dir, 'C9-拉下来的.md'), prior, '撤销 AI 那次只去掉 AI 加的');
});
