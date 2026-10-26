'use strict';
// 0.20：代码地图融进需求树（谁用谁、名字在哪）、能写成检查的规则、文档之间的矛盾
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SANDBOX = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reqtree-sandbox-')));
process.env.TEMP = process.env.TMP = process.env.TMPDIR = SANDBOX;
process.env.REQTREE_HOME = path.join(SANDBOX, 'home', '.reqtree');
process.env.CLAUDE_CONFIG_DIR = path.join(SANDBOX, 'claude-config');

const store = require('../src/store');
const C = require('../src/codemap');
const H = require('./ia-measure');
const RC = require('../src/rulecheck');
const Checks = require('../src/checks');
const Init = require('../src/init');
const { parse } = require('../src/parser');
const { placeByFile } = require('../hooks/recorder');

// 一个小 Godot 项目：shop_hours.gd 放在行人那块（runtime/），用它的却都是店铺代码；Tuning 谁都用（公共模块）
const FILES = {
  'project.godot': '[autoload]\nTuning="*res://systems/tuning.gd"\n',
  'systems/tuning.gd': '## 玩法数值的唯一入口\nextends Node\nfunc f(k):\n\treturn 0\n',
  'runtime/shop_hours.gd': '## 营业时间\nclass_name ShopHours\nstatic func is_open():\n\treturn true\n',
  'shops/shop_a.gd': 'extends Node\nfunc a():\n\tShopHours.is_open()\n\tTuning.f("a")\n',
  'shops/shop_b.gd': 'extends Node\nfunc b():\n\tShopHours.is_open()\n\tTuning.f("b")\n',
  'shops/shop_c.gd': 'extends Node\nfunc c():\n\tShopHours.is_open()\n',
  'crowd/walker.gd': 'extends Node\nfunc w():\n\tTuning.f("w")\n',
  'ui/panel.gd': 'extends Node\nfunc p():\n\tTuning.f("p")\n',
  'tests/test_hours.gd': 'extends Node\nfunc t():\n\tShopHours.is_open()\n\tTuning.f("t")\n',
  'tools/test.sh': '#!/bin/sh\nTEST_TIMEOUT=${TEST_TIMEOUT:-600} godot --headless\n',
  'docs/a.md': '# 店铺规范\n\n- 每章 3 道题\n',
  'docs/b.md': '# 写作规范\n\n- 每章 5 道题\n',
};
const many = n => Array.from({ length: n }, (_, i) => `- 店铺规则第 ${i + 1} 条`).join('\n');
const TREE = `# P 小游戏
- 用中文回复
- 派工前确认内存够

## R1 店铺
> 文件：shops/**
> 文档：docs/a.md
${many(13)}

## R2 行人
> 文件：crowd/**, runtime/**
- 营业时间只从 \`ShopHours\` 读
- 用 OldTimer 计时

## R3 界面
> 文件：ui/**
> 文档：docs/b.md

## R4 代码规范
> 文件：**/*.gd
- 不留调试输出 print
`;
function project(tree = TREE) {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'p-'));
  for (const [f, t] of Object.entries(FILES)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); }
  fs.writeFileSync(path.join(dir, '需求树.md'), tree);
  return { dir, tree: path.join(dir, '需求树.md') };
}

test('谁用谁：几乎只被另一个需求用的文件算挂错；被三个以上顶层需求用的是公共模块，不判；测试文件不算用的人', () => {
  const { dir } = project();
  const g = C.build(dir);
  const pl = C.placement(g, parse(TREE));
  const hours = pl.find(p => p.file === 'runtime/shop_hours.gd');
  assert.strictEqual(hours.node, 'R2');
  assert.strictEqual(hours.misplaced, 'R1', JSON.stringify(hours));
  assert.deepStrictEqual(hours.by, [['R1', 3]], '测试文件不算');
  const tuning = pl.find(p => p.file === 'systems/tuning.gd');
  assert.ok(tuning.shared && !tuning.misplaced, JSON.stringify(tuning));
  assert.ok(!pl.some(p => p.file.startsWith('tests/')), '测试文件自己不判');
  assert.ok(g.words.has('is_open') && g.words.has('ShopHours'));
  assert.strictEqual(g.owners.get('ShopHours'), 'runtime/shop_hours.gd');
});

