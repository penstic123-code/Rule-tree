'use strict';
// 规则文件的读写（src/tree.js）：文件格式、层级、编辑操作
const test = require('node:test');
const assert = require('node:assert');
const T = require('../src/tree');

const files = obj => new Map(Object.entries(obj));
const BASE = {
  '_root.md': '# P 项目\n全项目的说明\n- 每个段落都不超过 4 行\n',
  'R1-课程.md': '---\npaths:\n  - "course/**"\n---\n# R1 课程 🔨\n文档：docs/design.md#六、体检自动化, docs/b.md（改结构前读）\n- 不引原话\n- 决定：用中文，因为读者是中国学生\n',
  'R1.1-第1章.md': '---\npaths: ["course/ch01-*.html", \'course/ch01.css\']\n---\n# R1.1 第1章 ⏳\n上级：R1 课程\n- 开场用霍乱\n',
  'R2-工具.md': '---\npaths: tools/**\n---\n# R2 工具\n',
};

test('读：文件头的 paths（列表、行内数组、单个字符串）、标题和状态、文档（节名里的顿号不拆、括号说明去掉）、规则和「决定」', () => {
  const root = T.build(files(BASE));
  const P = root.children[0];
  assert.strictEqual(P.id, 'P');
  assert.deepStrictEqual(P.rules.map(r => r.text), ['每个段落都不超过 4 行']);
  assert.deepStrictEqual(P.notes, ['全项目的说明']);
  const r1 = T.findById(root, 'R1');
  assert.deepStrictEqual(r1.files, ['course/**']);
  assert.strictEqual(r1.status, 'doing');
  assert.deepStrictEqual(r1.docs, ['docs/design.md#六、体检自动化', 'docs/b.md']);
  assert.deepStrictEqual(r1.rules.map(r => r.decision), [false, true]);
  const c1 = T.findById(root, 'R1.1');
  assert.deepStrictEqual(c1.files, ['course/ch01-*.html', 'course/ch01.css']);
  assert.strictEqual(c1.parent, r1, '层级看编号，「上级：」一行不算规则');
  assert.deepStrictEqual(c1.rules.map(r => r.text), ['开场用霍乱']);
  assert.deepStrictEqual(T.findById(root, 'R2').files, ['tools/**']);
  assert.ok(T.isRoot(P) && !T.isRoot(r1));
});

test('读：编号重复、上级不存在、没有编号都报出来；没有 _root.md 时有个空的根；_guide.md 不算需求；编号自然排序', () => {
  const root = T.build(files({
    '_guide.md': '# 说明书\n- 不是规则\n',
    'R10-十.md': '# R10 十\n', 'R2-二.md': '# R2 二\n', 'R2-重复.md': '# R2 重复\n',
    'R5.1-孤儿.md': '# R5.1 孤儿\n', 'readme.md': '没有标题\n', 'R7-只看文件名.md': '- 规则\n',
  }));
  const P = root.children[0];
  assert.strictEqual(P.id, 'P');
  assert.deepStrictEqual(P.children.map(n => n.id), ['R2', 'R5.1', 'R7', 'R10']);
  assert.deepStrictEqual(root.problems.map(p => p.k).sort(), ['dupId', 'noId', 'noParent']);
  assert.strictEqual(T.findById(root, 'R7').rules.length, 1, '标题行没写编号就从文件名取');
});

test('glob：** 任意层、* 不跨文件夹、{a,b}、按文件找需求从浅到深（根需求不算）', () => {
  assert.ok(T.matchesAny(['a/**'], 'a/b/c.js'));
  assert.ok(T.matchesAny(['**/*.md'], 'x.md') && T.matchesAny(['**/*.md'], 'a/b/x.md'));
  assert.ok(!T.matchesAny(['a/*.js'], 'a/b/c.js'));
  assert.ok(T.matchesAny(['c/{ch18,ch19}-*.html'], 'c/ch19-x.html') && !T.matchesAny(['c/{ch18,ch19}-*.html'], 'c/ch20-x.html'));
  assert.deepStrictEqual(T.splitGlobs('a/**, c/{x,y}.js  d'), ['a/**', 'c/{x,y}.js', 'd']);
  const root = T.build(files(BASE));
  assert.deepStrictEqual(T.nodesForFile(root, 'course/ch01-a.html').map(n => n.id), ['R1', 'R1.1']);
  assert.strictEqual(T.nodeForFile(root, 'course/ch01-a.html').id, 'R1.1');
  assert.strictEqual(T.nodeForFile(root, 'other.js'), null);
});

const apply = (ops, base = BASE) => T.applyOps(files(base), ops);

