'use strict';
// 体检（src/checkup.js）：程序检查 + 分块调用模型（这里用假 claude），能改的直接改、可撤销；「决定：」不许模型动；规则分组只改面板显示
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
const run = (dir, out, opts = {}) => { run.prompts = []; return C.runCheckup(dir, { ask: async p => { run.prompt = p; run.prompts.push(p); if (out instanceof Error) throw out; return typeof out === 'function' ? out(p) : out; }, ...opts }); };

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
  assert.ok(run.prompts.some(p => /要分组的：P/.test(p)), '分组单独问一次');
  assert.ok(run.prompts.every(p => /要分组的/.test(p) !== /"fixes"/.test(p)), '检查和分组不在同一个提示词里');
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

const big = (id, n, extra = '') => `## ${id} 需求${id} 🔨
> 文件：${id.toLowerCase()}/**
${Array.from({ length: n }, (_, i) => `- ${id} 第 ${i} 条各不相同的内容${'甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥'[i % 22]}${i}`).join('\n')}
${extra}
`;
const checks = () => run.prompts.filter(p => /"fixes"/.test(p));
const SPLIT = `# P 项目
- 全项目的一条

${big('A1', 20)}
${big('B1', 20)}
${big('C1', 4)}
`;

test('体检分块：规则多就分几次问，小块装在一起；上级只当背景，改它的不算；块里没有的需求编号不改', async () => {
  const dir = H.project(SPLIT, { files: ['a1/x', 'b1/x', 'c1/x'] });
  const bs = C.batches(store.readTree(dir));
  assert.deepStrictEqual(bs.map(b => b.nodes.map(n => n.id).join('+')), ['P+A1', 'B1+C1']);
  const r = await run(dir, p => ({ fixes: [{ op: 'remove', rule: 'A1#1', why: 'x' }, { op: 'remove', rule: 'B1#1', why: 'y' }] }));
  assert.strictEqual(checks().length, 2);
  assert.ok(checks()[0].includes('A1#1') && !checks()[0].includes('B1#1'));
  assert.deepStrictEqual(r.applied.map(o => o.node).sort(), ['A1', 'B1'], '每块只改自己块里的');
  assert.match(checks()[1], /P 项目（全项目）【上级，只用来对照，不要改】/);
});

test('体检分块：一块超时或出错，其余照常生效；没问成的块下次重问，问成的不再问；全失败才算 error', async () => {
  const dir = H.project(SPLIT, { files: ['a1/x', 'b1/x', 'c1/x'] });
  let r = await run(dir, p => { if (p.includes('B1#1')) throw new Error('boom'); return { fixes: [{ op: 'remove', rule: 'A1#1', why: 'x' }] }; });
  assert.ok(!r.error);
  assert.deepStrictEqual(r.failed.map(f => f.ids.join('+')), ['B1+C1']);
  assert.strictEqual(r.applied.length, 1, '成功的那块照常生效');
  assert.match(r.report, /这几块没检查成功：B1、C1（boom）/);
  r = await run(dir, { fixes: [] });
  assert.strictEqual(checks().length, 1, '只重问没成的那块');
  assert.ok(checks()[0].includes('B1#1') && !checks()[0].includes('A1#2'));
  r = await run(dir, { fixes: [] });
  assert.strictEqual(checks().length, 0, '问成的不再问');
  const dir2 = H.project(SPLIT, { files: ['a1/x'] });
  r = await run(dir2, new Error('Not logged in'));
  assert.ok(r.error && r.failed.filter(f => !f.group).length === 2);
});

