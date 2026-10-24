'use strict';
// 代码地图（src/codemap.js）：按代码生成「这块已有什么」，改到对应文件时加载；命令行查名字在哪定义、谁在用
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

const C = require('../src/codemap');
const { compile } = require('../src/compile');

function write(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
}

// 一个小 Godot 项目：EventBus 单例发信号，Economy 单例管钱，两个玩法脚本用它们
function godot() {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'g-'));
  write(dir, {
    'game/project.godot': '[application]\nconfig/name="x"\n\n[autoload]\n\nEventBus="*res://systems/event_bus.gd"\nEconomy="*res://systems/economy.gd"\n',
    'game/systems/event_bus.gd': 'extends Node\n## 全局信号。系统之间的通知都走这里\n\nsignal money_changed(money: int)\nsignal day_started(day: int)\n',
    'game/systems/economy.gd': 'extends Node\n## 钱和账本\n\nvar money := 0\n\nfunc add_money(n: int) -> void:\n\tmoney += n\n\tEventBus.money_changed.emit(money)\n\nfunc _ready() -> void:\n\tpass\n',
    'game/gameplay/shop.gd': 'class_name Shop\nextends Node\n## 一家店\n\nfunc buy(price: int) -> void:\n\tEconomy.add_money(-price)\n\nfunc _ready() -> void:\n\tEventBus.day_started.connect(_on_day)\n',
    'game/gameplay/stall.gd': 'extends Node\n## 路边摊\n\nvar shop: Shop\n\nfunc sell() -> void:\n\tEconomy.add_money(3)\n',
    'game/gameplay/stall.tscn': '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://gameplay/stall.gd" id="1"]\n\n[node name="Stall" type="Node3D"]\n',
    'game/addons/plugin/x.gd': 'func third_party() -> void:\n\tpass\n',
    '需求树.md': '# P 游戏\n\n## G1 玩法\n> 文件：game/gameplay/**\n- 店的价格从 Tuning 读\n\n## S1 系统\n> 文件：game/systems/**\n- 系统之间用 EventBus 通知\n',
  });
  return { dir, tree: path.join(dir, '需求树.md') };
}

test('GDScript：class_name、对外函数、信号、文件开头的说明；_ 开头的不算对外', () => {
  const r = C.readGd('class_name Shop\nextends Node\n## 一家店\n\nsignal sold(n)\nfunc buy(p: int) -> void:\n\tEventBus.money_changed.emit(1)\n\tEventBus.day_started.connect(f)\nfunc _ready():\n\tpass\n');
  assert.strictEqual(r.summary, '一家店');
  assert.deepStrictEqual(r.defs.map(d => [d.name, d.kind, d.pub]), [['Shop', 'class', true], ['sold', 'signal', true], ['buy', 'func', true], ['_ready', 'func', false]]);
  assert.deepStrictEqual(r.globals, ['Shop']);
  assert.deepStrictEqual(r.emits, ['EventBus.money_changed']);
  assert.deepStrictEqual(r.listens, ['EventBus.day_started']);
});

test('JS：立即执行函数里的函数、window.X 的成员；对象字面量的键', () => {
  const r = C.readJs('/* 共享脚本\n   内容：…*/\n(function () {\n  function toast(m) {}\n  const helper = x => x;\n  const DS = { toast, mountQuiz: () => 1, store };\n  window.DS = DS;\n})();\n');
  assert.strictEqual(r.summary, '共享脚本');
  assert.deepStrictEqual(r.defs.map(d => d.name), ['toast', 'helper']);
  assert.deepStrictEqual(r.globals, ['DS']);
  assert.deepStrictEqual(r.members.DS, ['toast', 'mountQuiz', 'store']);
});

test('建图：单例、class_name、场景挂的脚本都算引用；Godot 的 addons 不看', () => {
  const { dir } = godot();
  const g = C.build(dir);
  assert.ok(!g.files.has('game/addons/plugin/x.gd'));
  const users = f => [...(g.refs.get(f) || [])].sort();
  assert.deepStrictEqual(users('game/systems/economy.gd'), ['game/gameplay/shop.gd', 'game/gameplay/stall.gd']);
  assert.deepStrictEqual(users('game/systems/event_bus.gd'), ['game/gameplay/shop.gd', 'game/systems/economy.gd']);
  assert.deepStrictEqual(users('game/gameplay/shop.gd'), ['game/gameplay/stall.gd'], 'var shop: Shop 用到了 class_name');
  assert.deepStrictEqual(users('game/gameplay/stall.gd'), ['game/gameplay/stall.tscn']);
  assert.strictEqual(g.memberUse.get('game/systems/economy.gd').get('add_money'), 2);
});

