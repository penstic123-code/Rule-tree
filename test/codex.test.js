'use strict';
// Codex 编译目标、安装、hook 的测试（不调用真实的 Codex）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// 独立的临时目录：hook 的会话状态和日志写在 os.tmpdir() 下
// 真实路径：Windows CI 上 os.tmpdir() 是 8.3 短路径（RUNNER~1），hook 记的是 realpath，两边要一致
const SANDBOX = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reqtree-codex-')));
process.env.TEMP = process.env.TMP = process.env.TMPDIR = SANDBOX;
process.env.REQTREE_HOME = path.join(SANDBOX, 'home', '.reqtree');

const codex = require('../src/targets/codex');
const inst = require('../src/targets/codex-install');
const { compile, ensureCompiled, targetsOf } = require('../src/compile');
const { parse } = require('../src/parser');
const store = require('../src/store');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'hooks', 'codex-hook.js');
const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');

const TREE = `# P 测试项目
- [段落] 段落不超过 4 行
- 语气平实

## C2 数据科学课 🔨
> 文件：DataScience/**
- 不引原话

### C2.1 第1章 ⏳
> 文件：DataScience/ch01-*.html
- 开场用霍乱

#### C2.1.1 开场故事
- [段落] 开场段落可以到 6 行

### C2.2 第2章 ⏳
> 文件：DataScience/ch02-*.html
- 接着第1章的问题开场

## C9 没有文件的需求
- 这条不该出现
`;

function project({ agents } = {}) {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'proj-'));
  fs.mkdirSync(path.join(dir, 'DataScience'));
  fs.writeFileSync(path.join(dir, 'DataScience', 'ch01-a.html'), '<p>1</p>\n');
  fs.writeFileSync(path.join(dir, 'DataScience', 'ch02-b.html'), '<p>2</p>\n');
  fs.writeFileSync(path.join(dir, '需求树.md'), TREE);
  if (agents != null) fs.writeFileSync(path.join(dir, 'AGENTS.md'), agents);
  return dir;
}
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const codexOnly = { claude: false, codex: true };

// ---------- 编译 ----------

