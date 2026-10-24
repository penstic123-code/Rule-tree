'use strict';
// 用 AI 初始化（src/init.js）：生成需求、分好已有规则、拆 CLAUDE.md，一条改动、一键撤销。模型换成假的
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
const Init = require('../src/init');
const { parse, findById } = require('../src/parser');
const { memoryPlan } = require('../src/checkup');

const LONG = '流程说明。'.repeat(120);
const CLAUDE_MD = `# 项目\n\n入口说明：东西在哪。\n\n## 工作流\n\n${LONG}\n\n## 沟通\n\n- 用中文回复\n${'x'.repeat(2600)}\n`;

function project(files) {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'proj-'));
  for (const [f, t] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), t);
  }
  return dir;
}

const FILES = {
  'game/world/city.gd': '', 'game/world/street.gd': '', 'game/ui/hud.gd': '', 'docs/look.md': '# 画面', 'CLAUDE.md': CLAUDE_MD,
};

test('模板样子的树：模板标题还在、或者按文件夹生成的，哪怕记了规则，都算没初始化过', () => {
  assert.ok(Init.templateShaped(store.TEMPLATE));
  assert.ok(Init.templateShaped(store.TEMPLATE.replace('- [语气]', '- 光照只有一条规则\n- [语气]')));
  assert.ok(Init.templateShaped(`# P x\n${store.FOLDER_INTRO}\n\n## R1 src\n- 一条规则\n`));
  assert.ok(!Init.templateShaped('# P 小猪进城记\n\n## R1 城市\n- 规则\n'));
  // 模板自带的示例规则不算已有规则
  assert.deepStrictEqual(Init.existingRules(store.TEMPLATE.replace('- [语气]', '- 光照只有一条规则\n- [语气]')).map(r => r.text), ['光照只有一条规则']);
});

test('初始化：按要做的事生成需求，文件范围只留真能匹配到的，说明文档挂成背景文档，已有规则按编号分下去、没分到的留在根上', async () => {
  const dir = project(FILES);
  fs.writeFileSync(path.join(dir, '需求树.md'), store.TEMPLATE.replace('- [语气]', '- 光照只有一条规则\n- 用中文回复用户\n- [语气]'));
  const ask = async prompt => {
    assert.match(prompt, /1\. 光照只有一条规则/);
    assert.match(prompt, /docs\/look\.md/);
    return {
      project: '小猪', nodes: [
        { id: 'R1', title: '城市', status: 'doing', files: ['game/world/**', 'nowhere/**', 'docs/look.md'], children: [{ id: 'R1.1', title: '街道', files: ['game/world/street.gd'] }] },
        { id: 'R2', title: '界面', files: ['game/ui/**'], docs: ['docs/missing.md'] },
        { id: 'R3', title: '', files: [] },
      ],
      split: [], rules: [{ i: 1, node: 'R1' }, { i: 9, node: 'R2' }],
    };
  };
  const r = await Init.initProject(dir, { ask });
  assert.strictEqual(r.ai, true);
  const root = parse(fs.readFileSync(r.treePath, 'utf8'));
  const r1 = findById(root, 'R1');
  assert.strictEqual(r1.title, '城市');
  assert.strictEqual(r1.status, 'doing');
  assert.deepStrictEqual(r1.files, ['game/world/**']);
  assert.deepStrictEqual(r1.docs, ['docs/look.md']);
  assert.deepStrictEqual(r1.rules.map(x => x.text), ['光照只有一条规则']);
  assert.strictEqual(findById(root, 'R1.1').title, '街道');
  assert.deepStrictEqual(findById(root, 'R2').docs, []);
  assert.ok(!findById(root, 'R3'));
  assert.deepStrictEqual(root.children[0].rules.map(x => x.text), ['用中文回复用户']);
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'rules', 'reqtree', 'R1.md')));
  // 已经初始化过的树不再动
  assert.strictEqual((await Init.initProject(dir, { ask })).skipped, 'exists');
});