test('代码地图重建时记下名字 → 文件，公共模块的名字不记', () => {
  const { tree } = project();
  C.refresh(tree);
  const owners = C.ownersOf(tree);
  assert.strictEqual(owners.ShopHours, 'runtime/shop_hours.gd');
  assert.ok(!owners.Tuning, 'Tuning 谁都用，按它挂规则会挂错');
});

test('记录员：规则只提到名字时按定义它的文件挂；按内容分的需求优先于按文件类型横切的', () => {
  const root = parse(TREE);
  const owners = { ShopHours: 'runtime/shop_hours.gd' };
  const [op] = placeByFile([{ op: 'add_rule', node: 'R3', text: '营业时间只从 ShopHours 读，别自己算' }], { root, owners });
  assert.strictEqual(op.node, 'R2');
  assert.ok(!('file' in op));
  // 名字对不上任何文件：照模型的挂
  assert.strictEqual(placeByFile([{ op: 'add_rule', node: 'R3', text: '按钮用圆角' }], { root, owners })[0].node, 'R3');
});

test('过时的证据：规则里的代码名字在代码里一个都找不到；还在的、文件夹名不算', () => {
  const { dir } = project();
  const g = C.build(dir);
  const files = C.listFiles(dir, { any: true });
  const ev = RC.staleEvidence(TREE, files, null, g.words);
  assert.deepStrictEqual(ev.map(e => e.text), ['用 OldTimer 计时']);
  assert.match(ev[0].why, /OldTimer/);
  assert.deepStrictEqual(RC.staleEvidence(TREE, files), [], '没给代码里的名字就不查');
  assert.deepStrictEqual(RC.codeNames('只改 `shop_hours` 和 EventBus，不碰 a_b'), ['shop_hours', 'EventBus']);
});

test('实测用的信息架构数字：结构、送到的规则和字数、代码挂错都算出来', () => {
  const { dir, tree } = project();
  store.compileTree(tree, { force: true });
  const h = H.measure(tree, { graph: C.build(dir) });
  assert.strictEqual(h.structure.rules, 18);
  assert.strictEqual(h.structure.rootRules, 2);
  assert.deepStrictEqual(h.structure.big, [{ node: 'R1', rules: 13 }]);
  // shops/shop_a.gd：根 2 条 + R1 13 条 + R4 1 条
  assert.ok(h.load.rules.max >= 16, JSON.stringify(h.load.rules));
  assert.ok(h.load.chars.avg > 0 && h.load.always > 0);
  assert.deepStrictEqual(h.code.misplaced.map(m => [m.file, m.to]), [['runtime/shop_hours.gd', 'R1']]);
});

