'use strict';
// 第三轮审查发现的问题的回归测试（每条先在旧代码上确认失败，再修）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// 真实路径：Windows CI 上 os.tmpdir() 是 8.3 短路径（RUNNER~1），hook 记的是 realpath，两边要一致
const SANDBOX = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reqtree-review-')));
process.env.TEMP = process.env.TMP = process.env.TMPDIR = SANDBOX;
process.env.REQTREE_HOME = path.join(SANDBOX, 'home', '.reqtree');

const P = require('../src/parser');
const M = require('../src/mention');
const codex = require('../src/targets/codex');
const inst = require('../src/targets/codex-install');
const store = require('../src/store');
const bin = require('../bin/reqtree');

const HOOK = path.join(__dirname, '..', 'hooks', 'hook.js');
const CODEX_HOOK = path.join(__dirname, '..', 'hooks', 'codex-hook.js');
const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');

// 和 Vibelearning 的树同样的形状：五门课，数据科学课下有「第1章」「英文版」
const VL = `# P Vibelearning 互动课程
- 通用规则

## C1 AI 课 🔨
> 文件：AI课程/**
- AI 课规则

### C1.1 第1–20章初稿 ✅
- 初稿规则

## C2 数据科学课 🔨
> 文件：DataScience/**
- 数据课规则

### C2.1 第1章 🔨
> 文件：DataScience/ch01-*.html
- 数据课第1章规则

### C2.2 英文版 ⏳
> 文件：DataScience/en/**
- 英文版规则

## C3 人类学课 ❓
> 文件：anthropology/**
- 人类学规则

## C4 十二门徒课 🔨
> 文件：apostles-course/**
- 门徒课规则
`;

function project(tree = VL) {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'proj-'));
  fs.writeFileSync(path.join(dir, '需求树.md'), tree);
  return dir;
}
function run(hook, input, env = {}) {
  const r = spawnSync(process.execPath, [hook], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env } });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}
const ctx = o => o && o.hookSpecificOutput && o.hookSpecificOutput.additionalContext;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 45000) {  // Windows CI 上起后台进程很慢
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (fn()) return true;
  return false;
}

// ---------- 1. 通知不是用户的话 ----------
const NOTES = [
  '<task-notification>\n<task-id>x</task-id>\n<summary>第1章 英文版 做完了</summary>\n</task-notification>',
  '  \n<agent-message from="I">数据科学课第1章的结果</agent-message>',
  '<system-reminder>后台</system-reminder>\n<task-notification>数据科学课第1章</task-notification>',
  '<command-name>/clear</command-name> 第1章',
  '<local-command-stdout>第1章</local-command-stdout>',
  '<bash-input>cat DataScience/ch01.html 第1章</bash-input>',
];