test('初始化拆 CLAUDE.md：那一节原样搬进新文档、原处留一行指路，挂到需求上；撤销后所有文件原样放回', async () => {
  const dir = project(FILES);
  const ask = async () => ({
    project: '小猪', nodes: [{ id: 'R1', title: '城市', files: ['game/**'] }],
    split: [
      { doc: 'CLAUDE.md', section: '工作流', to: '规范/工作流.md', node: '', purpose: '做事的流程' },
      { doc: 'CLAUDE.md', section: '不存在的节', to: 'x.md' },
      { doc: 'CLAUDE.md', section: '沟通', to: '../outside.md' },
    ],
  });
  const before = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  const r = await Init.initProject(dir, { ask });
  assert.strictEqual(r.moves.length, 1);
  const moved = fs.readFileSync(path.join(dir, '规范', '工作流.md'), 'utf8');
  assert.match(moved, /^用途：做事的流程\n\n## 工作流\n/);
  assert.ok(moved.includes(LONG));
  const md = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.ok(!md.includes(LONG));
  assert.match(md, /## 工作流\n\n见 `规范\/工作流\.md`/);
  assert.match(md, /## 沟通/);
  assert.deepStrictEqual(parse(fs.readFileSync(r.treePath, 'utf8')).children[0].docs, ['规范/工作流.md']);

  const change = store.readChanges(r.treePath).find(c => c.id === r.changeId);
  assert.strictEqual(change.source, '初始化');
  assert.ok(change.undoable);
  assert.strictEqual(store.undoChange(r.treePath, r.changeId), true);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), before);
  assert.ok(!fs.existsSync(path.join(dir, '规范', '工作流.md')));
  // 回到按文件夹生成的树
  assert.ok(fs.readFileSync(r.treePath, 'utf8').includes(store.FOLDER_INTRO));
});

test('模型调用失败：留下按文件夹生成的树，不报错', async () => {
  const dir = project(FILES);
  const r = await Init.initProject(dir, { ask: async () => { throw new Error('没装 claude'); } });
  assert.strictEqual(r.ai, false);
  assert.match(r.error.message, /没装/);
  assert.ok(fs.readFileSync(r.treePath, 'utf8').includes(store.FOLDER_INTRO));
});

// ---------- 体检里的记忆冲突 ----------
const note = (file, mtime) => ({ file, type: 'feedback', modified: '', mtime, description: '', body: '云保留它自己的预设色，作为例外' });
const TREE = '# P 游戏\n- 光照只有一条规则：albedo 乘一个太阳，加一层天光；植物、云、远景着色器用同一个太阳\n';
const plan = (it, opts = {}) => memoryPlan([it], { text: TREE, dir: SANDBOX, projectDir: SANDBOX, notes: [note('v.md', opts.mtime || 1000)], asked: new Set(), shown: null, ...opts }).questions[0];

test('记忆说的是一条例外：按记忆处理时在旁边加一条，不把整条规则换掉', () => {
  const q = plan({ file: 'v.md', kind: 'conflict', node: 'P', rule: '光照只有一条规则：albedo 乘一个太阳，加一层天光；植物、云、远景着色器用同一个太阳', text: '云保留它自己的预设色，作为例外', newer: 'memory', whole: false });
  assert.deepStrictEqual(q.options[0].ops.map(o => o.op), ['add_rule']);
});

test('记忆和树冲突、树里那条是用户的话定下的：按时间判断哪边新，不问', () => {
  const it = { file: 'v.md', kind: 'conflict', node: 'P', rule: '光照只有一条规则：albedo 乘一个太阳，加一层天光；植物、云、远景着色器用同一个太阳', text: '光照用两个太阳：albedo 乘一个暖色主光、一个冷色补光，加一层天光；植物、远景着色器另算', newer: 'memory', sure: false, whole: false };
  const decided = 5000;
  const ruleTime = (node, text) => (node === 'P' && text.startsWith('光照') ? decided : 0);
  const treeNewer = plan(it, { ruleTime, mtime: 1000 });
  assert.strictEqual(treeNewer.sure, true);
  assert.strictEqual(treeNewer.default, 1);
  const memNewer = plan(it, { ruleTime, mtime: 9000 });
  assert.strictEqual(memNewer.sure, true);
  assert.strictEqual(memNewer.default, 0);
  assert.deepStrictEqual(memNewer.options[0].ops.map(o => o.op), ['replace_rule']);
  // 树里那条没有时间、模型也拿不准：按需求树，不问；要改掉「决定：」才问
  const unsure = plan(it, { mtime: 9000 });
  assert.strictEqual(unsure.sure, true);
  assert.strictEqual(unsure.default, 1);
});

// ---------- 体检：文档跟着需求树改 ----------
test('文档挂在某个需求下、说法和这个需求的规则冲突：按树改文档那几个字（表格行里的也行），可撤销；全项目的文档不改', () => {
  const { docPlan } = require('../src/checkup');
  const dir = project({ 'ml/rules.md': '| 其他语言版 | 没有，只做英文 |\n', '规范/写作.md': '- 只做英文\n' });
  const tree = '# P x\n> 文档：规范/写作.md\n\n## C7 机器学习课\n> 文档：ml/rules.md\n- 中英文章节一致，英文完整翻译\n';
  const treePath = path.join(dir, '需求树.md');
  fs.writeFileSync(treePath, tree);
  const shown = new Set(['ml/rules.md', '规范/写作.md']);
  const items = [
    { doc: 'ml/rules.md（挂在 C7）', kind: 'stale', text: '没有，只做英文', new: '中英双语', node: 'C7', rule: '中英文章节一致，英文完整翻译' },
    { doc: '规范/写作.md', kind: 'stale', text: '只做英文', new: '中英双语', node: 'C7', rule: '中英文章节一致，英文完整翻译' },
    { doc: 'ml/rules.md', kind: 'stale', text: '没有', new: '有', node: 'C7', rule: '树里没有这条' },
  ];
  const dp = docPlan(items, { text: tree, shown, asked: new Set() });
  assert.strictEqual(dp.stale.length, 1);
  const done = store.applyChange(treePath, dp.stale[0].ops, { source: '体检' });
  assert.strictEqual(done.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'ml/rules.md'), 'utf8'), '| 其他语言版 | 中英双语 |\n');
  assert.ok(store.undoChange(treePath, store.readChanges(treePath)[0].id));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'ml/rules.md'), 'utf8'), '| 其他语言版 | 没有，只做英文 |\n');
});

