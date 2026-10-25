'use strict';
// git worktree：需求树.md 一般不进 git，worktree 里没有。2026-10-25 猪猪进城记大部分活在 .claude/worktrees/ 里做，
// 记录员找不到树、AI 加载不到规则。这里造一个主仓库加一个 worktree（不调用 git，只摆出 git 的文件布局）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SANDBOX = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reqtree-sandbox-')));
process.env.TEMP = process.env.TMP = process.env.TMPDIR = SANDBOX;
process.env.REQTREE_HOME = path.join(SANDBOX, 'home', '.reqtree');
const HOOK = path.join(__dirname, '..', 'hooks', 'hook.js');
const store = require('../src/store');
const { findTreeUp, projectRel, worktreeMain } = require('../src/common');

const TREE = `# P 游戏
- 光照只有一条规则

## R1 城市 🔨
> 文件：game/world/**
- 街道两边种树
`;

// 主仓库 main/，worktree 放在 main/.claude/worktrees/<name>（Claude Code 的默认位置）
function repo() {
  const main = fs.mkdtempSync(path.join(SANDBOX, 'main-'));
  fs.mkdirSync(path.join(main, '.git', 'worktrees'), { recursive: true });
  fs.writeFileSync(path.join(main, '需求树.md'), TREE);
  const tree = path.join(main, '需求树.md');
  store.compileTree(tree, { force: true });
  return { main, tree };
}
function addWorktree(main, name) {
  const wt = path.join(main, '.claude', 'worktrees', name);
  const meta = path.join(main, '.git', 'worktrees', name);
  fs.mkdirSync(path.join(wt, 'game', 'world'), { recursive: true });
  fs.mkdirSync(meta, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${meta.split(path.sep).join('/')}\n`);
  fs.writeFileSync(path.join(meta, 'gitdir'), path.join(wt, '.git').split(path.sep).join('/') + '\n');
  return wt;
}
function hook(input) {
  const res = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, REQTREE_FALLBACK_WAIT_MS: '0' } });
  assert.strictEqual(res.stderr, '', res.stderr);
  return res.stdout ? JSON.parse(res.stdout) : null;
}

test('worktree 里：往上找到主仓库的需求树，文件按 worktree 的根对上需求', () => {
  const { main, tree } = repo();
  const wt = addWorktree(main, 'feat');
  assert.ok(store.samePath(worktreeMain(wt), main));
  assert.ok(store.samePath(findTreeUp(path.join(wt, 'game', 'world')), tree));
  assert.strictEqual(projectRel(main, path.join(wt, 'game', 'world', 'street.gd')), 'game/world/street.gd');
  assert.strictEqual(projectRel(main, path.join(main, 'game', 'world', 'street.gd')), 'game/world/street.gd');
  // 别的仓库（不是 worktree）到 git 根为止，不往上找
  const other = path.join(main, 'vendor', 'lib');
  fs.mkdirSync(path.join(other, '.git'), { recursive: true });
  assert.strictEqual(findTreeUp(other), null);
});

test('编译时每个 worktree 也有一份规则文件；后开的 worktree 下次编译补上，删掉的需求两边都删', () => {
  const { main, tree } = repo();
  const wt = addWorktree(main, 'a');
  store.compileTree(tree);
  const rules = d => path.join(d, '.claude', 'rules', 'reqtree');
  assert.match(fs.readFileSync(path.join(rules(wt), 'R1.md'), 'utf8'), /街道两边种树/);
  assert.ok(fs.existsSync(path.join(rules(wt), '_index.md')));
  // 树没变，后开一个 worktree：也要补上
  const wt2 = addWorktree(main, 'b');
  store.compileTree(tree);
  assert.ok(fs.existsSync(path.join(rules(wt2), 'R1.md')));
  fs.writeFileSync(tree, '# P 游戏\n- 光照只有一条规则\n');
  store.compileTree(tree);
  assert.ok(!fs.existsSync(path.join(rules(main), 'R1.md')));
  assert.ok(!fs.existsSync(path.join(rules(wt), 'R1.md')));
});

test('hook：会话在主目录启动、AI 改 worktree 里的文件，记到对的需求上，没加载的规则补送', () => {
  const { main, tree } = repo();
  const wt = addWorktree(main, 'gpu');
  const s = 's-wt-1';
  hook({ cwd: main, session_id: s, hook_event_name: 'InstructionsLoaded', file_path: path.join(main, '.claude/rules/reqtree/_index.md'), load_reason: 'session_start', memory_type: 'Project' });
  const out = hook({ cwd: main, session_id: s, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(wt, 'game', 'world', 'street.gd') } });
  const act = store.readActivity(tree, 60000).filter(e => e.session === s);
  assert.deepStrictEqual(act.map(e => [e.node, e.file]), [['R1', 'game/world/street.gd']]);
  assert.ok(out, '应该补送');
  assert.match(out.hookSpecificOutput.additionalContext, /街道两边种树/);
});

test('hook：会话直接在 worktree 里启动，也找得到主仓库的树', () => {
  const { main, tree } = repo();
  const wt = addWorktree(main, 'solo');
  hook({ cwd: wt, session_id: 's-wt-2', hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path.join(wt, 'game', 'world', 'a.gd') } });
  assert.deepStrictEqual(store.readActivity(tree, 60000).filter(e => e.session === 's-wt-2').map(e => e.node), ['R1']);
});

test('Codex 在 worktree 里：文件按 worktree 的根对上需求，送规则、记活动；规则文件也抄进 worktree', () => {
  const codex = require('../src/targets/codex');
  const { main, tree } = repo();
  const wt = addWorktree(main, 'cx');
  fs.writeFileSync(path.join(wt, 'game', 'world', 'street.gd'), '');
  fs.writeFileSync(path.join(main, '.reqtree', 'codex.json'), '{}');
  store.compileTree(tree, { force: true });
  assert.ok(fs.existsSync(path.join(wt, '.reqtree', 'rules', 'R1.md')), 'worktree 里也有规则文件');
  assert.strictEqual(codex.relTo(main, wt, 'game/world/street.gd'), 'game/world/street.gd');
  const res = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'codex-hook.js')], { encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'wt-cx', cwd: wt, tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: game/world/street.gd\n*** End Patch' } }) });
  assert.match(JSON.parse(res.stdout).hookSpecificOutput.additionalContext, /街道两边种树/);
  assert.ok(store.readActivity(tree, 60000).some(e => e.file === 'game/world/street.gd' && e.node === 'R1'));
});