test('通知、子 agent 回报、命令输出不当成用户的话：不送规则、不进记录员的对话、不算补漏的轮数', async () => {
  for (const n of NOTES) assert.ok(M.isMachinePrompt(n), n);
  assert.ok(!M.isMachinePrompt('数据科学课第1章开头用霍乱'));
  assert.ok(!M.isMachinePrompt('第1章里放一个 <task-notification> 的示例'), '只看开头');

  const dir = project();
  const env = { REQTREE_CLAUDE_CMD: `"${process.execPath}" "${FAKE}"`, FAKE_LOG: path.join(dir, 'fake.log'), REQTREE_SWEEP_EVERY: '2' };
  const tree = path.join(dir, '需求树.md');
  for (const n of NOTES) assert.strictEqual(run(HOOK, { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: dir, prompt: n }, env), null, `给通知送了规则：${n}`);
  // 通知之后 Stop：没有用户的话，也不该凑够补漏
  run(HOOK, { hook_event_name: 'Stop', session_id: 's1', cwd: dir, stop_hook_active: false, last_assistant_message: '收到' }, env);
  await sleep(1500);
  const calls = () => (fs.existsSync(env.FAKE_LOG) ? fs.readFileSync(env.FAKE_LOG, 'utf8') : '');
  assert.ok(!/task-notification|agent-message|补漏检查/.test(calls()), `通知进了记录员：${calls().slice(0, 200)}`);
  // 真的用户话：记录员拿到的对话里没有通知
  run(HOOK, { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: dir, prompt: '以后数据科学课每章结尾加一道思考题' }, env);
  const before = (store.readRecorderStatus(tree) || {}).time || 0;
  run(HOOK, { hook_event_name: 'Stop', session_id: 's1', cwd: dir, stop_hook_active: false, last_assistant_message: '好' }, env);
  assert.ok(await waitFor(() => ((store.readRecorderStatus(tree) || {}).time || 0) > before));
  assert.match(calls(), /每章结尾加一道思考题/);
  assert.ok(!/task-notification|agent-message|补漏检查/.test(calls()), '通知混进了对话或补漏');

  // Codex 一样
  inst.installCodex(dir);
  run(CODEX_HOOK, { hook_event_name: 'SessionStart', session_id: 'cx', cwd: dir, source: 'startup' });
  for (const n of NOTES) assert.strictEqual(run(CODEX_HOOK, { hook_event_name: 'UserPromptSubmit', session_id: 'cx', cwd: dir, prompt: n }), null, `Codex 给通知送了规则：${n}`);
});

test('提到需求的匹配只看用户自己写的开头：代码块、引用行不算；只看前 500 字；超过 2000 字的（多半是粘贴）整句跳过', () => {
  const root = P.parse(VL);
  const ids = p => M.mentionedNodes(root, p).map(n => n.id);
  assert.deepStrictEqual(ids('数据科学课第1章开头改一下'), ['C2.1']);
  assert.deepStrictEqual(ids('看下这段\n```\n数据科学课第1章\n```\n怎么样'), []);
  assert.deepStrictEqual(ids('> 数据科学课第1章开头用霍乱\n这句话你怎么看'), []);
  assert.deepStrictEqual(ids('啊'.repeat(600) + '数据科学课'), []);
  assert.deepStrictEqual(ids('数据科学课' + '啊'.repeat(2100)), []);
});

// ---------- 3. 第N章、短标题、章号是弱匹配 ----------
test('弱匹配（章号、「第N章」标题、短于 4 字的标题、短编号）：只在提到所属课程、只有一门课、或最近在这门课上干活时才给', () => {
  const root = P.parse(VL);
  const ids = (p, opts) => M.mentionedNodes(root, p, opts).map(n => n.id);
  assert.deepStrictEqual(ids('第1章的开头再改一下'), [], '五门课，没说哪门');
  assert.deepStrictEqual(ids('AI课第1章开头再改一下'), ['C1'], '「AI课」认出「AI 课」；第1章在别的课，不给');
  assert.deepStrictEqual(ids('人类学课第1章'), ['C3']);
  assert.deepStrictEqual(ids('英文版要加一个按钮'), [], '「英文版」3 个字，没说哪门课');
  assert.deepStrictEqual(ids('数据科学课的英文版要加一个按钮'), ['C2.2']);
  assert.deepStrictEqual(ids('把ch01的标题改大'), []);
  assert.deepStrictEqual(ids('git log 显示 Chapter 2 of the README'), []);
  assert.deepStrictEqual(ids('第1–20章初稿'), ['C1.1'], '完整写出的长标题是强匹配');
  assert.deepStrictEqual(ids('step 1: run C2 tests; R3'), [], '短编号是弱匹配');
  assert.deepStrictEqual(ids('C2.1 再看看'), ['C2.1'], '带点的编号够具体');
  // 最近在数据科学课干活：弱匹配给这门课的
  assert.deepStrictEqual(ids('第1章的开头再改一下', { active: ['C2.1'] }), ['C2.1']);
  assert.deepStrictEqual(ids('英文版要加一个按钮', { active: ['C2'] }), ['C2.2']);
  assert.deepStrictEqual(ids('人类学课第1章', { active: ['C2.1'] }), ['C3'], '这句话点了别的课，别处的弱匹配不给');
  // 两门课都有第1章
  const two = P.parse('# P 项目\n## A 课一\n> 文件：a/**\n### A.1 第1章\n- 规则甲\n## B 课二 🔨\n> 文件：b/**\n### B.1 第一章 开场\n- 规则乙\n');
  assert.deepStrictEqual(M.mentionedNodes(two, '第1章改一下').map(n => n.id), []);
  assert.deepStrictEqual(M.mentionedNodes(two, '课一第1章改一下').map(n => n.id), ['A.1']);
  const fileVsTitle = P.parse('# P 项目\n## A 课一\n> 文件：a/**\n### A.1 引言\n> 文件：a/ch01-intro.html\n- 规则甲\n## B 课二\n> 文件：b/**\n### B.1 第1章\n- 规则乙\n');
  assert.deepStrictEqual(M.mentionedNodes(fileVsTitle, '第1章改一下').map(n => n.id), []);
  // 只有一门课（章节直接挂在根下）：第1章直接给
  const one = P.parse('# P 示例课程\n- 段落不超过 4 行\n## R1 课程结构\n- 6 篇\n## R3 第1章\n> 文件：ch01-*.html\n- 勇士爬塔\n## R4 第2章\n- 接着开场\n');
  assert.deepStrictEqual(M.mentionedNodes(one, '第1章开场段落最多几行？').map(n => n.id), ['R3']);
  assert.ok(!M.chapterNumbers('第0章').has(0));
});