test('编译：AGENTS.md 托管块 + 每个有文件的需求一份规则文件', () => {
  const dir = project({ agents: '# 我的说明\n\n回复用中文。\n' });
  const r = compile(path.join(dir, '需求树.md'), { targets: codexOnly });
  assert.deepStrictEqual(r.targets, ['codex']);
  assert.ok(!fs.existsSync(path.join(dir, '.claude')), '只编 Codex 时不生成 .claude');
  const agents = read(dir, 'AGENTS.md');
  assert.ok(agents.startsWith('# 我的说明\n\n回复用中文。\n\n<!-- reqtree:begin -->'), '用户内容在前、原样保留');
  assert.match(agents, /### 全局规则\n\n- 段落不超过 4 行\n- 语气平实/);
  assert.match(agents, /`DataScience\/\*\*` → `\.reqtree\/rules\/C2\.md`/);
  assert.match(agents, /`DataScience\/ch01-\*\.html` → `\.reqtree\/rules\/C2\.1\.md`/);
  assert.ok(!agents.includes('这条不该出现'), '没有文件对应的需求不进 AGENTS.md');
  const files = fs.readdirSync(path.join(dir, '.reqtree', 'rules')).sort();
  assert.deepStrictEqual(files, ['C2.1.md', 'C2.2.md', 'C2.md', '_index.md']);
  const c21 = read(dir, '.reqtree/rules/C2.1.md');
  assert.match(c21, /- 开场用霍乱/);
  assert.match(c21, /## C2\.1\.1 开场故事\n- 开场段落可以到 6 行（在本范围内以此为准，取代上级 P 的「段落不超过 4 行」）/, '没有自己文件的子需求并进上级的单元，覆盖写明');
  assert.ok(!c21.includes('不引原话'), '上级单元的规则不重复抄');
});

test('编译：重复运行不重写；改树后只重写变了的；删掉的需求文件也删掉', () => {
  const dir = project({ agents: '用户内容\n' });
  const tree = path.join(dir, '需求树.md');
  compile(tree, { targets: codexOnly });
  const again = compile(tree, { targets: codexOnly });
  assert.deepStrictEqual(again.written, [], '第二次什么都不写');
  fs.writeFileSync(tree, TREE.replace(/### C2\.2[\s\S]*?(?=## C9)/, '').replace('不引原话', '不引原话，自己叙述'));
  const r = compile(tree, { targets: codexOnly });
  assert.deepStrictEqual(r.removed, ['codex:C2.2.md']);
  assert.ok(r.written.includes('codex:C2.md') && r.written.includes('codex:AGENTS.md'));
  assert.ok(!r.written.includes('codex:C2.1.md'));
  const agents = read(dir, 'AGENTS.md');
  assert.strictEqual(agents.split('<!-- reqtree:begin -->').length, 2, '托管块只有一个');
  assert.ok(agents.startsWith('用户内容\n'));
});

test('编译：AGENTS.override.md 存在时写进 override；CRLF 保留', () => {
  const dir = project({ agents: '原来的\n' });
  fs.writeFileSync(path.join(dir, 'AGENTS.override.md'), '覆盖文件\r\n第二行\r\n');
  compile(path.join(dir, '需求树.md'), { targets: codexOnly });
  assert.strictEqual(read(dir, 'AGENTS.md'), '原来的\n', 'AGENTS.md 不动（Codex 不读它）');
  const over = read(dir, 'AGENTS.override.md');
  assert.ok(over.startsWith('覆盖文件\r\n第二行\r\n\r\n<!-- reqtree:begin -->'));
  assert.ok(!/[^\r]\n/.test(over), '全部是 CRLF');
});

test('托管块：upsert / remove 往返后用户内容不变', () => {
  for (const user of ['', '# 标题\n\n正文\n', '前面\n\n<!-- reqtree:begin -->\n旧的\n<!-- reqtree:end -->\n\n后面\n']) {
    const once = codex.upsertBlock(user, `${codex.BEGIN}\n新的\n${codex.END}`);
    assert.strictEqual(codex.upsertBlock(once, `${codex.BEGIN}\n新的\n${codex.END}`), once, '幂等');
    assert.strictEqual(once.split(codex.BEGIN).length, 2);
    const back = codex.removeBlock(once);
    assert.ok(!back.includes(codex.BEGIN));
    if (user.startsWith('前面')) assert.strictEqual(back, '前面\n\n后面\n');
    else assert.strictEqual(back, user);
  }
});

test('编译目标自动判断：老项目照旧编 Claude；装了 Codex 只编 Codex；两个都装就都编', () => {
  const dir = project();
  assert.deepStrictEqual(targetsOf(dir), { claude: true, codex: false });
  fs.mkdirSync(path.join(dir, '.reqtree'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.reqtree', 'codex.json'), '{}');
  assert.deepStrictEqual(targetsOf(dir), { claude: false, codex: true });
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), '{"hooks":{"Stop":[{"hooks":[{"command":"node reqtree/hooks/hook.js"}]}]}}');
  assert.deepStrictEqual(targetsOf(dir), { claude: true, codex: true });
  const r = compile(path.join(dir, '需求树.md'));
  assert.ok(r.written.includes('C2.md') && r.written.includes('codex:C2.md'));
});

test('ensureCompiled：Codex 结果新就不编；树改了、托管块被删了都会重编', () => {
  const dir = project();
  inst.installCodex(dir);
  const tree = path.join(dir, '需求树.md');
  assert.strictEqual(ensureCompiled(tree), null);
  const later = new Date(Date.now() + 5000);
  fs.writeFileSync(tree, TREE.replace('语气平实', '语气平实自然'));
  fs.utimesSync(tree, later, later);
  assert.ok(ensureCompiled(tree));
  assert.match(read(dir, 'AGENTS.md'), /语气平实自然/);
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '用户删光了\n');
  assert.ok(ensureCompiled(tree));
  assert.match(read(dir, 'AGENTS.md'), /^用户删光了\n\n<!-- reqtree:begin -->/);
});

// ---------- 安装 ----------

test('安装：hooks.json 合并写入、重复安装不重复、用户的 hook 不动、换目录装会替换旧的', () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, '.codex'));
  const mine = { type: 'command', command: 'python3 my_check.py' };
  fs.writeFileSync(path.join(dir, '.codex', 'hooks.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [mine] }] }, other: 1 }));
  const r = inst.installCodex(dir, { runtimeDir: ROOT });
  const first = read(dir, '.codex/hooks.json');
  const cfg = JSON.parse(first);
  assert.strictEqual(cfg.other, 1);
  assert.deepStrictEqual(cfg.hooks.PostToolUse[0], { matcher: 'Bash', hooks: [mine] }, '用户的 hook 原样保留且在前');
  assert.deepStrictEqual(Object.keys(cfg.hooks).sort(), ['PostToolUse', 'PreCompact', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  const ours = cfg.hooks.PostToolUse[1];
  assert.strictEqual(ours.matcher, 'Bash|apply_patch');
  assert.match(ours.hooks[0].command, /^node ".*\/hooks\/codex-hook\.js"$/);
  assert.strictEqual(r.trust.length, 5);
  assert.match(r.trust.find(t => t.event === 'PostToolUse').key, /hooks\.json:post_tool_use:1:0$/, '信任键按在文件里的位置算');

  inst.installCodex(dir, { runtimeDir: ROOT });
  assert.strictEqual(read(dir, '.codex/hooks.json'), first, '重复安装内容不变');

  const other = path.join(SANDBOX, 'runtime2');
  inst.installCodex(dir, { runtimeDir: other });
  const cfg2 = JSON.parse(read(dir, '.codex/hooks.json'));
  const cmds = Object.values(cfg2.hooks).flat().flatMap(g => g.hooks).map(h => h.command);
  assert.strictEqual(cmds.filter(c => /codex-hook/.test(c)).length, 5, '旧路径的 hook 被替换，不叠加');
  assert.ok(cmds.every(c => !/codex-hook/.test(c) || c.includes('runtime2')));

  inst.uninstallCodex(dir);
  const cfg3 = JSON.parse(read(dir, '.codex/hooks.json'));
  assert.deepStrictEqual(cfg3.hooks, { PostToolUse: [{ matcher: 'Bash', hooks: [mine] }] });
  assert.ok(!fs.existsSync(path.join(dir, '.reqtree', 'rules')));
  assert.ok(!fs.existsSync(path.join(dir, 'AGENTS.md')), '只有托管块的 AGENTS.md 卸载后删掉');
});

test('安装：hooks.json 不是合法 JSON 时报错且不改它；.reqtree/codex.json 保留用户改过的模型', () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, '.codex'));
  fs.writeFileSync(path.join(dir, '.codex', 'hooks.json'), '{ 坏的');
  assert.throws(() => inst.installCodex(dir), /不是合法的 JSON/);
  assert.strictEqual(read(dir, '.codex/hooks.json'), '{ 坏的');

  const dir2 = project();
  fs.mkdirSync(path.join(dir2, '.reqtree'));
  fs.writeFileSync(path.join(dir2, '.reqtree', 'codex.json'), JSON.stringify({ model: 'my-model', recorderCmd: 'x' }));
  inst.installCodex(dir2);
  const cfg = JSON.parse(read(dir2, '.reqtree/codex.json'));
  assert.strictEqual(cfg.model, 'my-model');
  assert.strictEqual(cfg.recorderCmd, 'x');
  assert.match(read(dir2, '.gitignore'), /^\.reqtree\/$/m);
  process.env.REQTREE_CODEX_RECORDER_CMD = '';
  assert.strictEqual(codex.recorderCommand(dir2), 'x', '记录员命令可以在 codex.json 里配置');
});

test('信任哈希：和 Codex 0.163.0 app-server hooks/list 返回的 currentHash 一致', () => {
  const command = 'node "C:/Users/me/reqtree/hooks/codex-hook.js"';
  // 算法 2026-10-22 用 codex app-server 的 hooks/list 实测核对过（当时用的是本机真实路径）；这里换成中性路径，防止回归
  assert.strictEqual(inst.hookHash('PostToolUse', 'Bash|apply_patch', { command, timeout: 15, statusMessage: '需求树' }),
    'sha256:2cb95d490e38f45ac344d0ca3f74aa7fc44f9cbdbcfd4325d1e28d71fe615f81');
  assert.strictEqual(inst.hookHash('SessionStart', undefined, { command, timeout: 15, statusMessage: '需求树' }),
    'sha256:47a1d1b17f99d3a1a7091fe03442918dad24dc9c7d3744fd908906a02e7897b2');
  const dir = project();
  inst.installCodex(dir);
  const snip = inst.trustSnippet(dir);
  assert.match(snip, /^\[projects\.'.+'\]\ntrust_level = "trusted"\n/);
  assert.strictEqual((snip.match(/trusted_hash = "sha256:[0-9a-f]{64}"/g) || []).length, 5);
});

// ---------- 从工具调用里找文件 ----------

test('apply_patch 补丁里的文件、命令行里的路径、写文件命令', () => {
  const patch = '*** Begin Patch\n*** Update File: DataScience/ch01-a.html\n@@\n-a\n+b\n*** Add File: notes/new.md\n+x\n*** Update File: old.txt\n*** Move to: new.txt\n*** Delete File: gone.txt\n*** End Patch';
  assert.deepStrictEqual(codex.patchFiles(patch), ['DataScience/ch01-a.html', 'notes/new.md', 'old.txt', 'new.txt', 'gone.txt']);
  assert.deepStrictEqual(codex.patchFiles(undefined), []);
  const ps = `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-Content -Raw -Encoding UTF8 'DataScience\\ch01-a.html'; Get-Content '.reqtree/rules/C2.md'"`;
  const paths = codex.shellPaths(ps);
  assert.ok(paths.includes('DataScience\\ch01-a.html') && paths.includes('.reqtree/rules/C2.md'));
  const dir = project();
  const rels = paths.map(p => codex.relTo(dir, dir, p)).filter(Boolean);
  if (process.platform === 'win32') assert.ok(rels.includes('DataScience/ch01-a.html'), 'Windows 反斜杠路径能认');
  assert.deepStrictEqual(codex.readRuleIds(rels), ['C2']);
  assert.strictEqual(codex.relTo(dir, dir, path.join(os.tmpdir(), 'x.html')), null, '项目外的不算');
  assert.ok(codex.isWriteCommand(`$s = Get-Content $p; Set-Content -Encoding UTF8 $p $s`));
  assert.ok(codex.isWriteCommand(`[System.IO.File]::WriteAllText($p, $c)`));
  assert.ok(codex.isWriteCommand(`sed -i 's/a/b/' x.html`));
  assert.ok(!codex.isWriteCommand(`Get-Content -Raw 'a.html' | Select-String '<p>x</p>'`), 'HTML 里的 > 不算写');
  assert.ok(!codex.isWriteCommand(`Select-String "rm" a.js`), '引号里的 rm 是要找的词');
  assert.ok(!codex.isWriteCommand(`grep tee x.html`));
  assert.ok(codex.isWriteCommand(`Get-Content a.txt | Out-File b.txt`));
  assert.ok(codex.isWriteCommand(`powershell -NoProfile -Command "Set-Content -Path a.html -Value x"`));
  assert.ok(codex.isWriteCommand(`cd web && rm old.html`));
});

test('unitsForFiles：上级范围包住下级时两份都给；别的需求的不给', () => {
  const root = parse(TREE);
  assert.deepStrictEqual(codex.unitsForFiles(root, ['DataScience/ch01-a.html']).map(u => u.id), ['C2', 'C2.1']);
  assert.deepStrictEqual(codex.unitsForFiles(root, ['DataScience/ch02-b.html']).map(u => u.id), ['C2', 'C2.2']);
  assert.deepStrictEqual(codex.unitsForFiles(root, ['README.md']).map(u => u.id), []);
});

// ---------- hook 端到端（真实进程，模拟 Codex 的输入） ----------

function runHook(input, env = {}) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env } });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}
const ctx = out => out && out.hookSpecificOutput && out.hookSpecificOutput.additionalContext;