// ---------- 初始化和别的改动先后、同时发生 ----------
test('初始化等模型时记录员往树里记了一条：整棵写回后这条还在（放在根上）', async () => {
  const dir = project(FILES);
  const treePath = path.join(dir, '需求树.md');
  fs.writeFileSync(treePath, store.TEMPLATE.replace('- [语气]', '- 光照只有一条规则\n- [语气]'));
  const ask = async () => {
    store.applyChange(treePath, [{ op: 'add_rule', node: 'P', text: '存档每五分钟自动保存一次' }], { source: '记录员' });
    return { project: '小猪', nodes: [{ id: 'R1', title: '城市', files: ['game/**'] }], split: [], rules: [{ i: 1, node: 'R1' }] };
  };
  const r = await Init.initProject(dir, { ask });
  const root = parse(fs.readFileSync(r.treePath, 'utf8'));
  assert.deepStrictEqual(root.children[0].rules.map(x => x.text), ['存档每五分钟自动保存一次']);
  assert.deepStrictEqual(findById(root, 'R1').rules.map(x => x.text), ['光照只有一条规则']);
});

test('初始化之后体检又记了规则：撤销初始化，树回到原来的样子，后记的规则不丢', async () => {
  const dir = project(FILES);
  const ask = async () => ({ project: '小猪', nodes: [{ id: 'R1', title: '城市', files: ['game/**'] }], split: [] });
  const r = await Init.initProject(dir, { ask });
  store.applyChange(r.treePath, [{ op: 'add_rule', node: 'R1', text: '街道两边种树' }], { source: '体检' });
  assert.ok(store.undoChange(r.treePath, r.changeId));
  const text = fs.readFileSync(r.treePath, 'utf8');
  assert.ok(text.includes(store.FOLDER_INTRO), '回到按文件夹生成的树');
  assert.ok(parse(text).children[0].rules.some(x => x.text === '街道两边种树'));
});

test('体检的默认做法只做成一半（新规则加上了，旧的那条找不到删不掉）：整个撤掉，开着问，不记成已自动处理', async () => {
  const { settle } = require('../src/checkup');
  const dir = project({});
  const treePath = path.join(dir, '需求树.md');
  fs.writeFileSync(treePath, '# P x\n- 段落不超过 4 行\n');
  const q = { source: '体检', text: '两条冲突', default: 0, sure: true, options: [
    { label: '换', ops: [{ op: 'add_rule', node: 'P', text: '段落不超过 6 行', force: true }, { op: 'remove_rule', node: 'P', text: '根本没有这条规则' }] },
    { label: '不动', ops: [] },
  ] };
  const r = await settle(treePath, q, {});
  assert.strictEqual(r.auto, null);
  assert.ok(r.question);
  assert.ok(!fs.readFileSync(treePath, 'utf8').includes('6 行'));
});
