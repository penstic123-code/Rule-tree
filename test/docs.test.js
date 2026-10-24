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
const store = require('../src/store');
const Docs = require('../src/docs');

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

test('体检（本地）：挂了却不存在的文档；一份都没挂的需求，文件夹里的 .md 提醒挂上（README 不算；挂了入口文档的不提醒其余的）', () => {
  const { dir, tree } = project();
  fs.mkdirSync(path.join(dir, 'e'));
  fs.writeFileSync(path.join(dir, 'e', '进度.md'), '# 进度\n');
  fs.writeFileSync(path.join(dir, 'e', 'README.md'), '# r\n');
  fs.appendFileSync(tree, '\n## C3 第三课\n> 文件：e/**\n- 规则\n');
  const r = docProblems(fs.readFileSync(tree, 'utf8'), dir, tree);
  assert.deepStrictEqual(r.docMissing, [{ node: 'C1', doc: 'c/gone.md' }]);
  assert.deepStrictEqual(r.docUnlinked.map(d => d.doc), ['e/进度.md']);
});

test('体检：可以只查文档；和树重复的从文档里删掉、该搬进树的搬进去再删（可撤销）；找不准的只提醒；没改过的下次不再看', async () => {
  const { dir, tree } = project();
  fs.appendFileSync(path.join(dir, 'CLAUDE.md'), '\n| 表格 | 每章配图 |\n');
  const plan = checkPlan(tree, { parts: { rules: false, memory: false, docs: true } });
  assert.deepStrictEqual(plan.docs.map(d => d.name).sort(), ['CLAUDE.md', 'c/_CHAPTERS.md', 'd/notes.md']);
  assert.strictEqual(plan.calls, 1);
  process.env.FAKE_OUT = JSON.stringify({ questions: [], docs: [
    { doc: 'CLAUDE.md', kind: 'dup', text: '段落不超过四行', node: 'P' },
    { doc: 'CLAUDE.md', kind: 'dup', text: '每章配图', node: 'C1' },                       // 在表格里：不删，提醒
    { doc: 'c/_CHAPTERS.md', kind: 'move', text: '第1章 ✅', node: 'C1', rule: '每章做完标 ✅' },
    { doc: 'nope.md', kind: 'move', text: 'x', node: 'C1', rule: 'x' },
  ] });
  let r;
  try { r = await runCheckup(tree, { memory: false, parts: { rules: false, memory: false, docs: true } }); } finally { delete process.env.FAKE_OUT; }
  assert.strictEqual(r.merged.length, 0, '没选规则就不合并');
  const claude = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.ok(!claude.includes('段落不超过四行'), '重复的那一行删了');
  assert.match(claude, /\| 表格 \| 每章配图 \|/, '表格行不动');
  assert.deepStrictEqual(r.docDup, [{ doc: 'CLAUDE.md', text: '每章配图', node: 'C1' }]);
  assert.strictEqual(r.docs.length, 0, '有把握的不问');
  assert.strictEqual(r.auto.length, 2);
  assert.match(fs.readFileSync(tree, 'utf8'), /## C1 课[\s\S]*- 每章做完标 ✅/);
  assert.ok(!fs.readFileSync(path.join(dir, 'c', '_CHAPTERS.md'), 'utf8').includes('第1章 ✅'), '搬进树后从文档删掉');
  assert.ok(fs.readdirSync(path.join(dir, '.reqtree', 'doc-backup')).length >= 2, '删之前备份');
  // 撤销：那一行放回原位；撤销过的下次不再看
  const ch = store.readChanges(tree, 20).find(e => e.ops.some(o => o.op === 'doc_remove' && o.file === 'CLAUDE.md'));
  assert.match(ch.summary.join(), /从 CLAUDE\.md 里删掉「段落不超过四行」/);
  assert.ok(store.undoChange(tree, ch.id));
  assert.match(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), /^- 段落不超过四行$/m);
  assert.strictEqual(checkPlan(tree, { parts: { rules: false, memory: false, docs: true } }).calls, 0, '没改过的、撤销回去的都不再看');
  assert.strictEqual(checkPlan(tree, { parts: { rules: false, memory: false, docs: true }, full: true }).docs.length, 3);
  fs.appendFileSync(path.join(dir, 'd', 'notes.md'), '新内容\n');
  assert.deepStrictEqual(checkPlan(tree, { parts: { rules: false, memory: false, docs: true } }).docs.map(d => d.name), ['d/notes.md']);
});

