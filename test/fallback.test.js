'use strict';
// 原生路径规则没加载时的补送（Claude Code 有过路径规则不加载的 bug：#23478、#33581、#61357）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SANDBOX = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reqtree-sandbox-')));
process.env.TEMP = process.env.TMP = process.env.TMPDIR = SANDBOX;
process.env.REQTREE_HOME = path.join(SANDBOX, 'home', '.reqtree');
const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'hooks', 'hook.js');
const store = require('../src/store');

const TREE = `# P 项目
- 段落不超过 4 行

## C1 课 🔨
> 文件：c/**
- 每章练习题不超过 5 道

### C1.2 第2章
> 文件：c/ch02*.html
- 开场用霍乱

### C1.3 第3章
> 文件：c/ch03*.html
`;

function project() {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'proj-'));
  fs.writeFileSync(path.join(dir, '需求树.md'), TREE);
  store.compileTree(path.join(dir, '需求树.md'), { force: true });
  return { dir, tree: path.join(dir, '需求树.md') };
}

function hook(input) {
  const res = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, REQTREE_FALLBACK_WAIT_MS: '0' } });
  assert.strictEqual(res.stderr, '', res.stderr);
  return res.stdout ? JSON.parse(res.stdout) : null;
}
const loaded = (dir, session, rel, extra = {}) => hook({ cwd: dir, session_id: session, hook_event_name: 'InstructionsLoaded', file_path: path.join(dir, rel), load_reason: rel.includes('_index') ? 'session_start' : 'path_glob_match', memory_type: 'Project', ...extra });
const edit = (dir, session, rel, extra = {}) => hook({ cwd: dir, session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dir, rel) }, ...extra });

test('补送：会话里原生加载在工作（加载过总目录），改第2章时它的规则文件没加载 → 补送一次，记成 fallback', () => {
  const { dir, tree } = project();
  const s = 's-fb-1';
  loaded(dir, s, '.claude/rules/reqtree/_index.md');
  const out = edit(dir, s, 'c/ch02-a.html');
  assert.ok(out, '应该补送');
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /开场用霍乱/);
  assert.match(ctx, /每章练习题不超过 5 道/, '上级的规则一起补');
  assert.match(ctx, /没有加载/);
  const fb = store.readContext(tree, 60000).filter(e => e.reason === 'fallback');
  assert.strictEqual(fb.length, 1);
  assert.strictEqual(fb[0].node, 'C1.2');
  assert.strictEqual(fb[0].session, s);
  assert.strictEqual(fb[0].source, 'reqtree');
  // 同一会话再改：不再补
  assert.strictEqual(edit(dir, s, 'c/ch02-b.html'), null);
});

test('补送：原生已经加载了这条路上的规则文件 → 不补', () => {
  const { dir } = project();
  const s = 's-fb-2';
  loaded(dir, s, '.claude/rules/reqtree/_index.md');
  loaded(dir, s, '.claude/rules/reqtree/C1.md');
  loaded(dir, s, '.claude/rules/reqtree/C1.2.md');
  assert.strictEqual(edit(dir, s, 'c/ch02-a.html'), null);
});

test('补送：这个会话没有任何加载记录（老版本 Claude Code 没有 InstructionsLoaded）→ 不补，免得每个需求都补一遍', () => {
  const { dir } = project();
  assert.strictEqual(edit(dir, 's-fb-3', 'c/ch02-a.html'), null);
});

test('补送：用户点名时已经送过这个需求的规则 → 不补；子 agent 自己的上下文要单独算', () => {
  const { dir } = project();
  const s = 's-fb-4';
  loaded(dir, s, '.claude/rules/reqtree/_index.md');
  hook({ cwd: dir, session_id: s, hook_event_name: 'UserPromptSubmit', prompt: '第2章 C1.2 开场再想想' });
  assert.strictEqual(edit(dir, s, 'c/ch02-a.html'), null, '点名时送过了');
  // 子 agent：主 agent 加载过不算它加载过
  loaded(dir, s, '.claude/rules/reqtree/_index.md', { agent_id: 'sub1' });
  const sub = edit(dir, s, 'c/ch03-a.html', { agent_id: 'sub1' });
  assert.ok(sub, '子 agent 改第3章，原生没加载 C1 → 补送');
  assert.match(sub.hookSpecificOutput.additionalContext, /每章练习题不超过 5 道/);
});

test('补送：上下文用量表把补送的记录算作按需，界面上写「补送（原生没加载）」', () => {
  const { contextData } = require('../src/viewmodel');
  const [s] = contextData([{ session: 'x', file: 'reqtree-fallback/C1.2', chars: 40, reason: 'fallback', source: 'reqtree', node: 'C1.2', time: Date.now() }]);
  assert.strictEqual(s.files[0].kind, 'demand');
  const S = require('../media/strings');
  assert.strictEqual(S.zh['ctx.fallback'], '补送（原生没加载）');
  assert.ok(S.en['ctx.fallback']);
  assert.match(fs.readFileSync(path.join(ROOT, 'media', 'detail.js'), 'utf8'), /ctx\.fallback/);
});