test('整理的材料：代码的用途和谁在用、公共模块标出来、可能挂错的列出来；提示词让根上只留改什么都要守的', () => {
  const { dir } = project();
  const g = Init.gather(dir, TREE, { reorganize: true });
  assert.match(g.code, /runtime\/shop_hours\.gd：营业时间（被 3 个文件用：shops 3）/);
  assert.match(g.code, /systems\/tuning\.gd：玩法数值的唯一入口（被 4 个文件用，公共/);
  assert.match(g.misplaced, /runtime\/shop_hours\.gd 现在归 R2，用它的文件里 3 个在 R1/);
  const p = Init.buildPrompt(g);
  assert.match(p, /## 代码/);
  assert.match(p, /根上的规则改任何文件都会送到/);
  assert.match(p, /标「公共」的模块/);
  // 没有代码的项目不提代码
  assert.doesNotMatch(Init.buildPrompt({ ...g, code: '', misplaced: '' }), /## 代码/);
});

test('该重新整理的迹象：根上规则太多、挂错的代码文件多', () => {
  const root = `# P x\n${Array.from({ length: 24 }, (_, i) => `- 全局 ${i}`).join('\n')}\n\n## R1 城市\n> 文件：game/**\n- 一条\n`;
  assert.deepStrictEqual(Init.needsReorganize(root).map(w => w.k), ['root']);
  assert.deepStrictEqual(Init.needsReorganize('# P x\n\n## R1 城市\n> 文件：game/**\n- 一条\n', { misplaced: 5 }).map(w => w.k), ['misplaced']);
  assert.deepStrictEqual(Init.needsReorganize('# P x\n\n## R1 城市\n> 文件：game/**\n- 一条\n', { misplaced: 4 }), []);
});

test('能写成检查的规则：核对后存下（正则不合法、匹配空串、太宽、规则不在的不要），改完文件查新写的内容', () => {
  const { dir, tree } = project();
  const files = C.listFiles(dir, { any: true });
  const r = Checks.save(tree, TREE, [
    { node: 'R4', rule: '不留调试输出 print', glob: '**/*.gd', forbid: '^\\s*print\\(', why: '调试输出' },
    { node: 'R4', rule: '不留调试输出 print', glob: '**/*.gd', forbid: '(', why: '坏的' },
    { node: 'R4', rule: '没有这条', glob: '**/*.gd', forbid: 'x', why: '' },
    { node: 'R2', rule: '用 OldTimer 计时', glob: 'crowd/**', forbid: '.*', why: '匹配空串' },
    { node: 'R4', rule: '不留调试输出 print', glob: '**/*.gd', forbid: '^extends', why: '太宽：现有文件一半以上都有' },
  ], { files });
  assert.strictEqual(r.saved.length, 1);
  assert.deepStrictEqual(r.dropped.map(d => d.reason), ['bad-regex', 'no-rule', 'matches-empty', 'too-broad']);
  const root = parse(TREE);
  assert.match(Checks.run(tree, root, 'shops/shop_a.gd', 'func x():\n\tprint("调试")\n'), /R4「不留调试输出 print」：「print\("调试"\)」/);
  assert.strictEqual(Checks.run(tree, root, 'shops/shop_a.gd', 'func x():\n\treturn 1\n'), '');
  assert.strictEqual(Checks.run(tree, root, 'docs/a.md', 'print("x")'), '', 'glob 不匹配');
  // 规则删了，检查跟着失效
  assert.strictEqual(Checks.run(tree, parse(TREE.replace('- 不留调试输出 print\n', '')), 'shops/shop_a.gd', 'print(1)'), '');
  // 增量：只换掉这次看过的规则的检查
  const again = Checks.save(tree, TREE, [], { files, considered: new Set([RC.ruleKey('R2', '用 OldTimer 计时')]) });
  assert.strictEqual(again.total, 1, '没看过的规则的检查留着');
  assert.strictEqual(Checks.save(tree, TREE, [], { files }).total, 0, '全部重查时没给就清掉');
});

test('编辑工具写进去的文字、Codex 补丁加进去的行', () => {
  assert.strictEqual(Checks.addedText({ file_path: 'a', old_string: 'x', new_string: 'y' }), 'y');
  assert.strictEqual(Checks.addedText({ file_path: 'a', content: 'z' }), 'z');
  assert.strictEqual(Checks.addedText({ edits: [{ new_string: 'a' }, { new_string: 'b' }] }), 'a\nb');
  const m = Checks.patchAdded('*** Begin Patch\n*** Update File: shops/a.gd\n@@\n-old\n+print(1)\n context\n*** Add File: b.gd\n+x\n*** End Patch');
  assert.deepStrictEqual([...m], [['shops/a.gd', 'print(1)\n'], ['b.gd', 'x\n']]);
});

test('hook：AI 改完文件，可能违反检查的写法就在下一次请求时提醒它', () => {
  const { dir, tree } = project();
  store.compileTree(tree, { force: true });
  Checks.save(tree, TREE, [{ node: 'R4', rule: '不留调试输出 print', glob: '**/*.gd', forbid: '^\\s*print\\(' }], { files: C.listFiles(dir, { any: true }) });
  const run = ti => {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'hook.js')], {
      input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Edit', cwd: dir, session_id: 's1', tool_input: ti }),
      encoding: 'utf8', env: { ...process.env, REQTREE_FALLBACK_WAIT_MS: '0' },
    });
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '';
  };
  assert.match(run({ file_path: path.join(dir, 'shops/shop_a.gd'), old_string: 'x', new_string: '\tprint("debug")' }), /可能不符合/);
  assert.strictEqual(run({ file_path: path.join(dir, 'shops/shop_a.gd'), old_string: 'x', new_string: '\treturn 1' }), '');
});