test('从文档删一行：只删找得准的整行；标题、表格、带子项的、出现两次的都不删', () => {
  const { dir, tree } = project();
  const f = path.join(dir, 'c', 'g.md');
  fs.writeFileSync(f, '# 段落不超过四行\n- 段落不超过四行\n- 每章配图\n  - 至少三张\n- 用中文\n- 用中文\n');
  const rm = text => Docs.removeDocText(tree, { file: 'c/g.md', text });
  assert.ok(rm('段落不超过四行。'), '标点不同也算');
  assert.strictEqual(rm('每章配图'), null, '下面挂着子项');
  assert.strictEqual(rm('用中文'), null, '出现两次');
  assert.strictEqual(Docs.removeDocText(tree, { file: '../out.md', text: 'x' }), null, '项目外的不碰');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), '# 段落不超过四行\n- 每章配图\n  - 至少三张\n- 用中文\n- 用中文\n');
});

test('体检：下级重复了上级已有的规则，删下级的；上级范围罩不住下级时不删', async () => {
  const { tree } = project();
  fs.writeFileSync(tree, '# P 项目\n- 段落不超过 4 行\n\n## C1 课\n> 文件：c/**\n- 段落不超过 4 行\n- 每章配图\n\n### C1.1 第一章\n> 文件：c/ch01.html\n- 每章配图\n\n## C2 别的\n> 文件：d/**\n- 每章配图\n');
  const r = await runCheckup(tree, { model: false, memory: false, parts: { rules: true, memory: false, docs: false } });
  assert.deepStrictEqual(r.merged.map(o => `${o.node}:${o.text}`).sort(), ['C1.1:每章配图', 'C1:段落不超过 4 行']);
  assert.match(fs.readFileSync(tree, 'utf8'), /## C2 别的\n> 文件：d\/\*\*\n- 每章配图/, '兄弟需求不算上级');
});

test('长文档附目录（每节标题和行号），只挂一节写那一节的行号；短文档不附；节名找不到时体检提醒', () => {
  const { dir, tree } = project();
  const long = '# 写作规范\n用途：怎么写正文\n\n## 一、内容原则\n' + '内容。\n'.repeat(400) + '\n## 一C、写作风格\n' + '风格。\n'.repeat(400) + '\n## 二、互动\n```\n## 代码块里的不算\n```\n' + '互动。\n'.repeat(300);
  fs.mkdirSync(path.join(dir, 'spec'));
  fs.writeFileSync(path.join(dir, 'spec', 'w.md'), long);
  const toc = Docs.toc(long);
  assert.match(toc, /^一、内容原则 4–405；一C、写作风格 406–807；二、互动 808–/);
  assert.ok(!toc.includes('代码块'));
  const whole = Docs.describe(dir, 'spec/w.md');
  assert.ok(whole.long);
  assert.match(whole.text, /`spec\/w\.md`（怎么写正文），约 \d+ 字，目录：一、内容原则 4–405/);
  const sec = Docs.describe(dir, 'spec/w.md#写作风格');
  assert.strictEqual(sec.text, '`spec/w.md` 的「一C、写作风格」（第 406–807 行）');
  assert.ok(!Docs.describe(dir, 'c/_CHAPTERS.md').long, '短文档不附目录');
  // 编译进规则：说明只读需要的节
  fs.writeFileSync(tree, TREE + '\n## W 写作\n> 文件：*/ch*.html\n> 文档：spec/w.md#写作风格, spec/w.md#不存在的节\n- 句子要短\n');
  compile(tree, { targets: { claude: true } });
  const w = fs.readFileSync(path.join(dir, '.claude', 'rules', 'reqtree', 'W.md'), 'utf8');
  assert.match(w, /`spec\/w\.md` 的「一C、写作风格」（第 406–807 行）/);
  assert.match(w, /按行号只读那几行/);
  // 节名找不到：体检提醒
  const r = docProblems(fs.readFileSync(tree, 'utf8'), dir, tree);
  assert.ok(r.docMissing.some(d => d.doc === 'spec/w.md#不存在的节'));
  assert.ok(!r.docMissing.some(d => d.doc === 'spec/w.md#写作风格'));
});

test('挂的文档改了（行号变了），下一次检查就重新编译', () => {
  const { ensureCompiled } = require('../src/compile');
  const { dir, tree } = project();
  compile(tree, { targets: { claude: true } });
  assert.strictEqual(ensureCompiled(tree), null, '没变不重编');
  const doc = path.join(dir, 'c', '_CHAPTERS.md');
  fs.appendFileSync(doc, '- 第2章\n');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(doc, later, later);
  assert.ok(ensureCompiled(tree), '文档改了要重编');
});

test('一个文件属于几个需求（横切的「写作」和课程）：nodesForFile 全部找出来，编译说明里写了范围窄的优先', () => {
  const { nodesForFile } = require('../src/parser');
  const root = parse('# P 项目\n\n## W 写作\n> 文件：*/ch*.html\n- 句子要短\n\n## C1 课\n> 文件：c/**\n- 每章配图\n\n### C1.1 第一章\n> 文件：c/ch01.html\n- 用霍乱举例\n');
  assert.deepStrictEqual(nodesForFile(root, 'c/ch01.html').map(n => n.id), ['W', 'C1', 'C1.1']);
  assert.deepStrictEqual(nodesForFile(root, 'c/js/a.js').map(n => n.id), ['C1']);
  const { dir, tree } = project();
  compile(tree, { targets: { claude: true } });
  const idx = fs.readFileSync(path.join(dir, '.claude', 'rules', 'reqtree', '_index.md'), 'utf8');
  assert.match(idx, /以文件范围更窄的那份为准/);
  assert.match(idx, /「决定：」开头的/);
  assert.match(idx, /动手原则：①遇到 bug 先找根因/);
});

test('体检分批：文档很长时切成几段、分几批调用', () => {
  const { dir, tree } = project();
  fs.writeFileSync(path.join(dir, 'c', '_CHAPTERS.md'), '# 长\n' + '第N章的进度记录。'.repeat(8000));
  const plan = checkPlan(tree, { parts: { rules: false, memory: false, docs: true } });
  assert.ok(plan.calls >= 3, `calls=${plan.calls}`);
  assert.ok(plan.batches.flat().filter(s => s.name === 'c/_CHAPTERS.md').length >= 5);
});

test('体检分批：某一批出错（如超时）不停下，后面的批照跑；出错那批的文件下次再看', async () => {
  const { dir, tree } = project();
  fs.writeFileSync(path.join(dir, 'c', '_CHAPTERS.md'), '# 长\n' + '第N章的进度记录。'.repeat(8000));
  const parts = { rules: false, memory: false, docs: true };
  const calls = checkPlan(tree, { parts }).calls;
  let n = 0;
  const seenProgress = [];
  const r = await runCheckup(tree, { memory: false, parts, progress: (i, total) => seenProgress.push([i, total]),
    ask: async () => { n++; if (n === 1) throw new Error('调用模型超时'); return { docs: [] }; } });
  assert.strictEqual(n, calls, '每一批都调用了');
  assert.strictEqual(r.checked.failed, 1);
  assert.ok(r.error);
  assert.strictEqual(seenProgress.length, calls);
  assert.ok(checkPlan(tree, { parts }).docs.some(d => d.name === 'c/_CHAPTERS.md'), '出错那份下次再看');
});

test('新项目的第一棵树按最上一层的文件夹生成（文件多的在前）；没有子文件夹时退回模板', () => {
  const store = require('../src/store');
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'init-'));
  for (const f of ['src/a.js', 'src/b.js', 'src/c.js', 'docs/x.md', 'node_modules/m/i.js', '.git/HEAD', 'README.md']) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), '');
  }
  const t = store.initialTree(dir);
  assert.match(t, /^# P init-/);
  assert.match(t, /## R1 src\n> 文件：src\/\*\*\n\n## R2 docs\n> 文件：docs\/\*\*/);
  assert.ok(!t.includes('node_modules'));
  const flat = fs.mkdtempSync(path.join(SANDBOX, 'flat-'));
  fs.writeFileSync(path.join(flat, 'a.js'), '');
  assert.strictEqual(store.initialTree(flat), store.TEMPLATE);
});

test('覆盖只能来自上级：横切的需求之间、兄弟之间写覆盖都不做（不然会平白给规则加「改写N」的键）', () => {
  const { applyOps } = require('../src/parser');
  const t = '# P x\n\n## W 写作\n> 文件：*/ch*.html\n- 故事退到背景\n\n## C2 课\n> 文件：d/**\n- 爬塔主线\n';
  const r = applyOps(t, [{ op: 'override_rule', node: 'C2', from: 'W', text: '故事退到背景', new: '爬塔主线' }]);
  assert.strictEqual(r.text, t);
  assert.strictEqual(r.skipped[0].reason, 'not-ancestor');
});