test('hook：读到哪个需求的文件送哪份规则，每份每会话只送一次；AI 自己读过规则文件就不送', () => {
  const dir = project();
  inst.installCodex(dir);
  const base = { session_id: 'sess-a', cwd: dir, turn_id: 't1' };
  assert.strictEqual(runHook({ ...base, hook_event_name: 'SessionStart', source: 'startup' }), null);
  const read1 = runHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: `powershell -Command "Get-Content -Raw 'DataScience/ch01-a.html'"` } });
  assert.strictEqual(read1.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(ctx(read1), /开场用霍乱/);
  assert.match(ctx(read1), /不引原话/, '上级 C2 的规则一起送');
  assert.ok(!/接着第1章/.test(ctx(read1)), '第2章的规则不送');
  assert.ok(!/段落不超过 4 行/.test(ctx(read1).replace(/取代上级 P 的「段落不超过 4 行」/, '')), '全局规则在 AGENTS.md 里，不重复送');
  const again = runHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: DataScience/ch01-a.html\n@@\n-1\n+2\n*** End Patch' } });
  assert.strictEqual(again, null, '同一会话不重复送');
  // AI 照索引读了 C2.2 的规则文件，再改第2章：不再送
  assert.strictEqual(runHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'Get-Content .reqtree/rules/C2.2.md' } }), null);
  assert.strictEqual(runHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: `Set-Content -Path 'DataScience/ch02-b.html' -Value '<p>3</p>'` } }), null);
  // 上下文压缩后（SessionStart source=compact）重新送
  runHook({ ...base, hook_event_name: 'SessionStart', source: 'compact' });
  assert.match(ctx(runHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cat DataScience/ch01-a.html' } })), /开场用霍乱/);
  // 活动记录：apply_patch 和 PowerShell 写文件都记，纯读不记
  const acts = read(dir, '.reqtree/activity.jsonl').trim().split('\n').map(l => JSON.parse(l));
  assert.deepStrictEqual(acts.map(a => [a.node, a.file, a.agent]), [['C2.1', 'DataScience/ch01-a.html', 'codex'], ['C2.2', 'DataScience/ch02-b.html', 'codex']]);
});

