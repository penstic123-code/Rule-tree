'use strict';
// 升级：旧版的一整份 需求树.md 拆成规则文件（src/migrate.js）
const H = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const M = require('../src/migrate');
const T = require('../src/tree');
const store = require('../src/store');

const OLD = `# P 课程
这棵树由 AI 读项目后生成，每个标题是一件要做的事。
- [段落] 段落不超过 4 行
- 用中文

## C2 数据科学课 🔨
> 文件：DataScience/**
> 文档：DataScience/_CHAPTERS.md, 规范/写作.md#一、写作风格
章节表在文档里。
- 不引原话

### C2.1 第1章
- [段落] 开场故事的段落可以到 6 行

### 第2章 ⏳
> 文件：DataScience/ch02-*.html
- 例子要足

#### X9 手写的编号
- 不带点

## C2.5 编号带点的顶层
> 文件：other/**
`;

test('拆分：每个需求一个文件；层级对不上的编号换掉；没写范围的沿用上级；键变成取代说明；说明文字留着、旧的开头说明去掉', () => {
  const { files, renamed } = M.convert(OLD, 'x');
  const root = T.build(files);
  assert.deepStrictEqual(root.problems, []);
  const ids = [...T.walk(root)].map(n => `${n.id} ${n.title}`);
  assert.deepStrictEqual(ids, ['P 课程', 'C1 编号带点的顶层', 'C2 数据科学课', 'C2.1 第1章', 'C2.2 第2章', 'C2.2.1 手写的编号']);
  assert.deepStrictEqual(renamed.map(r => `${r.from}→${r.to}`), ['C2.5→C1', 'X9→C2.2.1']);
  const P = root.children[0];
  assert.deepStrictEqual(P.rules.map(r => r.text), ['段落不超过 4 行', '用中文']);
  assert.deepStrictEqual(P.notes, []);
  const c2 = T.findById(root, 'C2');
  assert.deepStrictEqual(c2.docs, ['DataScience/_CHAPTERS.md', '规范/写作.md#一、写作风格']);
  assert.deepStrictEqual(c2.notes, ['章节表在文档里。']);
  assert.deepStrictEqual(T.findById(root, 'C2.1').files, ['DataScience/**'], '没写范围：沿用上级');
  assert.strictEqual(T.findById(root, 'C2.1').rules[0].text, '开场故事的段落可以到 6 行（在本范围内取代 P 的「段落不超过 4 行」）');
  assert.deepStrictEqual(T.findById(root, 'C2.2.1').files, ['DataScience/ch02-*.html']);
  assert.match(files.get('C2.2-第2章.md'), /# C2\.2 第2章 ⏳\n上级：C2 数据科学课\n/);
});

test('升级：拆成规则文件、记一条「升级」的改动、旧文件挪进 .ruletree/legacy、删掉旧版编译出的规则；已经有规则文件就不再做', () => {
  const dir = H.project('# P x\n', { snapshot: false });
  fs.rmSync(store.rulesDir(dir), { recursive: true });
  fs.writeFileSync(path.join(dir, '需求树.md'), OLD);
  const old = path.join(dir, '.claude', 'rules', 'reqtree');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'C2.md'), '<!-- reqtree:generated -->\n- 旧的');
  fs.writeFileSync(path.join(old, 'mine.md'), '用户自己写的');
  const r = M.upgrade(dir);
  assert.strictEqual(r.count, 5);
  assert.ok(!fs.existsSync(path.join(dir, '需求树.md')));
  assert.strictEqual(fs.readFileSync(r.legacy, 'utf8'), OLD);
  assert.deepStrictEqual(fs.readdirSync(old), ['mine.md'], '只删旧版自己生成的');
  assert.strictEqual(store.readChanges(dir)[0].source, '升级');
  assert.strictEqual(store.syncFiles(dir, null, '其他'), null, '快照建好了');
  assert.strictEqual(M.upgrade(dir), null);
});
