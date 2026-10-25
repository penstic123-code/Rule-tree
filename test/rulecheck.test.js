'use strict';
// 体检查规则：改同一个文件时一起送到的规则（不在一条上下级链上）、过时的规则；只查变了的（src/rulecheck.js）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reqtree-sandbox-')));
process.env.TEMP = process.env.TMP = process.env.TMPDIR = SANDBOX;
process.env.REQTREE_HOME = path.join(SANDBOX, 'home', '.reqtree');
process.env.CLAUDE_CONFIG_DIR = path.join(SANDBOX, 'claude-config');

const RC = require('../src/rulecheck');
const { runCheckup, checkPlan } = require('../src/checkup');

// 「写作」按文件类型横切，和数据课在 ds/ch01.html 上一起送到
const TREE = `# P 课程
- 用中文

## W1 正文写作
> 文件：*/ch*.html
- 正文少用“你”点名读者
- 段落不超过 4 行

## C2 数据课
> 文件：ds/**
- 正文少用“你”；引入日常场景时可以用
- 每章三道检查：qa.mjs 截图
- 第1–6章已完成，下一步第7章

## C3 人类学课
> 文件：an/**
- 正文少用“你”点名读者
`;
const FILES = { 'ds/ch01.html': '', 'ds/index.html': '', 'an/ch01.html': '', 'ds/规则.md': '# 数据课\n' };

function project(tree = TREE) {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'p-'));
  for (const [f, t] of Object.entries(FILES)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); }
  fs.writeFileSync(path.join(dir, '需求树.md'), tree);
  return { dir, tree: path.join(dir, '需求树.md') };
}
const files = Object.keys(FILES);

test('一起送到的规则：不在一条上下级链上、在真实文件上重叠、话题相近的才列；平级不重叠的不列', () => {
  const ps = RC.pairs(TREE, files);
  const show = ps.map(p => `${p.a.node}/${p.b.node}`);
  assert.ok(show.includes('W1/C2'), show.join(','));
  assert.ok(show.includes('W1/C3'));
  assert.ok(!show.includes('C2/C3'), 'C2 和 C3 没有共同的文件');
  assert.ok(ps.every(p => p.a.text.includes('你') || p.b.text.includes('你') || p.s >= 0.35));
});

test('过时的证据：提到的文件找不到、读着像进度；提到的文件还在的不算', () => {
  const ev = RC.staleEvidence(TREE, files);
  assert.deepStrictEqual(ev.map(e => [e.node, e.progress]), [['C2', false], ['C2', true]]);
  assert.match(ev[0].why, /qa\.mjs/);
  assert.deepStrictEqual(RC.staleEvidence(TREE, [...files, 'tools/qa.mjs']).map(e => e.node), ['C2']);
});

test('体检：模型判为重复的一起送到的规则删掉一条、确认过时的删掉、进度搬进文档；规则没变的下次体检不调用模型', async () => {
  const { dir, tree } = project(TREE.replace('> 文件：ds/**', '> 文件：ds/**\n> 文档：ds/规则.md'));
  const prompts = [];
  const ask = async p => {
    prompts.push(p);
    const pairs = RC.pairs(fs.readFileSync(tree, 'utf8'), files);
    const i = pairs.findIndex(x => x.a.node === 'W1' && x.b.node === 'C3') + 1;
    return { questions: [], pairs: [{ i, kind: 'dup', keep: 'a' }], stale: [{ i: 1, kind: 'gone' }, { i: 2, kind: 'progress' }] };
  };
  const r = await runCheckup(tree, { ask, memory: false, parts: { docs: false } });
  assert.strictEqual(prompts.length, 1);
  assert.match(prompts[0], /一起送到 AI 手上/);
  const text = fs.readFileSync(tree, 'utf8');
  assert.ok(!/## C3[^#]*正文少用/.test(text), 'C3 那条和 W1 重复，删掉');
  assert.ok(!text.includes('qa.mjs'), '提到的文件没有了，删掉');
  assert.ok(!text.includes('下一步第7章'));
  assert.match(fs.readFileSync(path.join(dir, 'ds/规则.md'), 'utf8'), /第1–6章已完成，下一步第7章/, '进度搬进文档');
  assert.ok(r.auto.length >= 3, JSON.stringify(r.auto.map(a => a.text)));
  // 规则没变：不再调用模型
  assert.strictEqual(checkPlan(tree, { parts: { memory: false, docs: false } }).calls, 0);
  await runCheckup(tree, { ask, memory: false, parts: { docs: false } });
  assert.strictEqual(prompts.length, 1);
  // 加了一条：只查这一条和跟它有关的
  fs.appendFileSync(tree, '- 每节末尾留一个问题\n');
  await runCheckup(tree, { ask: async p => { prompts.push(p); return { questions: [] }; }, memory: false, parts: { docs: false } });
  assert.strictEqual(prompts.length, 2);
  assert.match(prompts[1], /新加、改过的：\n- C3「每节末尾留一个问题」/);
});

test('现在要守的限制（暂时不能用、先不做）不当过时的证据；备份文件夹里挂的文档体检不看', () => {
  assert.deepStrictEqual(RC.staleEvidence('# P x\n\n## K1 组件库\n> 文件：k/**\n- 四种皮肤的样稿还没验收，暂时不能用\n', files), []);
  const { isBackup } = require('../src/structure');
  assert.ok(isBackup('game-design-course-备份-20261020/PROGRESS.md'));
  assert.ok(isBackup('old/a.md') && isBackup('x/backup/a.md'));
  assert.ok(!isBackup('golden/a.md') && !isBackup('DataScience/_CHAPTERS.md'));
});

test('文档里的规则搬进树：只能挂在这份文档所在的需求或它下面，模型说挂到上面、挂到别处的改挂到文档所在的需求', () => {
  const { docPlan } = require('../src/checkup');
  const tree = '# P 课程\n- 用中文\n\n## C2 数据课\n> 文件：ds/**\n> 文档：ds/规则.md\n\n### C2.1 第1章\n> 文件：ds/ch01-*.html\n\n## C3 人类学课\n> 文件：an/**\n';
  const shown = new Set(['ds/规则.md', 'CLAUDE.md']);
  const items = [
    { doc: 'ds/规则.md', kind: 'move', text: '每章三道检查', node: 'P', rule: '每章三道检查' },
    { doc: 'ds/规则.md', kind: 'move', text: '第1章开场用霍乱', node: 'C2.1', rule: '第1章开场用霍乱' },
    { doc: 'ds/规则.md', kind: 'move', text: '人类学的写法', node: 'C3', rule: '人类学的写法' },
    { doc: 'CLAUDE.md', kind: 'move', text: '回答先给结论', node: 'P', rule: '回答先给结论' },
  ];
  const nodes = docPlan(items, { text: tree, shown, asked: new Set() }).questions.map(q => q.node);
  assert.deepStrictEqual(nodes, ['C2', 'C2.1', 'C2', 'P']);
});
