'use strict';
// 信息架构：挂文档的操作、体检的结构一步（建需求、挂文档、挂章节）、记忆搬进文档、ponytail 按代码文件加载、代码地图的页面脚本
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reqtree-sandbox-')));
process.env.TEMP = process.env.TMP = process.env.TMPDIR = SANDBOX;
process.env.REQTREE_HOME = path.join(SANDBOX, 'home', '.reqtree');
process.env.CLAUDE_CONFIG_DIR = path.join(SANDBOX, 'claude-config');

const store = require('../src/store');
const Q = require('../src/questions');
const P = require('../src/parser');
const Structure = require('../src/structure');
const { runCheckup } = require('../src/checkup');

function project(files) {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'proj-'));
  for (const [f, t] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), t);
  }
  return dir;
}
const read = f => fs.readFileSync(f, 'utf8');
const old = (dir, rel) => { const t = new Date(Date.now() - 200 * 86400000); fs.utimesSync(path.join(dir, rel), t, t); };

test('add_docs：挂在文件行后面，已挂的跳过，节名里的空格不拆开；撤销回到原样', () => {
  const t = '# P x\n\n## C1 课\n> 文件：c/**\n- 规则\n';
  const a = P.applyOps(t, [{ op: 'add_docs', node: 'C1', docs: ['c/a.md#第 1 章'] }]);
  assert.match(a.text, /> 文件：c\/\*\*\n> 文档：c\/a\.md#第 1 章\n- 规则/);
  const b = P.applyOps(a.text, [{ op: 'add_docs', node: 'C1', docs: ['c/a.md#第 1 章', 'c/b.md'] }]);
  assert.deepStrictEqual(P.parse(b.text).children[0].children[0].docs, ['c/a.md#第 1 章', 'c/b.md']);
  assert.strictEqual(P.applyOps(b.text, [{ op: 'add_docs', node: 'C1', docs: ['c/b.md'] }]).skipped[0].reason, 'same');
  assert.strictEqual(P.applyOps(b.text, b.applied[0].undo).text, a.text);
});

const FILES = {
  'edu/ch01-a.html': '', 'edu/ch02-b.html': '', 'edu/js/ch01.js': '', 'edu/项目规则与经验.md': '# 教育学 · 美术馆：项目规则与经验\n',
  'old-course/a.html': '', 'old-course/b.html': '', 'old-course/c.html': '',
  'course-备份/a.html': '', 'course-备份/b.html': '', 'course-备份/c.html': '',
  '规范/写作.md': '# 写作\n', '规范/结构.md': '# 结构\n', '规范/技术.md': '# 技术\n',
  'ds/ch01-x.html': '', 'ds/progress.md': '# 进度\n', 'ds/_CHAPTERS.md': '# 章节表\n## 一、定位\n## 六、各章要点\n### 第 1 章 霍乱与可避免（样板，追问一）\n要点\n### 第 2 章 数据被筛过\n要点\n',
};
const TREE = '# P 课程\n\n## W1 正文写作\n> 文件：*/ch*.html\n\n## C2 数据科学课\n> 文件：ds/**\n> 文档：ds/_CHAPTERS.md\n\n### C2.1 第1章\n> 文件：ds/ch01-*.html\n';

test('结构：没有专门需求、最近改过的内容文件夹建需求（名字取说明文档标题、挂上它）；横切的 */ch*.html 不算有需求；文档文件夹、备份、很久没动的不建；按章的子需求挂讲这一章的那一节', () => {
  const dir = project(FILES);
  for (const f of ['old-course/a.html', 'old-course/b.html', 'old-course/c.html']) old(dir, f);
  const files = Object.keys(FILES);
  const qs = Structure.plan(TREE, dir, files);
  const texts = qs.map(q => q.text);
  assert.strictEqual(qs.filter(q => q.memKey.startsWith('struct|node|')).length, 1, texts.join('\n'));
  const node = qs.find(q => q.memKey === 'struct|node|edu');
  assert.deepStrictEqual(node.options[0].ops, [
    { op: 'add_node', parent: 'P', id: 'C3', title: '教育学 · 美术馆' },
    { op: 'add_files', node: 'C3', globs: ['edu/**'] },
    { op: 'add_docs', node: 'C3', docs: ['edu/项目规则与经验.md'] },
  ]);
  assert.ok(qs.some(q => q.memKey === 'struct|sec|C2.1|ds/_CHAPTERS.md#第 1 章'), texts.join('\n'));
  // C2 已经挂了文档：不再塞第一层其余的 .md
  assert.ok(!qs.some(q => q.memKey.startsWith('struct|docs|C2|')));
  // 节名能找回那一节
  const Docs = require('../src/docs');
  assert.match(Docs.findSection(FILES['ds/_CHAPTERS.md'], '第 1 章').title, /霍乱/);
});

test('结构（体检里）：直接做、可撤销，不问；撤销过的下次不再做；没挂文档的需求挂上自己文件夹第一层的说明文档', async () => {
  const dir = project(FILES);
  const treePath = path.join(dir, '需求树.md');
  fs.writeFileSync(treePath, TREE + '\n## C9 别的课\n> 文件：ds2/**\n');
  fs.mkdirSync(path.join(dir, 'ds2'));
  fs.writeFileSync(path.join(dir, 'ds2', '规则.md'), '# 规则\n');
  const r = await runCheckup(treePath, { model: false, memory: false });
  assert.strictEqual(r.structure.length, 0, '不问');
  assert.ok(r.auto.length >= 3, r.auto.map(a => a.text).join('\n'));
  const root = P.parse(read(treePath));
  const edu = [...P.walk(root)].find(n => n.title === '教育学 · 美术馆');
  assert.strictEqual(edu.id, 'C10', '最大编号加一，不补空位');
  assert.deepStrictEqual(edu.files, ['edu/**']);
  assert.deepStrictEqual(P.findById(root, 'C2.1').docs, ['ds/_CHAPTERS.md#第 1 章']);
  assert.deepStrictEqual(P.findById(root, 'C9').docs, ['ds2/规则.md']);
  const created = r.auto.find(a => a.memKey === 'struct|node|edu');
  assert.ok(store.undoChange(treePath, created.changeId));
  assert.ok(!read(treePath).includes('教育学'));
  const again = await runCheckup(treePath, { model: false, memory: false });
  assert.ok(!again.auto.some(a => a.memKey === 'struct|node|edu'), '撤销过的不再建');
  assert.ok(!read(treePath).includes('教育学'));
  assert.strictEqual(Q.openQuestions(treePath).length, 0);
});

test('记忆搬进文档：模型说某份记忆是某需求的进度，原文接到那个需求挂的进度文档末尾、删掉记忆；一起撤销', async () => {
  const dir = project({ 'ds/ch01-x.html': '', 'ds/progress.md': '# 进度\n- 第 1 章做完\n', 'ds/规则.md': '# 规则\n' });
  const treePath = path.join(dir, '需求树.md');
  fs.writeFileSync(treePath, '# P 课程\n\n## C2 数据科学课\n> 文件：ds/**\n> 文档：ds/规则.md, ds/progress.md\n');
  const mem = path.join(SANDBOX, `mem-${Date.now()}`);
  fs.mkdirSync(mem);
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), '- [数据科学进度](ds-progress.md) — 做到第 2 章\n');
  fs.writeFileSync(path.join(mem, 'ds-progress.md'), '---\nname: ds-progress\ndescription: 数据科学课进度\nmetadata:\n  type: project\n---\n\n第 2 章写到一半，插画还差两张。\n');
  const ask = async () => ({ questions: [], memory: [{ file: 'ds-progress.md', kind: 'doc', node: 'C2' }] });
  const r = await runCheckup(treePath, { ask, memory: mem, parts: { rules: false, docs: false } });
  assert.ifError(r.error);
  const moved = r.auto.find(a => a.kind === 'memory');
  assert.ok(moved, JSON.stringify(r.auto));
  const doc = read(path.join(dir, 'ds/progress.md'));
  assert.match(doc, /- 第 1 章做完\n\n## 从自动记忆搬来：数据科学课进度(（[0-9-]+）)?\n\n第 2 章写到一半，插画还差两张。\n$/);
  assert.ok(!fs.existsSync(path.join(mem, 'ds-progress.md')));
  assert.ok(!read(path.join(mem, 'MEMORY.md')).includes('ds-progress'));
  assert.ok(store.undoChange(treePath, moved.changeId));
  assert.strictEqual(read(path.join(dir, 'ds/progress.md')), '# 进度\n- 第 1 章做完\n');
  assert.ok(fs.existsSync(path.join(mem, 'ds-progress.md')));
});

