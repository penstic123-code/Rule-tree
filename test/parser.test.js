'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/parser');

const TREE = `# P 项目
- [段落] 段落不超过 4 行
- [语气] 语气柔和

## C2 课 🔨
> 文件：DataScience/**
- 不引原话

### C2.1 第1章 ⏳
> 文件：DataScience/ch01-*.html
- [段落] 开场段落可以到 6 行
- 开场用勇士

## C3 别的课
`;

const ids = text => [...P.walk(P.parse(text))].map(n => n.id);
const lineOf = (text, s) => text.split('\n').findIndex(l => l.includes(s));

test('解析：节点、状态、规则、文件', () => {
  const root = P.parse(TREE);
  assert.deepStrictEqual(ids(TREE), ['P', 'C2', 'C2.1', 'C3']);
  const c21 = P.findById(root, 'C2.1');
  assert.strictEqual(c21.status, 'todo');
  assert.deepStrictEqual(c21.files, ['DataScience/ch01-*.html']);
  assert.strictEqual(c21.rules[0].key, '段落');
});

test('继承与覆盖', () => {
  const eff = P.effectiveRules(P.findById(P.parse(TREE), 'C2.1'));
  assert.deepStrictEqual(eff.map(r => r.text), ['开场段落可以到 6 行', '语气柔和', '不引原话', '开场用勇士']);
  assert.strictEqual(eff[0].overrides.owner.id, 'P');
});


test('parse：🆕 🗑 只是普通文字，不再特殊对待（以 🗑 开头的正常规则不会被藏起来）', () => {
  const t = '# P 项目\n## A1 图标 🔨\n> 文件：src/**\n- 🗑 删除按钮一律用红色\n- 🆕 徽章只给新章节用\n\n## 🆕 新品区\n';
  const root = P.parse(t);
  assert.deepStrictEqual(P.findById(root, 'A1').rules.map(r => r.text), ['🗑 删除按钮一律用红色', '🆕 徽章只给新章节用']);
  assert.ok([...P.walk(root)].some(n => n.title === '🆕 新品区'));
  // 面板加一条以 🗑 开头的规则，看得见，也能撤销
  const a = P.applyOps(t, [{ op: 'add_rule', node: 'A1', text: '🗑 回收站图标用灰色' }]);
  assert.ok(P.findById(P.parse(a.text), 'A1').rules.some(r => r.text === '🗑 回收站图标用灰色'));
  assert.strictEqual(P.applyOps(a.text, a.applied[0].undo).text, t);
});

test('文件匹配：取最深的节点；**/ 不会误配', () => {
  const root = P.parse(TREE);
  assert.strictEqual(P.nodeForFile(root, 'DataScience/ch01-a.html').id, 'C2.1');
  assert.strictEqual(P.nodeForFile(root, 'DataScience/css/x.css').id, 'C2');
  assert.strictEqual(P.nodeForFile(root, 'Other/x.css'), null);
  const r2 = P.parse('# P x\n## A a\n> 文件：a/**/b.js\n');
  assert.ok(P.nodeForFile(r2, 'a/b.js'));
  assert.ok(P.nodeForFile(r2, 'a/x/y/b.js'));
  assert.ok(!P.nodeForFile(r2, 'a/xb.js'));
});