test('hook：会话中途全局规则变了，下一句话时补送新版托管块；规则改了的单元再碰到时重送', () => {
  const dir = project();
  inst.installCodex(dir);
  const base = { session_id: 'sess-b', cwd: dir };
  runHook({ ...base, hook_event_name: 'SessionStart', source: 'startup' });
  assert.strictEqual(runHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: '继续' }), null);
  runHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cat DataScience/ch01-a.html' } });
  const tree = path.join(dir, '需求树.md');
  fs.writeFileSync(tree, TREE.replace('语气平实', '语气平实，少用"你"').replace('开场用霍乱', '开场用伦敦地图'));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(tree, later, later);
  const out = runHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: '接着改' });
  assert.match(ctx(out), /语气平实，少用"你"/);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.strictEqual(runHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: '再来' }), null, '送过一次就不再送');
  assert.match(ctx(runHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cat DataScience/ch01-a.html' } })), /伦敦地图/);
});

test('hook：Stop 交给 hook.js 启动记录员，记录员用配置的命令（这里是假模型）把新规则写进树和 AGENTS.md', async () => {
  const dir = project();
  inst.installCodex(dir);
  const env = {
    REQTREE_CODEX_RECORDER_CMD: `"${process.execPath}" "${FAKE}"`, REQTREE_CLAUDE_CMD: '',
    FAKE_LOG: path.join(dir, 'fake.log'), FAKE_OUT: '{"ops":[{"op":"add_rule","node":"P","text":"每章结尾加一道思考题"}]}',
  };
  const base = { session_id: 'sess-c', cwd: path.join(dir, 'DataScience') }; // 在子目录启动也能找到树
  runHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: '以后每章结尾都加一道思考题' }, env);
  runHook({ ...base, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: '好的，已加上。' }, env);
  // 树先写盘、AGENTS.md 随后编译：两样都等到（只等树的话，负载高时会读到还没重编的 AGENTS.md）
  for (let i = 0; i < 300 && !(read(dir, '需求树.md').includes('思考题') && read(dir, 'AGENTS.md').includes('思考题')); i++) await new Promise(r => setTimeout(r, 100));
  assert.match(read(dir, '需求树.md'), /- 每章结尾加一道思考题/);
  assert.match(read(dir, 'AGENTS.md'), /- 每章结尾加一道思考题/, '写树后自动重编 AGENTS.md');
  const sent = JSON.parse(read(dir, 'fake.log').trim().split('\n')[0]);
  assert.match(sent.input, /以后每章结尾都加一道思考题/);
  assert.match(sent.input, /好的，已加上。/);
  assert.ok(sent.env, '记录员调用模型时带 REQTREE_RECORDER，不会再触发 hook');
});

