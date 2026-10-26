'use strict';
// 体检（src/checkup.js）：程序检查 + 一次模型调用（这里用假 claude），能改的直接改、可撤销；「决定：」不许模型动；规则分组只改面板显示
const H = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const store = require('../src/store');
const T = require('../src/tree');
const C = require('../src/checkup');
const Cat = require('../src/categories');
const { viewData } = require('../src/viewmodel');

const TREE = `# P 项目
- 段落不超过 4 行
- 决定：用中文写，因为读者是中国学生

## C2 数据科学课 🔨
> 文件：DataScience/**
> 文档：docs/没有这份.md, docs/a.md#没有这一节
- 不引原话
- 图要配说明，见 old/gone.js

### C2.1 第1章
> 文件：DataScience/ch01-*.html, other/x.md
- 不引原话。
- 开场用霍乱

## C3 空课 ⏳
> 文件：nowhere/**
- 一条

## C4 没写范围
- 每次都会加载
`;
const project = () => {
  const dir = H.project(TREE, { files: ['DataScience/ch01-cholera.html', 'other/x.md', 'docs/a.md'] });
  fs.writeFileSync(path.join(dir, 'docs', 'a.md'), '# A\n## 一节\n');
  return dir;
};
const run = (dir, out, opts = {}) => C.runCheckup(dir, { ask: async p => { run.prompt = p; if (out instanceof Error) throw out; return out; }, ...opts });

test('程序检查：送不到、没写范围、超出上级、文档或节不在；编号问题；规则太多', () => {
  const dir = project();
  const kinds = C.programChecks(dir).map(n => `${n.k}:${n.id || n.file}`).sort();
  assert.deepStrictEqual(kinds, ['docGone:C2', 'docSection:C2', 'global:C4', 'noMatch:C3', 'outside:C2.1']);
  for (const n of C.programChecks(dir)) assert.ok(!/^ck\./.test(C.noteText(n)), C.noteText(n));
  const many = H.project(`# P x\n## R1 多\n> 文件：a/**\n${Array.from({ length: 13 }, (_, i) => `- 第 ${i} 条不同的规则内容${'甲乙丙丁戊己庚辛壬癸子丑寅'[i]}`).join('\n')}\n`, { files: ['a/b.js'] });
  assert.deepStrictEqual(C.programChecks(many).map(n => n.k), ['many']);
});

test('体检：重复的直接删（下级重复上级的删下级）；模型给的改法照做；碰「决定：」的不做、进「要你定的」；一条改动、可撤销', async () => {
  const dir = project();
  const before = store.readFiles(dir);
  const r = await run(dir, {
    fixes: [
      { op: 'remove', rule: 'C2#2', why: '提到的文件不在了' },
      { op: 'replace', rule: 'C2.1#2', text: '开场用霍乱地图', why: '合并' },
      { op: 'remove', rule: 'P#2', why: '模型想删决定' },
      { op: 'remove', rule: 'Z9#1' },
    ],
    ask: [{ rules: ['P#1', 'C2#1'], why: '不知道哪个为准' }],
  });
  assert.ifError(r.error);
  assert.match(run.prompt, /C2#2 .*←项目里找不到：old\/gone\.js/, '提到却找不到的文件交给模型看');
  assert.match(run.prompt, /P#2 决定：/);
  const root = store.readTree(dir);
  assert.deepStrictEqual(T.findById(root, 'C2').rules.map(x => x.text), ['不引原话']);
  assert.deepStrictEqual(T.findById(root, 'C2.1').rules.map(x => x.text), ['开场用霍乱地图'], '下级重复上级的删掉');
  assert.strictEqual(root.children[0].rules.length, 2, '决定没动');
  assert.deepStrictEqual(r.ask.map(a => a.rules.join(',')), ['P#2', 'P#1,C2#1']);
  assert.strictEqual(r.applied.length, 3);
  assert.strictEqual(store.readChanges(dir)[0].source, '体检');
  const report = fs.readFileSync(store.metaFile(dir, C.REPORT), 'utf8');
  assert.match(report, /要你定的/);
  assert.match(report, /C2\.1：删掉「不引原话。」（和 C2 的「不引原话」意思一样）/);
  assert.ok(store.undoChange(dir, r.entry.id));
  assert.deepStrictEqual(store.readFiles(dir), before);
});

test('体检：规则自上次之后没变就不再调用模型；模型出错时只做程序检查、下次还会问', async () => {
  const dir = project();
  let r = await run(dir, new Error('Not logged in'));
  assert.ok(r.error);
  assert.match(r.report, /调用模型出错/);
  run.prompt = null;
  r = await run(dir, { fixes: [] });
  assert.ok(run.prompt && !r.skippedModel, '上次出错，这次还问');
  run.prompt = null;
  r = await run(dir, { fixes: [] });
  assert.ok(r.skippedModel && !run.prompt);
  r = await run(dir, { fixes: [] }, { full: true });
  assert.ok(!r.skippedModel);
  r = await C.runCheckup(dir, { model: false });
  assert.ok(!r.error && r.notes.length);
});

test('体检用真的命令行调用模型（假 claude）：拿到 JSON 照做', async () => {
  const dir = project();
  process.env.FAKE_OUT = JSON.stringify({ fixes: [{ op: 'remove', rule: 'C3#1', why: '过时' }] });
  try { await C.runCheckup(dir, { full: true }); } finally { delete process.env.FAKE_OUT; }
  assert.strictEqual(T.findById(store.readTree(dir), 'C3').rules.length, 0);
});

const MANY = `# P 项目
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

test('规则分组：规则多的需求才分；对不上的序号、太少规则的需求、不存在的需求都跳过；规则文件不动；面板每条规则带上组名', async () => {
  const dir = H.project(MANY, { files: ['c/a.html'] });
  const before = store.readFiles(dir);
  const r = await run(dir, { categories: [
    { node: 'P', groups: [{ name: '写作', rules: [1, 2, 3] }, { name: '插图', rules: [4, 5, 99] }, { name: '互动和练习，名字太长了要截掉', rules: [6] }] },
    { node: 'C1', groups: [{ name: '少', rules: [1] }] }, { node: 'Z9', groups: [] },
  ] });
  assert.deepStrictEqual(r.categorized, ['P']);
  assert.match(run.prompt, /要分组的：P/);
  assert.deepStrictEqual(store.readFiles(dir), before);
  const cats = Cat.read(dir);
  assert.strictEqual(Cat.catOf(cats, 'P', '段落不超过 4 行'), '写作');
  assert.strictEqual(Cat.catOf(cats, 'P', '互动要能撤销'), '互动和练习，名字');
  assert.strictEqual(Cat.catOf(cats, 'P', '每章 4 到 6 道练习'), null);
  const data = viewData([{ uri: 'u', name: 'x', files: store.readFiles(dir), categories: cats }]);
  const P = data.files[0].nodes[0];
  assert.deepStrictEqual(P.groups[0].rules.map(x => x.cat), ['写作', '写作', '写作', '插图', '插图', '互动和练习，名字', null]);
});

test('审查回归：下级用「决定：」重复上级的规则时，两条都留', () => {
  const dir = H.project('# P x\n\n## R1 a\n> 文件：a/**\n- 段落不超过 4 行\n\n### R1.1 b\n- 决定：段落不超过 4 行\n', { files: ['a/b.js'] });
  assert.deepStrictEqual(C.duplicateOps(store.readTree(dir)), []);
});
