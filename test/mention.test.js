'use strict';
// 用户提到某个需求时补上它的规则（动手改文件之前的讨论拿不到路径规则）；编译说明里「不要再记进记忆」
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// 真实路径：Windows CI 上 os.tmpdir() 是 8.3 短路径（RUNNER~1），hook 记的是 realpath，两边要一致
const SANDBOX = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reqtree-mention-')));
process.env.TEMP = process.env.TMP = process.env.TMPDIR = SANDBOX;
process.env.REQTREE_HOME = path.join(SANDBOX, 'home', '.reqtree');

const { parse } = require('../src/parser');
const M = require('../src/mention');
const { compile, ensureCompiled } = require('../src/compile');
const inst = require('../src/targets/codex-install');

const HOOK = path.join(__dirname, '..', 'hooks', 'hook.js');
const CODEX_HOOK = path.join(__dirname, '..', 'hooks', 'codex-hook.js');

const TREE = `# P 课程项目
- [段落] 段落不超过 4 行

## C1 数据科学课 🔨
> 文件：DataScience/**
- 不引原话

### C1.1 第1章 🔨
> 文件：DataScience/ch01-*.html
- 开场用霍乱的故事

#### C1.1.1 开场故事
- [段落] 开场段落可以到 6 行

### C1.2 相关与因果
> 文件：DataScience/ch02-*.html
- 用冰淇淋和溺水的例子

## C2 英语课 ⏳
> 文件：English/**
- 例句全英文

### C2.1 第1章
> 文件：English/ch01-*.html
- 段落可以到 6 行

## X 一
- 标题只有一个字，不该被匹配
`;
const root = parse(TREE);
const ids = p => M.mentionedNodes(root, p).map(n => n.id);

test('匹配：标题、编号、第N章（含中文数字、chapter、文件里的 ch02）', () => {
  assert.deepStrictEqual(ids('相关与因果那章怎么开场'), ['C1.2']);
  assert.deepStrictEqual(ids('C1.2 的例子换一个'), ['C1.2']);
  assert.deepStrictEqual(ids('第二章怎么设计'), [], '第二章是弱匹配：两门课，没说哪门');
  assert.deepStrictEqual(M.mentionedNodes(root, '第二章怎么设计', { active: ['C1.1'] }).map(n => n.id), ['C1.2'], '第二章 ↔ 文件 ch02，最近在数据科学课干活');
  assert.deepStrictEqual(ids('英语课 chapter 1 写什么'), ['C2.1']);
  assert.deepStrictEqual(ids('今天先不写了'), []);
  assert.deepStrictEqual(ids('一'), [], '标题短于 2 个字不匹配');
  assert.deepStrictEqual(ids('课程项目的规矩'), [], '根节点不匹配（它的规则本来就全局加载）');
  assert.deepStrictEqual(ids('C1.21 是什么'), [], '编号要整词');
});

test('匹配：上下级都命中只给下级；重名时上级被提到的优先，否则看最近在哪门课干活；最多 3 个', () => {
  assert.deepStrictEqual(ids('数据科学课第1章开头用什么'), ['C1.1']);
  assert.deepStrictEqual(ids('英语课第1章开头用什么'), ['C2.1']);
  assert.deepStrictEqual(ids('第1章开头用什么'), [], '两门课都有第1章，没说哪门');
  assert.deepStrictEqual(M.mentionedNodes(root, '第1章开头用什么', { active: ['C2'] }).map(n => n.id), ['C2.1']);
  assert.ok(M.mentionedNodes(root, 'C1.1、C1.2、C2.1、C1.1.1 都看看').length <= 3);
});