test('体检读 CLAUDE.md：规则树里已有的规矩标出来（只提示不改文件）；没变不再问；对不上规则的丢掉；没有 CLAUDE.md 就不问', async () => {
  const dir = project();
  const prompts = r => r.length;
  let r = await run(dir, { fixes: [] });
  assert.ok(!run.prompts.some(p => /CLAUDE\.md：/.test(p)), '没有 CLAUDE.md 不问');
  const md = '# 项目\n- 段落不超过 4 行\n- 别的和规则树无关的要求，写长一点才算数\n';
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), md);
  const out = p => (/CLAUDE\.md：/.test(p) ? { dups: [{ line: '段落不超过 4 行', rule: 'P#1' }, { line: '编的', rule: 'Z9#1' }] } : { fixes: [] });
  r = await run(dir, out);
  assert.ok(run.prompts.some(p => /CLAUDE\.md：/.test(p)));
  const dup = r.notes.filter(n => n.k === 'claudeDup');
  assert.deepStrictEqual(dup.map(n => `${n.line}|${n.rule}`), ['段落不超过 4 行|P#1']);
  assert.match(C.noteText(dup[0]), /CLAUDE\.md 里的「段落不超过 4 行」规则树里已经有了（P#1）/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), md, '不改 CLAUDE.md');
  r = await run(dir, out);
  assert.ok(r.skippedModel && !run.prompts.length, '都没变不再问');
  assert.strictEqual(r.notes.filter(n => n.k === 'claudeDup').length, 1, '沿用上次的结果');
  r = await run(dir, new Error('x'), { full: true });
  assert.ok(r.failed.some(f => f.claude), 'CLAUDE.md 那次没问成单独记');
  assert.ok(prompts(run.prompts) > 0);
});

test('文档找不到时带上当前分支；不在 git 里就不带', () => {
  const dir = project();
  assert.ok(C.programChecks(dir).filter(n => n.k === 'docGone').every(n => !n.branch));
  assert.doesNotMatch(C.noteText({ k: 'docGone', id: 'C2', doc: 'x.md' }), /分支/);
  assert.match(C.noteText({ k: 'docGone', id: 'C2', doc: 'x.md', branch: 'dev' }), /当前分支：dev，可能是分支不同/);
});

test('体检报告跟着项目的语言走：英文项目的报告里没有汉字', async () => {
  const dir = fs.mkdtempSync(path.join(H.SANDBOX, 'en-ck-'));
  fs.mkdirSync(store.rulesDir(dir), { recursive: true });
  fs.writeFileSync(path.join(store.rulesDir(dir), '_root.md'), '# P Project\n- Keep it short\n');
  fs.writeFileSync(path.join(store.rulesDir(dir), 'R1-Gone.md'), '---\npaths:\n  - "nowhere/**"\n---\n# R1 Gone ⏳\nDocs: docs/missing.md\n- One rule\n');
  const r = await C.runCheckup(dir, { model: false });
  assert.ok(r.notes.length, '程序检查应该有发现');
  assert.ok(!/[一-鿿]/.test(r.report), r.report);
  assert.match(r.report, /checkup/i);
  const zh = await C.runCheckup(project(), { model: false });
  assert.match(zh.report, /体检/, '中文项目不变');
});

// ---- 不经过 claude 命令：先取提示词（--jobs），问完把答案送回来（--answers）----
const { spawnSync } = require('child_process');
const BIN = path.join(H.ROOT, 'bin', 'ruletree.js');
const cli = (dir, flag, input) => {
  const r = spawnSync(process.execPath, [BIN, 'checkup', dir, flag, '--json'], { input: input === undefined ? '' : JSON.stringify(input), encoding: 'utf8' });
  return { code: r.status, out: JSON.parse(r.stdout), err: r.stderr };
};
// 目录里所有文件的内容（含 .ruletree/），看有没有被动过
const dump = dir => {
  const out = {};
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8'); } };
  walk(dir);
  return out;
};

test('jobs 只取提示词，磁盘上什么都不变；每项有 prompt 和 rules', () => {
  const dir = project();
  const before = dump(dir);
  const { code, out } = cli(dir, '--jobs');
  assert.strictEqual(code, 0);
  assert.ok(Array.isArray(out) && out.length >= 1);
  for (const j of out) assert.ok(typeof j.prompt === 'string' && Number.isInteger(j.rules), JSON.stringify(j));
  assert.ok(out.some(j => /"fixes"/.test(j.prompt)));
  assert.deepStrictEqual(dump(dir), before);
  assert.deepStrictEqual(C.planJobs(dir, {}).map(j => j.prompt), out.map(j => j.prompt), 'planJobs 就是 jobs 命令的内容');
});