test('加规则：写在最后一条规则后面；意思一样的跳过；换了数字的改写本需求那条、取代上级那条', () => {
  let r = apply([{ op: 'add_rule', node: 'R1', text: '例子要足' }]);
  assert.match(r.files.get('R1-课程.md'), /- 决定：用中文，因为读者是中国学生\n- 例子要足\n$/);
  r = apply([{ op: 'add_rule', node: 'R1', text: '不引原话。' }, { op: 'add_rule', node: 'R1.1', text: '每个段落不超过 4 行' }]);
  assert.deepStrictEqual(r.skipped.map(s => s.reason), ['duplicate', 'duplicate']);
  r = apply([{ op: 'add_rule', node: 'R1.1', text: '每个段落都不超过 6 行' }]);
  assert.strictEqual(r.applied[0].op, 'override_rule');
  assert.match(r.files.get('R1.1-第1章.md'), /- 每个段落都不超过 6 行（在本范围内取代 P 的「每个段落都不超过 4 行」）/);
  assert.strictEqual(r.files.get('_root.md'), BASE['_root.md'], '上级不动');
  r = apply([{ op: 'add_rule', node: 'R2', text: '第一条' }]);
  assert.match(r.files.get('R2-工具.md'), /# R2 工具\n- 第一条\n$/, '还没有规则时写在标题后面');
});

test('改写、删除规则：原文对不上时找唯一最像的；删除时数字不同的不算', () => {
  let r = apply([{ op: 'replace_rule', node: 'R1', old: '不引原话', text: '不引原话，自己叙述' }]);
  assert.match(r.files.get('R1-课程.md'), /- 不引原话，自己叙述\n/);
  r = apply([{ op: 'remove_rule', node: 'P', text: '每个段落都不超过 5 行' }]);
  assert.strictEqual(r.skipped[0].reason, 'no-rule');
  r = apply([{ op: 'remove_rule', node: 'P', text: '每个段落都不超过4行。' }]);
  assert.doesNotMatch(r.files.get('_root.md'), /段落/);
  r = apply([{ op: 'replace_rule', node: 'R1', old: '不存在的', text: 'x' }]);
  assert.strictEqual(r.skipped[0].reason, 'no-rule');
});

test('新需求：新文件，编号按上级来，沿用上级的范围，写「上级：」；根下面沿用兄弟的字母、不带「上级」', () => {
  let r = apply([{ op: 'add_node', parent: 'R1', title: '第2章' }]);
  assert.strictEqual(r.applied[0].id, 'R1.2');
  assert.strictEqual(r.files.get('R1.2-第2章.md'), '---\npaths:\n  - "course/**"\n---\n# R1.2 第2章\n上级：R1 课程\n');
  r = apply([{ op: 'add_node', parent: 'P', title: 'Docs site', globs: ['site/**'] }]);
  assert.strictEqual(r.applied[0].id, 'R3');
  assert.strictEqual(r.files.get('R3-Docs-site.md'), '---\npaths:\n  - "site/**"\n---\n# R3 Docs site\n');
  r = apply([{ op: 'add_node', parent: 'R1', id: 'R9', title: 'x' }, { op: 'add_node', parent: 'R1', title: '' }]);
  assert.deepStrictEqual(r.skipped.map(s => s.reason), ['bad-id', 'empty']);
});

test('文件范围、文档、状态：改文件头和标题行；根需求不能设范围', () => {
  let r = apply([{ op: 'set_files', node: 'R1.1', globs: ['course/ch01-*.html'] }, { op: 'set_status', node: 'R1.1', status: 'done' }]);
  assert.match(r.files.get('R1.1-第1章.md'), /^---\npaths:\n {2}- "course\/ch01-\*\.html"\n---\n# R1\.1 第1章 ✅\n/);
  r = apply([{ op: 'set_files', node: 'R2', globs: [] }]);
  assert.strictEqual(r.files.get('R2-工具.md'), '# R2 工具\n', '清空范围：文件头整个去掉');
  r = apply([{ op: 'set_files', node: 'P', globs: ['x/**'] }]);
  assert.strictEqual(r.skipped[0].reason, 'root');
  r = apply([{ op: 'set_docs', node: 'R2', docs: ['docs/t.md'] }, { op: 'add_docs', node: 'R1', docs: ['docs/c.md'] }]);
  assert.match(r.files.get('R2-工具.md'), /# R2 工具\n文档：docs\/t\.md\n/);
  assert.match(r.files.get('R1-课程.md'), /文档：docs\/design\.md#六、体检自动化, docs\/b\.md, docs\/c\.md\n/);
  r = apply([{ op: 'set_status', node: 'R1', status: null }]);
  assert.match(r.files.get('R1-课程.md'), /\n# R1 课程\n/);
});

test('改名：标题行和文件名一起改，下级的「上级：」跟着改；删需求连下级一起删；根需求不能删', () => {
  let r = apply([{ op: 'rename_node', node: 'R1', title: '课程总览' }]);
  assert.ok(!r.files.has('R1-课程.md') && r.files.has('R1-课程总览.md'));
  assert.match(r.files.get('R1-课程总览.md'), /# R1 课程总览 🔨/);
  assert.match(r.files.get('R1.1-第1章.md'), /上级：R1 课程总览/);
  assert.strictEqual(r.applied[0].old, '课程');
  r = apply([{ op: 'delete_node', node: 'R1' }, { op: 'delete_node', node: 'P' }]);
  assert.deepStrictEqual([...r.files.keys()].sort(), ['R2-工具.md', '_root.md']);
  assert.strictEqual(r.skipped[0].reason, 'root');
});

test('操作里的换行压成空格（模型传来的「好\\n# X」不会凭空多出一个需求）；不改传进来的那份', () => {
  const input = files(BASE);
  const r = T.applyOps(input, [{ op: 'add_rule', node: 'R2', text: '好\n# R9 注入' }]);
  assert.match(r.files.get('R2-工具.md'), /- 好 # R9 注入\n$/);
  assert.strictEqual(input.get('R2-工具.md'), BASE['R2-工具.md']);
});

test('取代说明：overrideOf 认出取代的是谁的哪一条', () => {
  const pick = o => o && { ref: o.ref, text: o.text };
  assert.deepStrictEqual(pick(T.overrideOf('段落可以到 6 行（在本范围内取代 P 的「段落不超过 4 行」）')), { ref: 'P', text: '段落不超过 4 行' });
  assert.deepStrictEqual(pick(T.overrideOf(`Up to 6 lines (in this scope, replaces P's "At most 4 lines")`)), { ref: 'P', text: 'At most 4 lines' });
  assert.strictEqual(T.overrideText('R1', 'At most 4 lines'), ` (in this scope, replaces R1's "At most 4 lines")`);
  assert.strictEqual(T.overrideOf('普通规则'), null);
  const r = apply([{ op: 'override_rule', node: 'R1.1', from: 'R1', text: '不引原话', new: '可以引一句原话' }, { op: 'override_rule', node: 'R2', from: 'R1', text: '不引原话', new: 'x' }]);
  assert.match(r.files.get('R1.1-第1章.md'), /- 可以引一句原话（在本范围内取代 R1 的「不引原话」）/);
  assert.strictEqual(r.skipped[0].reason, 'not-ancestor');
});

test('Windows 换行的文件改完还是 Windows 换行', () => {
  const r = T.applyOps(new Map([['R1-a.md', '# R1 a\r\n- 一\r\n']]), [{ op: 'add_rule', node: 'R1', text: '二' }]);
  assert.strictEqual(r.files.get('R1-a.md'), '# R1 a\r\n- 一\r\n- 二\r\n');
});

test('英文的规则文件写英文的「上级」「文档」行', () => {
  const r = T.applyOps(new Map([['R1-Payments.md', '# R1 Payments\n- Store money as cents\n']]), [{ op: 'add_node', parent: 'R1', title: 'Refunds' }, { op: 'set_docs', node: 'R1', docs: ['docs/pay.md'] }]);
  assert.strictEqual(r.files.get('R1.1-Refunds.md'), '# R1.1 Refunds\nParent: R1 Payments\n');
  assert.match(r.files.get('R1-Payments.md'), /^# R1 Payments\nDocs: docs\/pay\.md\n/);
  assert.deepStrictEqual(T.build(r.files).children[0].children[0].docs, ['docs/pay.md']);
});

test('审查回归：文件头带 BOM、不缩进的列表、行内数组里的花括号；多行注释里的不算规则', () => {
  const n = T.parseFile('R1-a.md', '\uFEFF---\npaths:\n- "src/**"\n- docs/*.md\n---\n# R1 a\n<!--\n- 注释里的\n-->\n- 真的规则\n');
  assert.deepStrictEqual(n.files, ['src/**', 'docs/*.md']);
  assert.deepStrictEqual(n.rules.map(r => r.text), ['真的规则']);
  assert.deepStrictEqual(T.parseFile('R1-a.md', '---\npaths: ["src/{a,b}.js", \'c/*.md\']\n---\n# R1 a\n').files, ['src/{a,b}.js', 'c/*.md']);
  const r = T.applyOps(new Map([['R1-a.md', '---\npaths:\n- "src/**"\n---\n# R1 a\n']]), [{ op: 'set_files', node: 'R1', globs: ['lib/**'] }]);
  assert.strictEqual(r.files.get('R1-a.md'), '---\npaths:\n  - "lib/**"\n---\n# R1 a\n');
});

test('审查回归：文件没有标题行时，删、改的是对的那条；原文对不上就不改（不去猜最像的）', () => {
  let r = T.applyOps(new Map([['R1-a.md', '- keep me\n- delete me\n']]), [{ op: 'remove_rule', node: 'R1', text: 'delete me' }]);
  assert.strictEqual(r.files.get('R1-a.md'), '# R1\n- keep me\n');
  r = T.applyOps(new Map([['R1-a.md', '- keep me\n- edit me\n']]), [{ op: 'replace_rule', node: 'R1', old: 'edit me', text: 'edited' }]);
  assert.strictEqual(r.files.get('R1-a.md'), '# R1\n- keep me\n- edited\n');
  r = T.applyOps(new Map([['R1-a.md', '# R1 a\n- 标题用红色字体\n']]), [{ op: 'remove_rule', node: 'R1', text: '标题用蓝色字体' }]);
  assert.strictEqual(r.skipped[0].reason, 'no-rule');
});