test('hook：没有需求树的项目什么都不做；坏输入不报错', () => {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'empty-'));
  fs.mkdirSync(path.join(dir, '.git'));
  assert.strictEqual(runHook({ hook_event_name: 'PostToolUse', session_id: 'x', cwd: dir, tool_name: 'Bash', tool_input: { command: 'cat a.html' } }), null);
  const r = spawnSync(process.execPath, [HOOK], { input: '不是 JSON', encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

test('记录员：没有根据的 add_files 丢掉（已覆盖的文件、用户没提、也不是未归属文件），有根据的保留', () => {
  const { filterAddFiles } = require('../hooks/recorder');
  const root = parse(TREE);
  const other = { op: 'add_rule', node: 'P', text: 'x' };
  // 2026-10-22 实测的情况：没有未归属文件，用户也没提路径，模型给 C2.2 加了已被 ch02-*.html 覆盖的文件
  assert.deepStrictEqual(filterAddFiles([other, { op: 'add_files', node: 'C2.2', globs: ['DataScience/ch02-b.html'] }],
    { root, unmapped: [], user: '以后每章结尾都加一道思考题' }), [other]);
  // 用户提到了路径，但文件已被现有范围覆盖：还是丢
  assert.deepStrictEqual(filterAddFiles([{ op: 'add_files', node: 'C2.2', globs: ['DataScience/ch02-b.html'] }],
    { root, user: '给 DataScience/ch02-b.html 加一道题' }), []);
  // 匹配这一轮没归属的文件：保留
  const un = { op: 'add_files', node: 'C9', globs: ['notes/*.md'] };
  assert.deepStrictEqual(filterAddFiles([un], { root, unmapped: ['notes/a.md'], user: '继续' }), [un]);
  // 用户明确说了文件：保留（含还没建好的新需求）
  const asked = { op: 'add_files', node: 'C5', globs: ['English/**'] };
  assert.deepStrictEqual(filterAddFiles([asked], { root, user: '英语课对应 English 文件夹' }), [asked]);
  // 多个 glob 只留有根据的
  assert.deepStrictEqual(filterAddFiles([{ op: 'add_files', node: 'C9', globs: ['notes/*.md', 'misc/*.txt'] }], { root, unmapped: ['notes/a.md'] }),
    [{ op: 'add_files', node: 'C9', globs: ['notes/*.md'] }]);
});

test('编译失败的提醒（hook.js 给的）Codex 也收到；托管块不完整算编译失败', () => {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'cf-'));
  fs.writeFileSync(path.join(dir, '需求树.md'), '# P x\n- 全局规则\n');
  fs.mkdirSync(path.join(dir, '.reqtree'));
  fs.writeFileSync(path.join(dir, '.reqtree', 'codex.json'), '{}');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), `# 我的\n${codex.BEGIN}\n旧的\n`);
  const tree = path.join(dir, '需求树.md');
  store.compileTree(tree, { force: true });
  assert.strictEqual(store.readCompileStatus(tree).ok, false);
  assert.match(store.readCompileStatus(tree).message, /不完整/);
  const out = runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'cf1', cwd: dir, prompt: '改一下首页' });
  assert.match(out.hookSpecificOutput.additionalContext, /需求树编译失败/);
});