test('answers 照答案改规则，一条改动可以撤销；报告带在结果里', () => {
  const dir = project();
  const before = store.readFiles(dir);
  const { out: jobs } = cli(dir, '--jobs');
  const answers = jobs.map(j => ({ prompt: j.prompt, text: '好的：' + JSON.stringify(/"fixes"/.test(j.prompt) ? { fixes: [{ op: 'remove', rule: 'C2#2', why: '提到的文件不在了' }] } : { categories: [] }) }));
  const { code, out } = cli(dir, '--answers', answers);
  assert.strictEqual(code, 0);
  assert.strictEqual(out.error, null);
  assert.match(out.report, /体检/);
  assert.ok(!T.findById(store.readTree(dir), 'C2').rules.some(r => /gone\.js/.test(r.text)));
  const entry = store.readChanges(dir)[0];
  assert.strictEqual(entry.source, '体检');
  assert.ok(store.undoChange(dir, entry.id));
  assert.deepStrictEqual(store.readFiles(dir), before);
});

test('answers 少一个答案只让那一块失败，其余照常生效', () => {
  const dir = H.project(SPLIT, { files: ['a1/x', 'b1/x', 'c1/x'] });
  const { out: jobs } = cli(dir, '--jobs');
  const checksOnly = jobs.filter(j => /"fixes"/.test(j.prompt));
  assert.strictEqual(checksOnly.length, 2);
  const mine = checksOnly.find(j => j.prompt.includes('A1#1'));
  const { out } = cli(dir, '--answers', [{ prompt: mine.prompt, text: JSON.stringify({ fixes: [{ op: 'remove', rule: 'A1#1', why: 'x' }] }) }]);
  assert.strictEqual(out.error, null, '只有一块没问成不算全失败');
  assert.deepStrictEqual(out.failed.filter(f => !f.group).map(f => f.ids.join('+')), ['B1+C1']);
  assert.strictEqual(T.findById(store.readTree(dir), 'A1').rules.length, 19);
  // 没问成的下次重问
  assert.ok(cli(dir, '--jobs').out.some(j => j.prompt.includes('B1#1')));
});

test('答案对不上提示词（规则中途变了）和答案不是 JSON：那一块算失败，不改任何东西', () => {
  const dir = project();
  const { out: jobs } = cli(dir, '--jobs');
  const { out } = cli(dir, '--answers', jobs.map(j => ({ prompt: j.prompt + ' ', text: '{"fixes":[]}' })));
  assert.ok(out.error && out.failed.length);
  const bad = cli(dir, '--answers', jobs.map(j => ({ prompt: j.prompt, text: '没有 JSON' })));
  assert.ok(bad.out.error);
  assert.strictEqual(T.findById(store.readTree(dir), 'C2').rules.length, 2, '模型没改任何规则（只有程序查出的重复被删）');
});

const EN_TREE = (dir) => {
  fs.mkdirSync(store.rulesDir(dir), { recursive: true });
  fs.writeFileSync(path.join(store.rulesDir(dir), '_root.md'), '# P Project\n- Keep it short\n- Always keep it short\n');
  fs.writeFileSync(path.join(store.rulesDir(dir), 'R1-Code.md'), '---\npaths:\n  - "src/**"\n---\n# R1 Code 🔨\n- Write tests first\n');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), '');
  store.syncFiles(dir, null, 'Other');
  return dir;
};