test('applyOps：加规则、去重忽略标点、删规则、加需求、加文件、改状态', () => {
  const ops = [
    { op: 'add_rule', node: 'C2.1', text: '一屏内出现悬念' },
    { op: 'add_rule', node: 'C2.1', text: '开场用勇士。' }, // 只差标点，应跳过
    { op: 'remove_rule', node: 'C2', text: '不引原话' },
    { op: 'add_node', parent: 'C2', id: 'C2.2', title: '英文版' },
    { op: 'add_node', parent: 'C2', id: 'bad id', title: 'x' }, // ID 不合法，跳过
    { op: 'add_files', node: 'C3', globs: ['Other/**'] },
    { op: 'set_status', node: 'C2.1', status: 'done' },
    { op: 'set_status', node: 'C2.1', status: 'nonsense' },
    { op: 'add_rule', node: 'NOPE', text: 'x' },
  ];
  const { text, applied } = P.applyOps(TREE, ops);
  assert.strictEqual(applied.length, 5);
  assert.ok(!/🆕|🗑/.test(text), '直接生效，不带标记');
  assert.match(text, /^- 一屏内出现悬念$/m);
  assert.ok(!text.includes('不引原话'));
  assert.match(text, /^### C2\.2 英文版$/m);
  assert.match(text, /^> 文件：Other\/\*\*$/m);
  assert.match(text, /### C2\.1 第1章 ✅/);
  // 新需求放在 C2 子树末尾，C3 之前
  assert.ok(lineOf(text, 'C2.2') < lineOf(text, 'C3'));
  assert.deepStrictEqual(P.findById(P.parse(text), 'C3').files, ['Other/**']);
});

test('replace_rule：原地改写并沿用旧的键；模型转述旧规则不逐字也能找到', () => {
  const { text } = P.applyOps(TREE, [{ op: 'replace_rule', node: 'C2.1', old: '开场段落可以到6行', text: '开场段落可以到 8 行' }]);
  assert.strictEqual(text, TREE.replace('- [段落] 开场段落可以到 6 行', '- [段落] 开场段落可以到 8 行'));
  const none = P.applyOps(TREE, [{ op: 'replace_rule', node: 'C2.1', old: '完全不相关的一句话', text: 'x' }]);
  assert.strictEqual(none.applied.length, 0, '找不到旧规则就什么都不做');
});

test('add_rule 带键、本节点已有同键规则：改写那一条（不出现两条同键），撤销还原原文；上级有同键是覆盖，照加', () => {
  // 2026-10-22 实测：Codex 记录员把「每章结尾加一道思考题」加成 P 的第二条 [练习] 规则，同一节点两条同键
  // 「5 行」和「4 行」字面几乎一样，也要改写（不能被去重吞掉）
  const r = P.applyOps(TREE, [{ op: 'add_rule', node: 'P', key: '段落', text: '段落不超过 5 行' }]);
  assert.strictEqual(r.text, TREE.replace('- [段落] 段落不超过 4 行', '- [段落] 段落不超过 5 行'));
  assert.strictEqual(r.applied.length, 1);
  assert.strictEqual(r.applied[0].op, 'replace_rule', '记成改写，改动记录和描述才对');
  assert.strictEqual(r.applied[0].old, '段落不超过 4 行');
  assert.strictEqual(P.applyOps(r.text, r.applied[0].undo).text, TREE, '撤销还原原文和键');
  // 上级 P 有 [语气]，在 C2.1 加 [语气] 是覆盖，照加
  const o = P.applyOps(TREE, [{ op: 'add_rule', node: 'C2.1', key: '语气', text: '开场语气可以紧张一点' }]);
  assert.strictEqual(o.applied[0].op, 'add_rule');
  assert.match(o.text, /^- \[语气\] 开场语气可以紧张一点$/m);
  assert.match(o.text, /^- \[语气\] 语气柔和$/m);
  // 撤销删除（force 还原）不受影响
  const rm = P.applyOps(TREE, [{ op: 'remove_rule', node: 'P', text: '段落不超过 4 行' }]);
  assert.strictEqual(P.applyOps(rm.text, rm.applied[0].undo).text, TREE);
});

test('add_rule：和本节点或上级几乎一样的规则不再加；真正不同的照加', () => {
  const dup = P.applyOps(TREE, [{ op: 'add_rule', node: 'C2.1', text: '段落都不超过 4 行' }]);
  assert.strictEqual(dup.applied.length, 0, '上级已有几乎一样的规则');
  const fresh = P.applyOps(TREE, [{ op: 'add_rule', node: 'C2.1', text: '开场用伦敦地图' }]);
  assert.strictEqual(fresh.applied.length, 1, '和「开场用勇士」字面有重合但意思不同，要加');
});

test('直接生效模式：每种操作都能撤销，撤销后一字不差', () => {
  const cases = [
    { op: 'add_rule', node: 'C2.1', text: '一屏内出现悬念' },
    { op: 'replace_rule', node: 'C2.1', old: '开场用勇士', text: '开场用伦敦地图' },
    { op: 'remove_rule', node: 'C2.1', text: '开场用勇士' },
    { op: 'remove_rule', node: 'P', text: '语气柔和' },
    { op: 'add_node', parent: 'C2', title: '英文版' },
    { op: 'add_files', node: 'C3', globs: ['Other/**'] },
    { op: 'set_files', node: 'C2', globs: ['DS/**', 'DS2/**'] },
    { op: 'set_files', node: 'C2', globs: [] },
    { op: 'set_status', node: 'C2.1', status: 'done' },
    { op: 'set_status', node: 'C2', status: null },
    { op: 'rename_node', node: 'C2.1', title: '第一章' },
    { op: 'delete_node', node: 'C2' },
    { op: 'override_rule', node: 'C2.1', from: 'P', text: '语气柔和', new: '开场可以严肃一点' },
  ];
  for (const c of cases) {
    const r = P.applyOps(TREE, [c]);
    assert.strictEqual(r.applied.length, 1, `${c.op} 没生效`);
    assert.ok(!/🆕|🗑/.test(r.text), `${c.op} 直接生效模式不该有标记`);
    assert.notStrictEqual(r.text, TREE, `${c.op} 没改动`);
    const back = P.applyOps(r.text, r.applied[0].undo);
    assert.strictEqual(back.text, TREE, `${c.op} 撤销后不一致`);
  }
});

test('去重门槛（Dice）：几乎逐字的算重复，短规则不会把包含它的长规则吞掉', () => {
  const dup = [['段落都不超过 4 行', '段落不超过 4 行'], ['每章练习题带解析', '每章练习题都要带解析']];
  const diff = [['用中文', '用中文写注释，但变量名用英文'], ['开场用勇士', '开场用伦敦地图']];
  for (const [a, b] of dup) assert.ok(P.similarity(a, b) >= P.DUPLICATE, `${a} / ${b}：${P.similarity(a, b)}`);
  for (const [a, b] of diff) assert.ok(P.similarity(a, b) < P.DUPLICATE, `${a} / ${b}：${P.similarity(a, b)}`);
  const t = TREE.replace('- [语气] 语气柔和', '- [语气] 语气柔和\n- 用中文');
  assert.strictEqual(P.applyOps(t, [{ op: 'add_rule', node: 'C2.1', text: '用中文写注释，但变量名用英文' }]).applied.length, 1);
});

test('撤销删除需求：删除后上面又多了规则，仍然放回原来的上级下面', () => {
  const del = P.applyOps(TREE, [{ op: 'delete_node', node: 'C2.1' }]);
  // 删除之后，记录员在上方的 P 和 C2 各加了一条规则（行号整体下移）
  const more = P.applyOps(del.text, [{ op: 'add_rule', node: 'P', text: '每章配图' }, { op: 'add_rule', node: 'C2', text: '例子要足' }]);
  const back = P.applyOps(more.text, del.applied[0].undo);
  const root = P.parse(back.text);
  assert.strictEqual(P.findById(root, 'C2.1').parent.id, 'C2');
  assert.deepStrictEqual(P.findById(root, 'C2.1').rules.map(r => r.text), ['开场段落可以到 6 行', '开场用勇士']);
  assert.deepStrictEqual(P.findById(root, 'P').rules.map(r => r.text), ['段落不超过 4 行', '语气柔和', '每章配图']);
  assert.deepStrictEqual(P.findById(root, 'C2').rules.map(r => r.text), ['不引原话', '例子要足']);
  assert.ok(lineOf(back.text, 'C2.1') < lineOf(back.text, '## C3'));
  // 删的是最后一个需求：放回整棵树末尾
  const last = P.applyOps(TREE, [{ op: 'delete_node', node: 'C3' }]);
  const grown = P.applyOps(last.text, [{ op: 'add_rule', node: 'P', text: '每章配图' }]);
  assert.deepStrictEqual(ids(P.applyOps(grown.text, last.applied[0].undo).text), ['P', 'C2', 'C2.1', 'C3']);
});

test('rename_node：没写编号的标题（自动 ID）也能改名', () => {
  const t = TREE + '\n## 手写的需求 🔨\n- 一条规则\n';
  const root = P.parse(t);
  const n = [...P.walk(root)].find(x => x.title === '手写的需求');
  assert.ok(n.autoId);
  const r = P.applyOps(t, [{ op: 'rename_node', node: n.id, title: '改过的名字' }]);
  assert.strictEqual(r.applied.length, 1);
  assert.match(r.text, /^## 改过的名字 🔨$/m);
  assert.strictEqual(P.applyOps(r.text, r.applied[0].undo).text, t);
});

test('override_rule：同一条改写两次不产生重复键；撤销还原上级的键', () => {
  const o = (text, n) => P.applyOps(text, [{ op: 'override_rule', node: 'C2.1', from: 'P', text: '语气柔和', new: n }]);
  const r1 = o(TREE, '开场可以严肃一点');
  const r2 = o(r1.text, '开场可以很严肃');
  assert.deepStrictEqual(P.check(P.parse(r2.text)), [], '不该有重复键');
  const c21 = P.findById(P.parse(r2.text), 'C2.1');
  assert.deepStrictEqual(c21.rules.map(r => r.text), ['开场段落可以到 6 行', '开场用勇士', '开场可以很严肃']);
  const back2 = P.applyOps(r2.text, r2.applied[0].undo);
  assert.strictEqual(back2.text, r1.text, '撤销第二次改写回到第一次的样子');
  assert.strictEqual(P.applyOps(back2.text, r1.applied[0].undo).text, TREE, '再撤销第一次');
  // 上级那条原来没有键：改写时自动补的键，撤销时一起去掉
  const r3 = P.applyOps(TREE, [{ op: 'override_rule', node: 'C2.1', from: 'C2', text: '不引原话', new: '可以引一句原话' }]);
  assert.match(r3.text, /^- \[改写1\] 不引原话$/m);
  assert.strictEqual(P.applyOps(r3.text, r3.applied[0].undo).text, TREE, '上级的键也还原');
});

test('applyOps 不改调用方传入的 op', () => {
  const op = { op: 'add_node', parent: 'C2', title: '英文版' };
  const r = P.applyOps(TREE, [op]);
  assert.strictEqual(r.applied[0].id, 'C2.2');
  assert.strictEqual(op.id, undefined);
});

test('自动分配 ID：P 下沿用兄弟的字母，更深的层用 上级.序号', () => {
  const r = P.applyOps(TREE, [{ op: 'add_node', parent: 'P', title: '新课' }, { op: 'add_node', parent: 'C2', title: '第2章' }]);
  assert.deepStrictEqual(r.applied.map(a => a.id), ['C4', 'C2.2']);
  assert.match(r.text, /^## C4 新课$/m);
  assert.match(r.text, /^### C2\.2 第2章$/m);
});

test('override_rule：上级规则没有键就自动补一个，子规则用同一个键，从而真的覆盖', () => {
  const r = P.applyOps(TREE, [{ op: 'override_rule', node: 'C2.1', from: 'P', text: '语气柔和', new: '开场可以严肃一点' }]);
  const eff = P.effectiveRules(P.findById(P.parse(r.text), 'C2.1')).map(x => x.text);
  assert.ok(eff.includes('开场可以严肃一点'));
  assert.ok(!eff.includes('语气柔和'), '上级那条在 C2.1 里应被取代');
  assert.ok(P.findById(P.parse(r.text), 'C2').rules.length === 1, '别的节点不受影响');
});

test('确认模式的接口已经去掉', () => {
  for (const name of ['resolvePending', 'pendingLines', 'moveRuleUp']) assert.strictEqual(P[name], undefined, name);
  const r = P.applyOps(TREE, [{ op: 'reject_pending', node: 'C2.1', text: '开场用勇士', pending: 'add' }]);
  assert.strictEqual(r.applied.length, 0, '旧的反操作 reject_pending 不再认');
  assert.strictEqual(r.text, TREE);
});

test('setStatusInText 保留 CRLF', () => {
  const crlf = TREE.replace(/\n/g, '\r\n');
  const out = P.setStatusInText(crlf, lineOf(TREE, '### C2.1'), 'doing');
  assert.ok(out.includes('### C2.1 第1章 🔨\r\n'));
  assert.ok(!/[^\r]\n/.test(out));
});

test('outline：保留所有标题，只展开指定分支的规则', () => {
  const o = P.outline(TREE, ['C2.1']);
  assert.match(o, /## C3 别的课/);
  assert.match(o, /开场用勇士/);
  assert.match(o, /段落不超过 4 行/);
  const o2 = P.outline(TREE, []);
  assert.ok(!o2.includes('开场用勇士'));
  assert.match(o2, /2 条规则未列出/);
});

test('relocate（打开原文用）：文件在点击前被改过，按原文找回正确的行', () => {
  const line = lineOf(TREE, '开场用勇士');
  const raw = TREE.split('\n')[line];
  assert.strictEqual(P.relocate(TREE, line, raw), line);
  const shifted = TREE.replace('# P 项目\n', '# P 项目\n- 记录员刚插入的一行\n');
  assert.strictEqual(P.relocate(shifted, line, raw), line + 1);
  assert.strictEqual(P.relocate(TREE.replace(raw, '- 已被改掉'), line, raw), -1);
  assert.strictEqual(P.relocate(TREE, line, undefined), line, '没给原文就信任行号');
});

test('代码块和注释里的内容不当成节点', () => {
  const t = '# P x\n```\n## 不是节点\n```\n<!--\n## 也不是\n-->\n## A 是\n';
  assert.deepStrictEqual(ids(t), ['P', 'A']);
});

// ---------- 跨平台：文件名大小写 ----------

// 临时把 process.platform 换成别的系统（代码在调用时才读 process.platform）
function withPlatform(platform, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...desc, value: platform });
  try { return fn(); } finally { Object.defineProperty(process, 'platform', desc); }
}

test('文件匹配：Windows 和 macOS 不分大小写，Linux 区分', () => {
  const root = P.parse(TREE);
  const hit = platform => withPlatform(platform, () => P.nodeForFile(root, 'datascience/CH01-a.html'));
  assert.strictEqual(hit('win32').id, 'C2.1');
  assert.strictEqual(hit('darwin').id, 'C2.1');
  assert.strictEqual(hit('linux'), null, 'Linux 上 datascience/ 和 DataScience/ 是两个文件夹');
  assert.strictEqual(withPlatform('linux', () => P.nodeForFile(root, 'DataScience/ch01-a.html')).id, 'C2.1');
});

// ---------- 新需求猜对应文件（src/guess.js） ----------

const G = require('../src/guess');
const dirs = (...names) => names.map(p => ({ path: p, dir: true }));
const files = (...names) => names.map(p => ({ path: p, dir: false }));

test('猜文件：英文词和文件夹名重合（驼峰、连字符都拆开），重合多的排前面', () => {
  const top = dirs('DataScience', 'apostles-course', 'education-course', 'UIUX设计', 'tools');
  assert.deepStrictEqual(G.guessGlobs('Data Science 课', top), ['DataScience/**']);
  assert.deepStrictEqual(G.guessGlobs('datascience', top), ['DataScience/**'], '连写的标题也认');
  assert.strictEqual(G.guessGlobs('Apostles course', top)[0], 'apostles-course/**');
  assert.ok(G.guessGlobs('Apostles course', top).length <= 3);
});

test('猜文件：中文标题包含文件夹名；不做拼音和翻译', () => {
  const top = dirs('DataScience', 'UIUX设计', '写作与小说', 'apostles-course');
  assert.deepStrictEqual(G.guessGlobs('UIUX设计课', top), ['UIUX设计/**']);
  assert.deepStrictEqual(G.guessGlobs('写作与小说', top), ['写作与小说/**']);
  assert.deepStrictEqual(G.guessGlobs('十二门徒课', top), []);
  assert.deepStrictEqual(G.guessGlobs('数据科学课', top), []);
});

test('猜文件：第N章 → chNN 开头的文件，连同扩展名；中文数字、ch3、Chapter 3 也认', () => {
  const ds = files('DataScience/ch01-intro.html', 'DataScience/ch03-regression.html', 'DataScience/ch13-x.html', 'DataScience/index.html');
  assert.deepStrictEqual(G.guessGlobs('第3章 回归', ds), ['DataScience/ch03-*.html']);
  assert.deepStrictEqual(G.guessGlobs('第三章', ds), ['DataScience/ch03-*.html']);
  assert.deepStrictEqual(G.guessGlobs('ch3 regression', ds), ['DataScience/ch03-*.html']);
  assert.deepStrictEqual(G.guessGlobs('Chapter 1', ds), ['DataScience/ch01-*.html'], '不会配到 ch13');
  assert.deepStrictEqual(G.guessGlobs('第十三章', ds), ['DataScience/ch13-*.html']);
  // 数字开头的文件名、扩展名不一致、文件夹
  assert.deepStrictEqual(G.guessGlobs('第1章', files('UIUX设计/01-UIUX核心入门.html', 'UIUX设计/10-x.html')), ['UIUX设计/01-*.html']);
  assert.deepStrictEqual(G.guessGlobs('第2章', files('a/ch02-x.html', 'a/ch02-x.js')), ['a/ch02-*']);
  assert.deepStrictEqual(G.guessGlobs('第3关', dirs('game/level-03', 'game/level-04')), ['game/level-03/**']);
  assert.deepStrictEqual(G.guessGlobs('第9章', ds), []);
});

test('猜文件：候选从上级范围里列（上级没有文件对应时列项目顶层文件夹），跳过隐藏文件夹和 node_modules', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqtree-guess-'));
  for (const d of ['DataScience/en', '.claude', 'node_modules', 'apostles-course']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, 'DataScience', 'ch02-a.html'), '');
  fs.writeFileSync(path.join(dir, 'README.md'), '');
  const top = G.candidates(dir, []).map(c => c.path).sort();
  assert.deepStrictEqual(top, ['DataScience', 'apostles-course']);
  const inner = G.candidates(dir, ['DataScience/**', 'DataScience/ch0*.html']);
  assert.deepStrictEqual(inner.map(c => `${c.path}${c.dir ? '/' : ''}`).sort(), ['DataScience/ch02-a.html', 'DataScience/en/']);
  assert.deepStrictEqual(G.suggest(dir, '第2章', ['DataScience/**']), ['DataScience/ch02-*.html']);
  assert.deepStrictEqual(G.suggest(dir, 'Apostles', []), ['apostles-course/**']);
  assert.deepStrictEqual(G.candidates(dir, ['不存在/**']), []);
});

test('文件对应：花括号里的逗号不拆开，{a,b} 能匹配（education-course/{ch18,ch19}-*.html）', () => {
  const root = P.parse('# P 项目\n## C1 课\n> 文件：education-course/{ch18,ch19}-*.html, notes/**\n- 规则\n');
  const c1 = P.findById(root, 'C1');
  assert.deepStrictEqual(c1.files, ['education-course/{ch18,ch19}-*.html', 'notes/**']);
  assert.strictEqual(P.nodeForFile(root, 'education-course/ch18-a.html'), c1);
  assert.strictEqual(P.nodeForFile(root, 'education-course/ch19-b.html'), c1);
  assert.strictEqual(P.nodeForFile(root, 'education-course/ch20-c.html'), null);
  assert.strictEqual(P.nodeForFile(root, 'notes/x.md'), c1);
  const nested = P.parse('# P 项目\n## C1 课\n> 文件：a/{b,c/{d,e}}.md\n');
  assert.ok(['a/b.md', 'a/c/d.md', 'a/c/e.md'].every(f => P.nodeForFile(nested, f)));
  assert.strictEqual(P.nodeForFile(nested, 'a/c.md'), null);
});

test('没写编号的标题自动补的 ID 不和树里任何手写 ID 撞（撞了编译会互相覆盖）', () => {
  const root = P.parse('# P 项目\n## C3 课\n### 没写编号的小节\n### C3.1 手写\n### C3.2 手写\n### 又一个没编号的\n## 没编号的课\n## N1 手写的 N1\n');
  const all = [...P.walk(root)].map(n => n.id);
  assert.strictEqual(new Set(all).size, all.length, `有重复：${all.join(',')}`);
  assert.deepStrictEqual(['C3.1', 'C3.2', 'N1'].map(id => P.findById(root, id).title), ['手写', '手写', '手写的 N1']);
});