test('规则段：带上级（不含根）的规则、没写文件的子需求、覆盖说明；不写根节点规则', () => {
  const t = M.renderNode(root.children[0].children[0].children[0]); // C1.1
  assert.match(t, /^## 需求 P 课程项目 → C1 数据科学课 → C1\.1 第1章\n适用文件：DataScience\/ch01-\*\.html/);
  assert.match(t, /- 不引原话（来自上级 C1）/);
  assert.match(t, /- 开场用霍乱的故事/);
  assert.match(t, /### C1\.1\.1 开场故事\n- 开场段落可以到 6 行（在本范围内以此为准，取代上级 P 的「段落不超过 4 行」）/);
  assert.ok(!/^- 段落不超过 4 行/m.test(t));
  const big = parse(TREE.replace('- 开场用霍乱的故事', Array.from({ length: 80 }, (_, i) => `- 第 ${i} 条很长很长的规则，凑字数凑字数`).join('\n')));
  const m = M.mentionContext(big, '第1章和相关与因果');
  assert.ok(m.text.length < M.MAX_CHARS + 200, `总长受限：${m.text.length}`);
});

// ---------- hook 端到端 ----------
function project() {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'proj-'));
  fs.writeFileSync(path.join(dir, '需求树.md'), TREE);
  return dir;
}
function run(hook, input, env = {}) {
  const r = spawnSync(process.execPath, [hook], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env } });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}
const ctx = o => o && o.hookSpecificOutput && o.hookSpecificOutput.additionalContext;

test('Claude hook：提到第1章就补上它的规则，每会话一次；压缩后重送；别的会话照送；可以关掉', () => {
  const dir = project();
  const ask = (session, prompt, env) => run(HOOK, { hook_event_name: 'UserPromptSubmit', session_id: session, cwd: dir, prompt }, env);
  const first = ask('a', '数据科学课第1章开场段落最多几行？');
  assert.strictEqual(first.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(ctx(first), /开场段落可以到 6 行/);
  assert.ok(!/例句全英文/.test(ctx(first)), '英语课的不送');
  assert.strictEqual(ask('a', '那数据科学课第1章的练习呢'), null, '同一会话不再送');
  assert.match(ctx(ask('a', '相关与因果那章呢')), /冰淇淋/, '新提到的照送');
  run(HOOK, { hook_event_name: 'PreCompact', session_id: 'a', cwd: dir, trigger: 'auto' }, { REQTREE_SWEEP_EVERY: '0' });
  assert.match(ctx(ask('a', '数据科学课第1章再看一下')), /霍乱/, '压缩后重送');
  assert.match(ctx(ask('b', '数据科学课第1章开场')), /霍乱/);
  assert.strictEqual(ask('c', '数据科学课第1章开场', { REQTREE_NO_MENTION: '1' }), null);
  assert.strictEqual(ask('d', '今天先这样'), null);
});

test('Codex hook：提到的需求送一次，之后读那一章的文件不再重复送', () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, 'DataScience'));
  fs.writeFileSync(path.join(dir, 'DataScience', 'ch01-a.html'), '<p>1</p>');
  inst.installCodex(dir);
  const base = { session_id: 'cx', cwd: dir };
  run(CODEX_HOOK, { ...base, hook_event_name: 'SessionStart', source: 'startup' });
  const o = run(CODEX_HOOK, { ...base, hook_event_name: 'UserPromptSubmit', prompt: '数据科学课第1章开场段落最多几行？' });
  assert.match(ctx(o), /开场段落可以到 6 行/);
  assert.strictEqual(run(CODEX_HOOK, { ...base, hook_event_name: 'UserPromptSubmit', prompt: '第1章再说说' }), null);
  assert.strictEqual(run(CODEX_HOOK, { ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cat DataScience/ch01-a.html' } }), null, 'C1.1 的单元已记成送过');
});

test('编译说明：长期要求只记在树里，不要再写进记忆 / CLAUDE.md / AGENTS.md；格式版本升了，旧项目会重编', () => {
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  compile(tree, { targets: { claude: true, codex: true } });
  const idx = fs.readFileSync(path.join(dir, '.claude', 'rules', 'reqtree', '_index.md'), 'utf8');
  assert.match(idx, /reqtree:format 10/);
  assert.match(idx, /不要再写进记忆（memory）或 CLAUDE\.md/);
  assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /不要再写进记忆（memory）或 AGENTS\.md/);
  // 旧格式的 _index.md 比树新也要重编
  const p = path.join(dir, '.claude', 'rules', 'reqtree', '_index.md');
  fs.writeFileSync(p, idx.replace('reqtree:format 10', 'reqtree:format 2').replace(/不要再写进记忆.*\n/, ''));
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(p, later, later);
  assert.ok(ensureCompiled(tree));
  assert.match(fs.readFileSync(p, 'utf8'), /不要再写进记忆/);
});