test('英文项目：给模型的提示词没有汉字，答案要求用同一种语言；中文项目的提示词不变', () => {
  const dir = EN_TREE(fs.mkdtempSync(path.join(H.SANDBOX, 'en-jobs-')));
  const jobs = C.planJobs(dir, { full: true });
  assert.ok(jobs.length);
  for (const j of jobs) assert.ok(!/[一-鿿]/.test(j.prompt), j.prompt);
  assert.match(jobs[0].prompt, /"fixes"/);
  const zh = C.planJobs(project(), { full: true }).find(j => /"fixes"/.test(j.prompt));
  assert.ok(zh.prompt.startsWith('你在给一个项目的规则做体检。'));
  assert.match(zh.prompt, /C2#2 .*←项目里找不到：old\/gone\.js/);
});

test('中文规则的项目开在英文界面的 VS Code：提示词和改动来源跟项目走，报告才用界面语言', async () => {
  const STRINGS = require('../media/strings');
  const dir = project();
  const r = await run(dir, { fixes: [{ op: 'remove', rule: 'C2#1', why: 'x' }], ask: [] }, { T: STRINGS.make('en') });
  assert.ok(run.prompts.length, '问了模型');
  assert.ok(run.prompts.some(p => p.startsWith('你在给一个项目的规则做体检。')), '提示词是中文');
  assert.ok(r.applied.length, '有改动才有来源');
  assert.strictEqual(store.readChanges(dir)[0].source, '体检');
  assert.match(r.report, /checkup/i, '报告给人看，跟界面语言');
});

test('英文项目开在中文界面：提示词和来源还是英文；项目看不出语言时才用界面语言', async () => {
  const STRINGS = require('../media/strings');
  const dir = EN_TREE(fs.mkdtempSync(path.join(H.SANDBOX, 'en-zh-ui-')));
  await run(dir, { fixes: [] }, { T: STRINGS.make('zh') });
  assert.ok(run.prompts.length && run.prompts.every(p => !p.startsWith('你')), '提示词是英文');
  assert.strictEqual(store.readChanges(dir)[0].source, 'Checkup');
  const blank = fs.mkdtempSync(path.join(H.SANDBOX, 'no-lang-'));
  fs.mkdirSync(store.rulesDir(blank), { recursive: true });
  assert.strictEqual(require('../src/lang').detectLang(blank, STRINGS.make('zh').lang), 'zh');
});

// 面板（hooks/pane.tsx 的 reportBody）去掉报告的前三行，靠的就是这个顺序。改报告开头时两边一起改
test('报告去掉空行后前三行是标题、日期、总结，正文从第四行起；面板去掉的正好是这三行', async () => {
  const STRINGS = require('../media/strings');
  const t = STRINGS.make('zh');
  const r = await run(project(), new Error('坏了'));
  const lines = r.report.split('\n').filter(l => l.trim());
  assert.strictEqual(lines[0], `# ${t('ck.title')}`);
  assert.match(lines[1], /\d{4}|\d+\/\d+/, '第二行是日期');
  assert.strictEqual(lines[2], t('ck.summary', r.applied.length, r.ask.length, r.notes.length));
  assert.match(lines[3], /调用模型出错|没检查成功/, '第四行起是正文：失败原因要留给面板画');
  assert.match(fs.readFileSync(path.join(H.ROOT, 'hooks', 'pane.tsx'), 'utf8'), /REPORT_HEAD_LINES = 3\b/);
});

test('报告正文不列原始数字：规则条数、文件个数、超时秒数（R1.2）', () => {
  const STRINGS = require('../media/strings');
  for (const lang of ['zh', 'en']) {
    const t = STRINGS.make(lang);
    assert.doesNotMatch(t('ck.many', 'R1', 987), /987/);
    assert.doesNotMatch(t('ck.outside', 'R1', 'R2', 'a.js', 987), /98[67]/);
    assert.doesNotMatch(t('m.timeout', 987), /987/);
  }
});

test('英文项目：体检的改动来源是 Checkup，面板上的最近改动没有汉字；中文项目照旧', async () => {
  const dir = EN_TREE(fs.mkdtempSync(path.join(H.SANDBOX, 'en-src-')));
  const r = await C.runCheckup(dir, { ask: async () => ({ fixes: [] }) });
  assert.ok(r.applied.length, '重复的那条被删了');
  const e = store.readChanges(dir)[0];
  assert.strictEqual(e.source, 'Checkup');
  const snap = require('../src/snapshot').snapshot(dir);
  const text = snap.changes.map(c => c.summary.join(' ')).join('\n');
  assert.ok(text && !/[一-鿿]/.test(text), text);
  assert.match(text, /Removed rule/);
  // 中文项目：面板上的说明还是存下来的中文
  const zhDir = project();
  await run(zhDir, { fixes: [] });
  assert.match(require('../src/snapshot').snapshot(zhDir).changes[0].summary[0], /删掉/);
});