test('体检：两份文档说法矛盾，按后改的那份改先改的；分不出先后的列进报告，不动', async () => {
  const { runCheckup } = require('../src/checkup');
  const clash = { kind: 'clash', doc: 'docs/a.md', text: '每章 3 道题', new: '每章 5 道题', other: 'docs/b.md', otherText: '每章 5 道题', otherNew: '每章 3 道题' };
  const ask = async () => ({ questions: [], docs: [clash] });
  const { dir, tree } = project();
  const old = Date.now() / 1000 - 86400 * 3;
  fs.utimesSync(path.join(dir, 'docs/a.md'), old, old);
  const r = await runCheckup(tree, { ask, memory: false, parts: { rules: false, memory: false } });
  assert.match(fs.readFileSync(path.join(dir, 'docs/a.md'), 'utf8'), /每章 5 道题/, 'a.md 是先改的，跟着 b.md 改');
  assert.match(fs.readFileSync(path.join(dir, 'docs/b.md'), 'utf8'), /每章 5 道题/);
  assert.ok(r.auto.some(a => a.t && a.t.k === 'q.autoDocClash'));
  // 两份同时改的：不动，报告里列出
  const p2 = project();
  const now = Date.now() / 1000;
  for (const f of ['docs/a.md', 'docs/b.md']) fs.utimesSync(path.join(p2.dir, f), now, now);
  const r2 = await runCheckup(p2.tree, { ask, memory: false, parts: { rules: false, memory: false } });
  assert.strictEqual(r2.docClash.length, 1);
  assert.match(fs.readFileSync(path.join(p2.dir, 'docs/a.md'), 'utf8'), /每章 3 道题/);
});

test('代码地图只给最下一层的需求出：上级和下级各一份的话，改一个文件两份一起送到', () => {
  const tree = TREE.replace('## R2 行人\n> 文件：crowd/**, runtime/**', '## R2 行人\n> 文件：crowd/**, runtime/**\n\n### R2.1 营业时间\n> 文件：runtime/**');
  const { dir, tree: tp } = project(tree);
  store.compileTree(tp, { force: true });
  const r = C.refresh(tp);
  assert.ok(r.nodes.includes('R2.1') && !r.nodes.includes('R2'), JSON.stringify(r.nodes));
  assert.ok(fs.existsSync(path.join(dir, '.reqtree', 'map', 'R2.1.md')));
  assert.ok(!fs.existsSync(path.join(dir, '.reqtree', 'map', 'R2.md')));
});

test('查过时规则时，脚本、配置里的名字也算「还在」（TEST_TIMEOUT 在 tools/test.sh 里用着，不能当过时删）', () => {
  const { dir } = project();
  assert.ok(!C.build(dir).words.has('TEST_TIMEOUT'), '重建地图时不读脚本');
  const words = C.build(dir, { allWords: true }).words;
  assert.ok(words.has('TEST_TIMEOUT'));
  const tree = '# P x\n\n## R1 测试\n> 文件：tools/**\n- 跑全量要设 TEST_TIMEOUT=7200\n- 用 OldRunner 跑测试\n';
  assert.deepStrictEqual(RC.staleEvidence(tree, C.listFiles(dir, { any: true }), null, words).map(e => e.text), ['用 OldRunner 跑测试']);
});