// ---------- 2. init 不能清掉用户的 settings ----------
test('init：settings.local.json 带 BOM 照样读、权限保留；解析不了就报错、一个字不写', () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, '.claude'));
  const sp = path.join(dir, '.claude', 'settings.local.json');
  fs.writeFileSync(sp, '﻿' + JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }));
  bin.init(dir, { log: () => {} });
  const s = JSON.parse(fs.readFileSync(sp, 'utf8').replace(/^﻿/, ''));
  assert.deepStrictEqual(s.permissions, { allow: ['Bash(npm test)'] });
  assert.ok(s.hooks.Stop);

  const dir2 = project();
  fs.mkdirSync(path.join(dir2, '.claude'));
  const sp2 = path.join(dir2, '.claude', 'settings.local.json');
  const bad = '{ "permissions": { "allow": ["Bash(npm test)"], }, }';
  fs.writeFileSync(sp2, bad);
  assert.throws(() => bin.init(dir2, { log: () => {} }), /settings\.local\.json/);
  assert.strictEqual(fs.readFileSync(sp2, 'utf8'), bad);
});

test('停用：去掉 hook 和规则（连 worktree 里抄的），之后插件、hook 再编译也不生成；重新 init 恢复', () => {
  const dir = project();
  bin.init(dir, { log: () => {} });
  const rules = path.join(dir, '.claude', 'rules', 'reqtree');
  // 一个 worktree：.git/worktrees/w/gitdir 指回 worktree 根，worktree 根的 .git 是个文件
  const wt = path.join(dir, '.claude', 'worktrees', 'w');
  fs.mkdirSync(path.join(dir, '.git', 'worktrees', 'w'), { recursive: true });
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'worktrees', 'w', 'gitdir'), path.join(wt, '.git'));
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(dir, '.git', 'worktrees', 'w')}\n`);
  store.compileTree(path.join(dir, '需求树.md'), { force: true });
  assert.ok(fs.existsSync(path.join(wt, '.claude', 'rules', 'reqtree', '_index.md')));
  bin.disable(dir);
  assert.ok(!bin.hasHooks(dir));
  assert.ok(!fs.existsSync(rules) && !fs.existsSync(path.join(wt, '.claude', 'rules', 'reqtree')));
  store.compileTree(path.join(dir, '需求树.md'), { force: true });
  store.compileTree(path.join(dir, '需求树.md'), { wait: false });
  assert.ok(!fs.existsSync(rules), '停用后编译不再生成规则');
  bin.init(dir, { log: () => {} });
  assert.ok(fs.existsSync(path.join(rules, '_index.md')));
});

test('init：共享的 settings.json 里已有需求树的 hook 时去掉，只留 settings.local.json 一份（不然每个事件触发两次）', () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, '.claude'));
  const shared = path.join(dir, '.claude', 'settings.json');
  const ours = { type: 'command', command: 'node "/x/.reqtree/runtime/hooks/hook.js"' };
  fs.writeFileSync(shared, JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [ours, { type: 'command', command: 'echo hi' }] }] } }));
  bin.init(dir, { log: () => {} });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(shared, 'utf8')), { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } });
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8')).hooks.Stop);
});

// ---------- 4. AGENTS.md 标记 ----------
test('AGENTS.md：标记要单独一行；END 只在 BEGIN 后面找；块不完整就不写、给提醒', () => {
  const { BEGIN: B, END: E } = codex;
  const blk = `${B}\nNEW\n${E}`;
  const broken = `# Mine\n${B}\nold\n\n## 用户自己的重要说明\n不要删\n`;
  assert.strictEqual(codex.upsertBlock(broken, blk), broken, '缺 END：不动');
  assert.strictEqual(codex.removeBlock(`A\n${B}\nB-user\n`), `A\n${B}\nB-user\n`);
  const endFirst = `说明：区块以 ${E} 结尾\n${B}\nx\n${E}\n`;
  const out = codex.upsertBlock(endFirst, blk);
  assert.strictEqual(out, `说明：区块以 ${E} 结尾\n${blk}\n`);
  const inline = `提到 ${B} 这个标记的说明\n`;
  assert.strictEqual(codex.upsertBlock(inline, blk), `${inline}\n${blk}\n`, '行内提到的标记不算');
  // 编译时遇到不完整的块：不写 AGENTS.md，给提醒
  const dir = project();
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), broken);
  const r = codex.compile(path.join(dir, '需求树.md'));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), broken);
  assert.ok(r.warnings.some(w => /AGENTS\.md/.test(w) && /不完整|没有结束/.test(w)), JSON.stringify(r.warnings));
  assert.deepStrictEqual(codex.patchFiles('*** Add File: "q.html"\n'), ['q.html']);
});

