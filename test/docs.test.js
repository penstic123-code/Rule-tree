'use strict';
// 背景文档：需求下的「> 文档：」（src/docs.js），编译成「动手前先读」一句；体检查文档（src/checkup.js）
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

const { parse, findById } = require('../src/parser');
const { compile } = require('../src/compile');
const { runCheckup, checkPlan, docProblems } = require('../src/checkup');

const TREE = `# P 项目
- 段落不超过 4 行

## C1 课
> 文件：c/**
> 文档：c/_CHAPTERS.md, c/gone.md
- 每章配图

## C2 空课
> 文件：d/**
> 文档：d/notes.md
`;

function project() {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'p-'));
  fs.mkdirSync(path.join(dir, 'c'));
  fs.mkdirSync(path.join(dir, 'd'));
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, 'c', '_CHAPTERS.md'), '# 第一课章节表\n用途：章节表和进度\n\n- 第1章 ✅\n');
  fs.writeFileSync(path.join(dir, 'c', '项目规则与经验.md'), '# 经验\n');
  fs.writeFileSync(path.join(dir, 'c', 'README.md'), '# readme\n');
  fs.writeFileSync(path.join(dir, 'd', 'notes.md'), '# 第二课笔记\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# 项目说明\n- 段落不超过四行\n');
  const tree = path.join(dir, '需求树.md');
  fs.writeFileSync(tree, TREE);
  return { dir, tree };
}

test('解析：> 文档： 拆成几份，不算规则也不算备注', () => {
  const c1 = findById(parse(TREE), 'C1');
  assert.deepStrictEqual(c1.docs, ['c/_CHAPTERS.md', 'c/gone.md']);
  assert.strictEqual(c1.rules.length, 1);
  assert.strictEqual(c1.notes.length, 0);
});

test('编译：规则文件里多一句「动手前先读」带用途；不存在的文档不写；只有文档没规则的需求也编出来', () => {
  const { dir, tree } = project();
  compile(tree, { targets: { claude: true } });
  const c1 = fs.readFileSync(path.join(dir, '.claude', 'rules', 'reqtree', 'C1.md'), 'utf8');
  assert.match(c1, /动手前先读背景文档：`c\/_CHAPTERS\.md`（章节表和进度）/);
  assert.ok(!c1.includes('gone.md'));
  const c2 = fs.readFileSync(path.join(dir, '.claude', 'rules', 'reqtree', 'C2.md'), 'utf8');
  assert.match(c2, /`d\/notes\.md`（第二课笔记）/);
});

test('体检（本地）：挂了却不存在的文档、文件夹里没挂的 .md（README 不算）', () => {
  const { dir, tree } = project();
  const r = docProblems(fs.readFileSync(tree, 'utf8'), dir, tree);
  assert.deepStrictEqual(r.docMissing, [{ node: 'C1', doc: 'c/gone.md' }]);
  assert.deepStrictEqual(r.docUnlinked.map(d => d.doc), ['c/项目规则与经验.md']);
});

test('体检：可以只查文档；文档里重复的提醒、该搬进树的变成问题；没改过的下次不再看，全部重查才看', async () => {
  const { dir, tree } = project();
  const plan = checkPlan(tree, { parts: { rules: false, memory: false, docs: true } });
  assert.deepStrictEqual(plan.docs.map(d => d.name).sort(), ['CLAUDE.md', 'c/_CHAPTERS.md', 'd/notes.md']);
  assert.strictEqual(plan.calls, 1);
  process.env.FAKE_OUT = JSON.stringify({ questions: [], docs: [
    { doc: 'CLAUDE.md', kind: 'dup', text: '段落不超过四行', node: 'P' },
    { doc: 'c/_CHAPTERS.md', kind: 'move', text: '第1章 ✅', node: 'C1', rule: '每章做完标 ✅' },
    { doc: 'nope.md', kind: 'move', text: 'x', node: 'C1', rule: 'x' },
  ] });
  let r;
  try { r = await runCheckup(tree, { memory: false, parts: { rules: false, memory: false, docs: true } }); } finally { delete process.env.FAKE_OUT; }
  assert.strictEqual(r.merged.length, 0, '没选规则就不合并');
  assert.deepStrictEqual(r.docDup, [{ doc: 'CLAUDE.md', text: '段落不超过四行', node: 'P' }]);
  assert.strictEqual(r.docs.length, 1);
  assert.match(r.docs[0].text, /搬进需求树（C1）/);
  assert.strictEqual(checkPlan(tree, { parts: { rules: false, memory: false, docs: true } }).calls, 0, '没改过的不再看');
  assert.strictEqual(checkPlan(tree, { parts: { rules: false, memory: false, docs: true }, full: true }).docs.length, 3);
  fs.appendFileSync(path.join(dir, 'd', 'notes.md'), '新内容\n');
  assert.deepStrictEqual(checkPlan(tree, { parts: { rules: false, memory: false, docs: true } }).docs.map(d => d.name), ['d/notes.md']);
});

test('体检分批：文档很长时切成几段、分几批调用', () => {
  const { dir, tree } = project();
  fs.writeFileSync(path.join(dir, 'c', '_CHAPTERS.md'), '# 长\n' + '第N章的进度记录。'.repeat(8000));
  const plan = checkPlan(tree, { parts: { rules: false, memory: false, docs: true } });
  assert.ok(plan.calls >= 3, `calls=${plan.calls}`);
  assert.ok(plan.batches.flat().filter(s => s.name === 'c/_CHAPTERS.md').length >= 5);
});
