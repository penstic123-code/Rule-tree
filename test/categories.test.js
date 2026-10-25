'use strict';
// 规则分类：体检时模型分组，存在 .reqtree/categories.json，只改面板显示（src/categories.js）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reqtree-sandbox-')));
process.env.TEMP = process.env.TMP = process.env.TMPDIR = SANDBOX;
process.env.REQTREE_HOME = path.join(SANDBOX, 'home', '.reqtree');
process.env.CLAUDE_CONFIG_DIR = path.join(SANDBOX, 'claude-config');
process.env.REQTREE_CLAUDE_CMD = `"${process.execPath}" "${path.join(__dirname, 'fixtures', 'fake-claude.js')}"`;

const Cat = require('../src/categories');
const { runCheckup, buildCheckPrompt } = require('../src/checkup');
const { viewData } = require('../src/viewmodel');

const TREE = `# P 项目
- 段落不超过 4 行
- 正文少用"你"
- 小标题写概念名
- 每章配三张图
- 插图人物不悬空
- 互动要能撤销
- 每章 4 到 6 道练习

## C1 课
> 文件：c/**
- 只有一条规则
`;
function project() {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'proj-'));
  fs.writeFileSync(path.join(dir, '需求树.md'), TREE);
  return { dir, tree: path.join(dir, '需求树.md') };
}
const GROUPS = [{ node: 'P', groups: [
  { name: '写作', rules: ['段落不超过 4 行', '正文少用"你"', '小标题写概念名'] },
  { name: '插图', rules: ['每章配三张图', '插图人物不悬空', '树里没有这条'] },
  { name: '互动和练习，名字太长了要截掉', rules: ['互动要能撤销'] },
] }, { node: 'C1', groups: [{ name: '少', rules: ['只有一条规则'] }] }, { node: 'Z9', groups: [] }];

test('体检：规则多的需求才分组；对不上的规则、太少规则的需求、不存在的需求都跳过；树不动', async () => {
  const { tree } = project();
  process.env.FAKE_OUT = JSON.stringify({ questions: [], categories: GROUPS });
  let r;
  try { r = await runCheckup(tree, { memory: false }); } finally { delete process.env.FAKE_OUT; }
  assert.ifError(r.error);
  assert.deepStrictEqual(r.categorized, ['P']);
  assert.strictEqual(fs.readFileSync(tree, 'utf8'), TREE, '需求树.md 不能动');
  const cats = Cat.read(tree);
  assert.strictEqual(Cat.catOf(cats, 'P', '段落不超过 4 行'), '写作');
  assert.strictEqual(Cat.catOf(cats, 'P', '每章配三张图'), '插图');
  assert.strictEqual(Cat.catOf(cats, 'P', '互动要能撤销'), '互动和练习，名字');
  assert.strictEqual(Cat.catOf(cats, 'P', '每章 4 到 6 道练习'), null, '模型没分的就没有');
  assert.ok(!cats.C1);
});

test('面板数据：每条规则带上分类；规则改写后对不上就是 null（显示在「其他」）', () => {
  const { tree } = project();
  Cat.save(tree, TREE, GROUPS);
  const text = TREE.replace('段落不超过 4 行', '段落不超过 5 行');
  const d = viewData([{ uri: 'file:///t.md', name: 't', text, categories: Cat.read(tree) }]);
  const own = d.files[0].nodes[0].groups[0].rules;
  assert.strictEqual(own.find(x => x.text === '正文少用"你"').cat, '写作');
  assert.strictEqual(own.find(x => x.text === '段落不超过 5 行').cat, null);
  // 子需求里继承来的根节点规则也带分类
  const inh = d.files[0].nodes[0].children[0].groups.find(g => !g.self).rules;
  assert.strictEqual(inh.find(x => x.text === '每章配三张图').cat, '插图');
});

test('提示词：只列出规则够多的需求，带上已有的组名；没有这样的需求就不提分组', () => {
  const { tree } = project();
  Cat.save(tree, TREE, GROUPS);
  const task = Cat.promptTask(TREE, Cat.read(tree));
  assert.match(task, /P：1\. 段落不超过 4 行  2\. /, '列出规则和序号，模型只回序号');
  assert.match(task, /写作、插图/);
  assert.match(buildCheckPrompt(TREE, '', '', task), /"categories"/);
  assert.strictEqual(Cat.promptTask('# P 项目\n- 一条\n', {}), '');
  // 需求删了：下次存的时候顺手删掉
  Cat.save(tree, '# P 项目\n- 段落不超过 4 行\n- a1\n- a2\n- a3\n- a4\n- a5\n', [{ node: 'P', groups: [{ name: '写作', rules: ['段落不超过 4 行'] }] }]);
  assert.deepStrictEqual(Object.keys(Cat.read(tree)), ['P']);
});

test('模型只回序号（不抄原文，规则多时输出才不会长到超时）：按这个需求里第几条对上；越界的跳过', () => {
  const { tree } = project();
  assert.deepStrictEqual(Cat.save(tree, TREE, [{ node: 'P', groups: [{ name: '写作', rules: [1, 2, 3] }, { name: '插图', rules: [4, 5, 99] }] }]), ['P']);
  const cats = Cat.read(tree);
  assert.strictEqual(Cat.catOf(cats, 'P', '小标题写概念名'), '写作');
  assert.strictEqual(Cat.catOf(cats, 'P', '插图人物不悬空'), '插图');
  assert.strictEqual(Cat.catOf(cats, 'P', '互动要能撤销'), null);
});