test('写代码的原则只在总目录里一句（不再单独加载 ponytail 原文）；0.18.0 编出的 ponytail.md 重编时删掉；关掉动手原则就不写', () => {
  const dir = project({ '需求树.md': '# P x\n- r\n', '.claude/settings.local.json': '{"x":"reqtree"}' });
  const tree = path.join(dir, '需求树.md');
  const rules = path.join(dir, '.claude', 'rules', 'reqtree');
  fs.mkdirSync(rules, { recursive: true });
  fs.writeFileSync(path.join(rules, 'ponytail.md'), '---\npaths:\n  - "**/*.js"\n---\n<!-- reqtree:generated -->\n# Ponytail\n');
  require('../src/compile').compile(tree);
  assert.ok(!fs.existsSync(path.join(rules, 'ponytail.md')), '旧版编出的 ponytail.md 要删掉');
  const idx = read(path.join(rules, '_index.md'));
  for (const s of ['标准库和已装的依赖', '调用方、测试、配置一起改', '留一个小测试', '无障碍不省', '没查的和风险']) assert.ok(idx.includes(s), s);
  assert.match(idx, /不要光照用户说的做/);
  store.writeConfig(tree, { principles: false });
  require('../src/compile').compile(tree);
  assert.ok(!read(path.join(rules, '_index.md')).includes('动手原则'));
});