test('网页：每门课各有一个 window.ILLUS，算到同一门课的那个；HTML 正文里的英文单词不算调用', () => {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'w-'));
  write(dir, {
    'a/js/illus.js': '(function(){ window.ILLUS = { cat: 1 }; })();\n',
    'b/js/illus.js': '(function(){ window.ILLUS = { dog: 1 }; })();\n',
    'b/js/common.js': '/* B 课共享脚本 */\nfunction mountQuiz() {}\n',
    'a/ch01.html': '<title>A1</title><script src="js/illus.js"></script><script>ILLUS.cat;</script>',
    'b/ch01.html': '<title>B1</title><p>mountQuiz() is allowed here</p><script>ILLUS.dog; mountQuiz();</script>',
    'b/ch02.html': '<title>B2</title><p>please mountQuiz() later</p>',
  });
  const g = C.build(dir);
  const users = f => [...(g.refs.get(f) || [])].sort();
  assert.deepStrictEqual(users('a/js/illus.js'), ['a/ch01.html']);
  assert.deepStrictEqual(users('b/js/illus.js'), ['b/ch01.html']);
  assert.deepStrictEqual(users('b/js/common.js'), ['b/ch01.html'], '只有脚本里的调用算');
});

test('重建地图：每个需求一份（同样的 paths），写了外部依赖和信号；编译不删地图；没用了的地图删掉；总目录写上查名字的命令', () => {
  const { dir, tree } = godot();
  compile(tree, { targets: { claude: true } });
  const r = C.refresh(tree, { targets: { claude: true } });
  assert.deepStrictEqual(r.nodes.sort(), ['G1', 'S1']);
  const rules = path.join(dir, '.claude', 'rules', 'reqtree');
  const g1 = fs.readFileSync(path.join(rules, 'map-G1.md'), 'utf8');
  assert.match(g1, /^---\npaths:\n  - "game\/gameplay\/\*\*"\n---/);
  assert.match(g1, /`game\/gameplay\/shop\.gd`（被 1 个文件用） 一家店。对外：Shop、buy/);
  assert.match(g1, /这块用到的外部模块：[\s\S]*`game\/systems\/economy\.gd`（这块有 2 个文件用） 钱和账本。对外：Economy\.add_money/);
  assert.match(g1, /监听的信号：EventBus\.day_started/);
  assert.match(g1, /codemap\.js who 名字/);
  const glob = fs.readFileSync(path.join(rules, '_map.md'), 'utf8');
  assert.match(glob, /自动加载的单例（全局可用，按使用多少排）：(Economy、EventBus|EventBus、Economy)$/m);
  assert.match(fs.readFileSync(path.join(rules, '_index.md'), 'utf8'), /codemap\.js who 名字/, '第一次建完重新编译了总目录');
  // 编译不删地图；内容没变不重写
  compile(tree, { targets: { claude: true } });
  assert.ok(fs.existsSync(path.join(rules, 'map-G1.md')));
  assert.deepStrictEqual(C.refresh(tree, { targets: { claude: true } }).written, []);
  // 需求删掉了，它的地图也删
  fs.writeFileSync(tree, '# P 游戏\n\n## S1 系统\n> 文件：game/systems/**\n');
  const r2 = C.refresh(tree, { targets: { claude: true } });
  assert.ok(!fs.existsSync(path.join(rules, 'map-G1.md')));
  assert.ok(r2.removed.some(p => p.endsWith('map-G1.md')));
});

test('查名字：定义在哪、谁在用；信号分成发出和监听；查文件：被谁用', () => {
  const { dir } = godot();
  const add = C.who(dir, 'add_money');
  assert.match(add, /定义：\n  game\/systems\/economy\.gd:6  func add_money\(n: int\) -> void/);
  assert.match(add, /game\/gameplay\/shop\.gd:6/);
  const sig = C.who(dir, 'money_changed');
  assert.match(sig, /发出（emit）：\n  game\/systems\/economy\.gd:8/);
  const day = C.who(dir, 'day_started');
  assert.match(day, /监听（connect）：\n  game\/gameplay\/shop\.gd:9/);
  const f = C.who(dir, 'systems/economy.gd');
  assert.match(f, /^game\/systems\/economy\.gd：钱和账本/);
  assert.match(f, /被 2 个文件用/);
  // 命令行
  const out = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'codemap.js'), 'who', 'Shop', dir], { encoding: 'utf8' });
  assert.strictEqual(out.status, 0, out.stderr);
  assert.match(out.stdout, /game\/gameplay\/shop\.gd/);
});