// ---------- 5. 换行不能注入标题 ----------
test('applyOps：文字、标题、文件、键里的换行压成空格，不能凭空多出标题', () => {
  const T = '# P 项目\n- 规则\n\n## C1 课\n> 文件：c/**\n- 课规则\n';
  const evil = '好\n## X 注入的需求\n- 注入的规则';
  const ops = [
    { op: 'add_rule', node: 'C1', text: evil },
    { op: 'add_rule', node: 'C1', key: 'k\n## Y', text: '带键' },
    { op: 'replace_rule', node: 'C1', old: '课规则', text: evil + '2' },
    { op: 'add_node', parent: 'C1', id: 'C1.1', title: evil + '3' },
    { op: 'add_files', node: 'C1', globs: ['a/**\n## Z 注入'] },
    { op: 'rename_node', node: 'C1', title: '新课\n## W 注入' },
  ];
  const { text } = P.applyOps(T, ops);
  const heads = text.split('\n').filter(l => /^#{1,6}\s/.test(l));
  assert.deepStrictEqual(heads.map(l => l.split(/\s+/)[1]), ['P', 'C1', 'C1.1'], text);
  assert.ok(!/^- 注入的规则/m.test(text));
});

// ---------- 7. 共享运行时副本不降级 ----------
test('init：~/.reqtree/runtime 比自己新时不覆盖；先复制 src 再复制 hooks', () => {
  const rt = bin.runtimeDir();
  fs.mkdirSync(path.join(rt, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(rt, 'version'), '99.0.0\n');
  fs.writeFileSync(path.join(rt, 'hooks', 'hook.js'), '// newer');
  const dir = project();
  const logs = [];
  bin.init(dir, { log: m => logs.push(m) });
  assert.strictEqual(fs.readFileSync(path.join(rt, 'hooks', 'hook.js'), 'utf8'), '// newer');
  assert.strictEqual(fs.readFileSync(path.join(rt, 'version'), 'utf8').trim(), '99.0.0');
  assert.ok(logs.some(l => /99\.0\.0/.test(l)), logs.join('\n'));
  assert.deepStrictEqual(bin.RUNTIME_PARTS, ['src', 'hooks']);
  fs.rmSync(rt, { recursive: true, force: true });
});

// ---------- 8. hasHooks 要求脚本还在 ----------
test('hasHooks：settings 里有需求树的 hook，但脚本已经不在了，算没装（插件会提示重新启用）', () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, '.claude'));
  const write = cmd => fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: cmd }] }] } }));
  write(`node "${path.join(SANDBOX, 'gone', 'reqtree', 'hooks', 'hook.js').replace(/\\/g, '/')}"`);
  assert.strictEqual(bin.hasHooks(dir), false);
  const real = path.join(SANDBOX, 'there', 'reqtree', 'hooks', 'hook.js');
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, '');
  write(bin.hookCommand(real));
  assert.strictEqual(bin.hasHooks(dir), true);
});