test('代码地图：列出页面自己的脚本（只被一个页面引用的），给个数和例子', () => {
  const dir = project({
    'ds/ch01-a.html': '<script src="js/common.js"></script><script src="js/ch01.js"></script>',
    'ds/ch02-b.html': '<script src="js/common.js"></script><script src="js/ch02.js"></script>',
    'ds/js/common.js': 'window.DS = { mountQuiz() {}, tryDone() {} };\n',
    'ds/js/ch01.js': 'DS.mountQuiz();\n', 'ds/js/ch02.js': 'DS.tryDone();\n',
  });
  const tree = path.join(dir, '需求树.md');
  fs.writeFileSync(tree, '# P x\n\n## C2 课\n> 文件：ds/**\n');
  require('../src/codemap').refresh(tree);
  const map = read(path.join(dir, '.claude', 'rules', 'reqtree', 'map-C2.md'));
  assert.match(map, /页面自己的脚本（只被一个页面引用，共 2 个），例：ds\/ch01-a\.html → ds\/js\/ch01\.js；ds\/ch02-b\.html → ds\/js\/ch02\.js/);
});

test('重复：下级文档里和上级文档逐字重复的列表项删掉（可撤销）；普通段落、平级之间的重复不动', async () => {
  const dir = project({
    '规范/写作.md': '# 写作\n- 术语先讲后用，第一次出现时给一句白话解释\n本文节号沿用原来的 CLAUDE.md 编号方式。\n',
    'a/规则.md': '# A 课\n- 术语先讲后用，第一次出现时给一句白话解释\n- A 课专用：每章配三张图\n本文节号沿用原来的 CLAUDE.md 编号方式。\n',
    'b/规则.md': '# B 课\n- A 课专用：每章配三张图\n',
    'a/x.html': '', 'b/x.html': '',
  });
  const treePath = path.join(dir, '需求树.md');
  fs.writeFileSync(treePath, '# P 课程\n> 文档：规范/写作.md\n\n## C1 A 课\n> 文件：a/**\n> 文档：a/规则.md\n\n## C2 B 课\n> 文件：b/**\n> 文档：b/规则.md\n');
  const qs = Structure.dupLines(P.parse(read(treePath)), dir);
  assert.deepStrictEqual(qs.map(q => q.options[0].ops), [[{ op: 'doc_remove', file: 'a/规则.md', text: '术语先讲后用，第一次出现时给一句白话解释' }]]);
  const r = await runCheckup(treePath, { model: false, memory: false });
  const done = r.auto.find(a => a.memKey && a.memKey.startsWith('struct|dup|'));
  assert.ok(done, JSON.stringify(r.auto));
  assert.strictEqual(read(path.join(dir, 'a/规则.md')), '# A 课\n- A 课专用：每章配三张图\n本文节号沿用原来的 CLAUDE.md 编号方式。\n');
  assert.ok(store.undoChange(treePath, done.changeId));
  assert.match(read(path.join(dir, 'a/规则.md')), /术语先讲后用/);
});