test('只装了 Codex 的项目：挂的文档改了也重编（行号、目录不过时）', () => {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'cd-'));
  fs.mkdirSync(path.join(dir, 'c'));
  fs.writeFileSync(path.join(dir, 'c', 'rules.md'), '# 课\n用途：课的规则\n');
  fs.writeFileSync(path.join(dir, '需求树.md'), '# P x\n\n## C1 课\n> 文件：c/**\n> 文档：c/rules.md\n- 每章配图\n');
  fs.mkdirSync(path.join(dir, '.reqtree'));
  fs.writeFileSync(path.join(dir, '.reqtree', 'codex.json'), '{}');
  const tree = path.join(dir, '需求树.md');
  assert.deepStrictEqual(targetsOf(dir), { claude: false, codex: true });
  compile(tree);
  assert.strictEqual(ensureCompiled(tree), null);
  const later = new Date(Date.now() + 60000);
  fs.writeFileSync(path.join(dir, 'c', 'rules.md'), '# 课\n用途：课的规则（改过）\n');
  fs.utimesSync(path.join(dir, 'c', 'rules.md'), later, later);
  assert.ok(ensureCompiled(tree), '文档改过要重编');
  assert.match(fs.readFileSync(path.join(dir, '.reqtree', 'rules', 'C1.md'), 'utf8'), /改过/);
});
