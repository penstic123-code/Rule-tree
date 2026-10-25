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
const Q = require('../src/questions');
const plan = (it, opts = {}) => memoryPlan([it], { text: TREE, dir: SANDBOX, projectDir: SANDBOX, notes: [note('v.md', opts.mtime || 1000)], asked: new Set(), shown: null, ...opts }).questions[0];

test('记忆说的是一条例外：按记忆处理时在旁边加一条，不把整条规则换掉', () => {
  const q = plan({ file: 'v.md', kind: 'conflict', node: 'P', rule: '光照只有一条规则：albedo 乘一个太阳，加一层天光；植物、云、远景着色器用同一个太阳', text: '云保留它自己的预设色，作为例外', newer: 'memory', whole: false });
  assert.deepStrictEqual(q.options[0].ops.map(o => o.op), ['add_rule']);
});

test('记忆和树冲突、树里那条是用户的话定下的：按时间判断哪边新，不问', () => {
  const it = { file: 'v.md', kind: 'conflict', node: 'P', rule: '光照只有一条规则：albedo 乘一个太阳，加一层天光；植物、云、远景着色器用同一个太阳', text: '光照用两个太阳：albedo 乘一个暖色主光、一个冷色补光，加一层天光；植物、远景着色器另算', newer: 'memory', sure: false, whole: false };
  const decided = 5000;
  const ruleTime = (node, text) => (node === 'P' && text.startsWith('光照') ? decided : 0);
  const asks = q => Q.decide(q, TREE);
  const treeNewer = plan(it, { ruleTime, mtime: 1000 });
  assert.deepStrictEqual(asks(treeNewer), { ask: false, default: 1 });
  const memNewer = plan(it, { ruleTime, mtime: 9000 });
  assert.deepStrictEqual(asks(memNewer), { ask: false, default: 0 });
  assert.deepStrictEqual(memNewer.options[0].ops.map(o => o.op), ['replace_rule']);
  // 树里那条没有时间、模型也拿不准：按需求树，不问
  const unsure = plan(it, { mtime: 9000 });
  assert.deepStrictEqual(asks(unsure), { ask: false, default: 1 });
  // 要改掉「决定：」才问，问的时候先不动
  const DTREE = TREE.replace('- 光照', '- 决定：光照');
  const dq = memoryPlan([{ ...it, rule: '决定：' + it.rule }], { text: DTREE, dir: SANDBOX, projectDir: SANDBOX, notes: [note('v.md', 9000)], asked: new Set(), shown: null, ruleTime: () => 5000 }).questions[0];
  assert.deepStrictEqual(Q.decide(dq, DTREE), { ask: true, default: 1 });
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

test('体检的默认做法只做成一半（新规则加上了，旧的那条找不到删不掉）：整个撤掉，不问、记成关掉，不记成已自动处理', async () => {
  const { settle } = require('../src/checkup');
  const Q = require('../src/questions');
  const dir = project({});
  const treePath = path.join(dir, '需求树.md');
  fs.writeFileSync(treePath, '# P x\n- 段落不超过 4 行\n');
  const q = { source: '体检', text: '两条冲突', default: 0, options: [
    { label: '换', ops: [{ op: 'add_rule', node: 'P', text: '段落不超过 6 行', force: true }, { op: 'remove_rule', node: 'P', text: '根本没有这条规则' }] },
    { label: '不动', ops: [] },
  ] };
  const r = await settle(treePath, q, {});
  assert.strictEqual(r.auto, null);
  assert.strictEqual(r.question, null);
  assert.ok(!fs.readFileSync(treePath, 'utf8').includes('6 行'));
  assert.strictEqual(Q.readQuestions(treePath)[0].status, 'dismissed');
});

test('体检：规则搬进了树、文档那一行删不掉（在表格里）：规则留着，不撤、不问，那一行进报告让你自己删', async () => {
  const { settle } = require('../src/checkup');
  const dir = project({ 'a.md': '| 规则 | 每章配三张图 |\n' });
  const treePath = path.join(dir, '需求树.md');
  fs.writeFileSync(treePath, '# P x\n> 文档：a.md\n');
  const q = { source: '体检', kind: 'doc', text: '搬进树', default: 0, options: [
    { label: '搬进', ops: [{ op: 'add_rule', node: 'P', text: '每章配三张图' }, { op: 'doc_remove', file: 'a.md', text: '每章配三张图' }] },
    { label: '留着', ops: [] },
  ] };
  const r = await settle(treePath, q, {});
  assert.strictEqual(r.question, null);
  assert.ok(r.auto);
  assert.match(fs.readFileSync(treePath, 'utf8'), /- 每章配三张图/);
  assert.ok(!r.applied.some(o => o.op === 'doc_remove'));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a.md'), 'utf8'), '| 规则 | 每章配三张图 |\n');
});

// ---------- 命令行 init 也用 AI 初始化 ----------
test('命令行 init：按文件夹建好以后用 AI 按要做的事生成需求；--no-ai 只按文件夹；模型失败保持按文件夹', () => {
  const { spawnSync } = require('child_process');
  const bin = path.join(__dirname, '..', 'bin', 'reqtree.js');
  const fake = `"${process.execPath}" "${path.join(__dirname, 'fixtures', 'fake-claude.js')}"`;
  const run = (dir, out, ...extra) => spawnSync(process.execPath, [bin, 'init', dir, ...extra], { encoding: 'utf8', env: { ...process.env, REQTREE_INIT_CMD: fake, REQTREE_CLAUDE_CMD: fake, FAKE_OUT: out } });
  const plan = JSON.stringify({ project: '小猪', nodes: [{ id: 'R1', title: '城市', files: ['game/world/**'] }], split: [] });
  {
    const dir = project(FILES);
    const r = run(dir, plan);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /已按要做的事生成 1 个需求/);
    const text = fs.readFileSync(path.join(dir, '需求树.md'), 'utf8');
    assert.match(text, /## R1 城市/);
    assert.ok(!text.includes(store.FOLDER_INTRO));
  }
  {
    const dir = project(FILES);
    assert.strictEqual(run(dir, plan, '--no-ai').status, 0);
    assert.ok(fs.readFileSync(path.join(dir, '需求树.md'), 'utf8').includes(store.FOLDER_INTRO));
  }
  {
    const dir = project(FILES);
    const r = run(dir, '我不会');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /AI 初始化没成功/);
    assert.ok(fs.readFileSync(path.join(dir, '需求树.md'), 'utf8').includes(store.FOLDER_INTRO));
  }
});

test('初始化的材料：每份说明文档给用途和主要标题（不只文件名）；只是归类的上级没写文件，用子需求的文件合起来', async () => {
  const dir = project({ ...FILES, 'docs/look.md': '用途：画面风格和配色\n\n# 画面\n## 配色\n## 光照\n' });
  const g = Init.gather(dir);
  assert.match(g.docs, /docs\/look\.md：画面风格和配色（画面 \/ 配色 \/ 光照）/);
  assert.match(Init.buildPrompt(g), /先从 README、文档的标题/);
  assert.match(Init.buildPrompt(g), /配色 \/ 光照/);
  const p = Init.plan(dir, g, { nodes: [{ id: 'R1', title: '游戏', children: [{ id: 'R1.1', title: '城市', files: ['game/world/**'] }, { id: 'R1.2', title: '界面', files: ['game/ui/**'] }] }] });
  assert.deepStrictEqual(p.nodes[0].files, ['game/world/**', 'game/ui/**']);
});

// ---------- 重新整理：先定结构，再把规则原文挂上去 ----------
const BIG = ['店里摆冷柜就卖冷饮', '店名不重名', '盲道连续', '红绿灯设在主干路', '公园入口对斑马线', '窗户最多三种', '桥墩落在水里', '吊灯每 1.8 米一盏', '店员台词不超过 24 字', '门洞净宽 1.2 米', '入园口宽 2.5 米', '区块号统一算'];
const GAME = { 'game/world/street/a.gd': '', 'game/world/park/b.gd': '', 'game/shops/s.gd': '', 'game/shops/talk.json': '', 'docs/city.md': '# 城市\n', 'docs/old.md': '# 旧\n' };
const bigTree = () => `# P 小猪\n这是说明。\n- 用中文\n\n## R1 城市 🔨\n> 文件：game/**\n> 文档：docs/city.md, docs/old.md\n${BIG.map(r => `- ${r}`).join('\n')}\n`;

test('该整理的迹象：某个需求挂了十几条规则，或者有规则却永远送不到；健康的树不整理', () => {
  assert.deepStrictEqual(Init.needsReorganize(bigTree()).map(w => w.k), ['many']);
  assert.deepStrictEqual(Init.needsReorganize('# P x\n\n## K1 组件库\n- 组件按功能分\n').map(w => w.k), ['nofiles']);
  assert.deepStrictEqual(Init.needsReorganize('# P x\n- 全局\n\n## R1 城市\n> 文件：game/**\n- 一条\n'), []);
});

test('重新整理：多层子需求（文件落在上级范围里）、沿用原编号、规则原文挂过去、没分到的回原处、文档不丢、顶上的标题说明不变；一条改动可撤销', async () => {
  const dir = project(GAME);
  const treePath = path.join(dir, '需求树.md');
  fs.writeFileSync(treePath, bigTree());
  const before = fs.readFileSync(treePath, 'utf8');
  let prompt = '';
  const ask = async p => {
    prompt = p;
    return {
      project: '别的名字', nodes: [
        { id: 'R1', title: '城市', files: ['game/world/**'], children: [
          { id: 'R1.1', title: '街道', files: ['game/world/street/**', 'game/shops/**'], children: [
            { id: 'R1.1.1', title: '盲道', children: [{ id: 'R1.1.1.1', title: '更细', children: [{ id: 'R1.1.1.1.1', title: '最细', children: [{ id: 'X', title: '太深了' }] }] }] }] },
          { id: 'R1.2', title: '公园', files: ['game/world/park/**'] }] },
        { id: 'R2', title: '店铺', files: ['game/shops/**'], docs: ['docs/city.md#没有这一节'], children: [{ id: 'R2.1', title: '店员', files: ['game/shops/talk.json'] }] },
      ],
      // 编号：1 是根上的「用中文」，2 起是 R1 的 BIG
      rules: [{ i: 2, node: 'R2' }, { i: 4, node: 'R1.1.1' }, { i: 6, node: 'R1.2' }, { i: 10, node: 'R2.1' }, { i: 13, node: '' }, { i: 3, node: '不存在' }],
    };
  };
  const r = await Init.reorganize(treePath, { ask });
  assert.strictEqual(r.ai, true);
  assert.match(prompt, /现在的需求树/);
  assert.match(prompt, /（现在在 R1）店里摆冷柜就卖冷饮/);
  const text = fs.readFileSync(treePath, 'utf8');
  const root = parse(text);
  assert.match(text, /^# P 小猪\n这是说明。\n/, '顶上的标题和说明原样留着');
  assert.deepStrictEqual(findById(root, 'R1.1').files, ['game/world/street/**'], '上级范围外的 game/shops/** 去掉');
  assert.ok(findById(root, 'R1.1.1.1.1'), '五层可以');
  assert.ok(!findById(root, 'X') && !text.includes('太深了'), '超过五层的不要');
  assert.deepStrictEqual(findById(root, 'R1.1.1').rules.map(x => x.text), ['盲道连续']);
  assert.deepStrictEqual(findById(root, 'R2.1').rules.map(x => x.text), ['店员台词不超过 24 字']);
  assert.deepStrictEqual(root.children[0].rules.map(x => x.text), ['用中文', '区块号统一算']);
  // 没分到的（含分到不存在需求的）回到原来的 R1
  assert.ok(findById(root, 'R1').rules.some(x => x.text === '店名不重名'));
  assert.strictEqual([...require('../src/parser').walk(root)].reduce((s, n) => s + n.rules.length, 0), 13, '一条不少');
  // 原来挂的文档都还挂着
  const docs = [...require('../src/parser').walk(root)].flatMap(n => n.docs.map(d => d.split('#')[0]));
  assert.ok(docs.includes('docs/city.md') && docs.includes('docs/old.md'), JSON.stringify(docs));
  assert.strictEqual(findById(root, 'R1').status, 'doing', '没给状态的沿用原来的');
  const change = store.readChanges(treePath).find(c => c.id === r.changeId);
  assert.strictEqual(change.source, '整理');
  assert.ok(store.undoChange(treePath, r.changeId));
  assert.strictEqual(fs.readFileSync(treePath, 'utf8'), before);
});

test('体检看到树长歪了：先自动整理一次（只一次，撤销了也不再自动做）；健康的树不整理', async () => {
  const { runCheckup } = require('../src/checkup');
  const dir = project(GAME);
  const treePath = path.join(dir, '需求树.md');
  fs.writeFileSync(treePath, bigTree());
  let reorgs = 0;
  const reorgAsk = async () => { reorgs++; return { nodes: [{ id: 'R1', title: '城市', files: ['game/world/**'] }, { id: 'R2', title: '店铺', files: ['game/shops/**'] }], rules: [{ i: 1, node: 'R2' }] }; };
  const ask = async () => ({ questions: [] });
  const r = await runCheckup(treePath, { ask, reorgAsk, memory: false, parts: { docs: false } });
  assert.strictEqual(reorgs, 1);
  assert.ok(r.reorganized);
  assert.ok(store.undoChange(treePath, r.reorganized.changeId));
  await runCheckup(treePath, { ask, reorgAsk, memory: false, parts: { docs: false } });
  assert.strictEqual(reorgs, 1, '自动只整理一次');
});