// ---------- 9. codex-install 原地替换 ----------
test('codex-install：重装时我们的 hook 留在原来的位置，用户的信任键不变', () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, '.codex'));
  const user = (c) => ({ hooks: [{ type: 'command', command: c }] });
  inst.installCodex(dir, { runtimeDir: path.join(SANDBOX, 'rt1') });
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.codex', 'hooks.json'), 'utf8'));
  cfg.hooks.PostToolUse.push(user('echo after'));
  cfg.hooks.PostToolUse.unshift(user('echo before'));
  fs.writeFileSync(path.join(dir, '.codex', 'hooks.json'), JSON.stringify(cfg));
  const keys1 = inst.trustEntries(dir).map(t => t.key);
  inst.installCodex(dir, { runtimeDir: path.join(SANDBOX, 'rt2') });
  const cfg2 = JSON.parse(fs.readFileSync(path.join(dir, '.codex', 'hooks.json'), 'utf8'));
  assert.deepStrictEqual(cfg2.hooks.PostToolUse.map(g => g.hooks[0].command.includes('codex-hook') ? 'ours' : g.hooks[0].command), ['echo before', 'ours', 'echo after']);
  assert.ok(cfg2.hooks.PostToolUse[1].hooks[0].command.includes('rt2'));
  assert.deepStrictEqual(inst.trustEntries(dir).map(t => t.key), keys1);
});

// ---------- 10. Codex 的附加上下文上限 ----------
test('Codex：全局规则更新和提到的需求加起来超过上限时只送提到的需求，全局那段换成一句提示', () => {
  const big = VL.replace('- 通用规则', Array.from({ length: 120 }, (_, i) => `- 通用规则第 ${i} 条，凑一些字数凑一些字数`).join('\n'));
  const dir = project(VL);
  inst.installCodex(dir);
  const base = { session_id: 'lim', cwd: dir };
  run(CODEX_HOOK, { ...base, hook_event_name: 'SessionStart', source: 'startup' });
  fs.writeFileSync(path.join(dir, '需求树.md'), big);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(dir, '需求树.md'), later, later);
  const o = ctx(run(CODEX_HOOK, { ...base, hook_event_name: 'UserPromptSubmit', prompt: '数据科学课第1章开头改一下' }));
  assert.ok(Buffer.byteLength(o) <= codex.CONTEXT_LIMIT, `${Buffer.byteLength(o)} 字节 > ${codex.CONTEXT_LIMIT}`);
  assert.match(o, /数据课第1章规则/);
  assert.match(o, /AGENTS\.md/);
});
