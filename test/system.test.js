'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const store = require('../src/store');
const P = require('../src/parser');

// 测试用独立的临时目录，别把日志和状态写进真实环境（会混淆排查）
// 真实路径：Windows CI 上 os.tmpdir() 是 8.3 短路径（RUNNER~1），hook 记的是 realpath，两边要一致
const SANDBOX = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reqtree-sandbox-')));
process.env.TEMP = process.env.TMP = process.env.TMPDIR = SANDBOX;
// init 把 hook 复制到 ~/.reqtree/runtime；测试里换到沙盒，别碰真实的用户目录
process.env.REQTREE_HOME = path.join(SANDBOX, 'home', '.reqtree');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'hooks', 'hook.js');
const RECORDER = path.join(ROOT, 'hooks', 'recorder.js');
const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
// 命令行 init 会用 AI 初始化：子进程一律用假 claude（它返回的东西初始化用不上，树保持按文件夹生成的样子）
process.env.REQTREE_CLAUDE_CMD = process.env.REQTREE_INIT_CMD = `"${process.execPath}" "${FAKE}"`;

const TREE = `# P 测试项目
- [段落] 段落不超过 4 行

## C2 数据科学课 🔨
> 文件：DataScience/**
- 不引原话

### C2.1 第1章 ⏳
> 文件：DataScience/ch01-*.html
- 开场用霍乱
`;

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqtree-test-'));
  fs.mkdirSync(path.join(dir, 'DataScience'));
  fs.writeFileSync(path.join(dir, '需求树.md'), TREE);
  return dir;
}

let session = 0;
function hook(dir, input, env = {}) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd: dir, session_id: input.session_id || `s${process.pid}-${session}`, ...input }),
    encoding: 'utf8', env: { ...process.env, ...env },
  });
  assert.strictEqual(res.stderr, '', res.stderr);
  return res.stdout;
}
const edit = (dir, rel, extra = {}) => ({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dir, rel) }, ...extra });

function transcript(dir, turns) {
  const f = path.join(dir, 't.jsonl');
  const lines = [];
  for (const [u, a] of turns) {
    lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: u }] } }));
    lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }));
    lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: a }] } }));
  }
  fs.writeFileSync(f, lines.join('\n'));
  return f;
}

function runRecorder(dir, job, env = {}) {
  const jobFile = path.join(dir, `job-${Math.random()}.json`);
  fs.writeFileSync(jobFile, JSON.stringify({ treePath: path.join(dir, '需求树.md'), touched: [], unmapped: [], ...job }));
  const log = path.join(dir, 'fake.log');
  spawnSync(process.execPath, [RECORDER, jobFile], {
    encoding: 'utf8',
    env: { ...process.env, REQTREE_CLAUDE_CMD: `"${process.execPath}" "${FAKE}"`, FAKE_LOG: log, ...env },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { calls, status: store.readRecorderStatus(path.join(dir, '需求树.md')), tree: fs.readFileSync(path.join(dir, '需求树.md'), 'utf8') };
}

// ---------- store ----------

test('findTree：优先 需求树.md，只看根目录', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqtree-test-'));
  assert.strictEqual(store.findTree(dir), null);
  fs.writeFileSync(path.join(dir, 'b.tree.md'), '');
  fs.writeFileSync(path.join(dir, 'a.tree.md'), '');
  assert.strictEqual(path.basename(store.findTree(dir)), 'a.tree.md');
  fs.writeFileSync(path.join(dir, '需求树.md'), '');
  assert.strictEqual(path.basename(store.findTree(dir)), '需求树.md');
});

test('updateTree：多个进程同时写，一条都不丢', async () => {
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  const code = `const s=require(${JSON.stringify(path.join(ROOT, 'src', 'store.js'))});
    for(let i=0;i<5;i++) s.updateTree(${JSON.stringify(tree)}, t => t + '- w' + process.argv[1] + '-' + i + '\\n');`;
  const procs = Array.from({ length: 6 }, (_, k) => new Promise(res => spawn(process.execPath, ['-e', code, String(k)]).on('exit', res)));
  await Promise.all(procs);
  const text = fs.readFileSync(tree, 'utf8');
  assert.strictEqual((text.match(/- w\d-\d/g) || []).length, 30);
  assert.ok(!fs.existsSync(store.metaFile(tree, 'tree.lock')), '锁已释放');
});

// 竞态很难稳定复现，改为检查不变量：写某个文件的那一刻，对应的锁必须被占着
function lockHeldWhileWriting(match, lock, fn) {
  const seen = [];
  const { writeFileSync, renameSync } = fs;
  const spy = orig => function (file, ...rest) { if (match(String(file))) seen.push(fs.existsSync(lock)); return orig.call(fs, file, ...rest); };
  fs.writeFileSync = spy(writeFileSync);
  fs.renameSync = function (from, to) { if (match(String(to))) seen.push(fs.existsSync(lock)); return renameSync.call(fs, from, to); };
  try { fn(); } finally { fs.writeFileSync = writeFileSync; fs.renameSync = renameSync; }
  return seen;
}

test('编译在锁里：写树后的编译、hook 触发的编译，都在持锁时写规则文件', () => {
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  const lock = store.metaFile(tree, 'tree.lock');
  const isRule = f => f.replace(/\\/g, '/').includes('/.claude/rules/reqtree/');
  const seen = lockHeldWhileWriting(isRule, lock, () => store.updateTree(tree, t => t + '- 新规则\n'));
  assert.ok(seen.length > 0, '应该编译了');
  assert.ok(seen.every(Boolean), '编译时锁已经释放了');
  fs.writeFileSync(tree, TREE + '- 再来一条\n');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(tree, later, later);
  const seen2 = lockHeldWhileWriting(isRule, lock, () => store.compileTree(tree));
  assert.ok(seen2.length > 0 && seen2.every(Boolean));
});

test('编译出错记进 state.json，修好后恢复', () => {
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  // 让规则目录变成一个文件，编译必然失败
  fs.mkdirSync(path.join(dir, '.claude', 'rules'), { recursive: true });
  fs.writeFileSync(rulesDir(dir), 'x');
  store.updateTree(tree, t => t + '- 新规则\n');
  const bad = store.readCompileStatus(tree);
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.message);
  assert.match(fs.readFileSync(tree, 'utf8'), /- 新规则/, '编译失败不影响写树');
  fs.unlinkSync(rulesDir(dir));
  store.updateTree(tree, t => t + '- 又一条\n');
  assert.strictEqual(store.readCompileStatus(tree).ok, true);
  assert.match(ruleFile(dir, 'C2.1'), /又一条/);
  assert.ok(!fs.existsSync(store.metaFile(tree, 'compile.json')), '不再写单独的 compile.json');
});

// ---------- .reqtree/ 状态文件 ----------

test('state.json：多个进程同时读改写，一条都不丢', async () => {
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  const code = `const s=require(${JSON.stringify(path.join(ROOT, 'src', 'store.js'))});
    for(let i=0;i<5;i++){ s.touch(${JSON.stringify(tree)}, ['N' + process.argv[1] + '_' + i]); s.writeRecorderStatus(${JSON.stringify(tree)}, { ok: true, message: process.argv[1] }); }`;
  await Promise.all(Array.from({ length: 6 }, (_, k) => new Promise(res => spawn(process.execPath, ['-e', code, String(k)]).on('exit', res))));
  assert.strictEqual(Object.keys(store.readTouched(tree)).length, 30);
  assert.ok(store.readRecorderStatus(tree).ok);
  assert.ok(!fs.existsSync(store.metaFile(tree, 'state.lock')), '锁已释放');
});

test('config.json：只认 recorder 一个开关，面板传来别的键（如旧的 confirm）不写', () => {
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  assert.deepStrictEqual(store.readConfig(tree), { recorder: 'turn', sweepEvery: 8, aiFindings: true, principles: true, recordEvery: 1, codeMap: true });
  store.writeConfig(tree, { recorder: 'off', confirm: true, junk: 1 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(store.metaFile(tree, 'config.json'), 'utf8')), { recorder: 'off', sweepEvery: 8, aiFindings: true, principles: true, recordEvery: 1, codeMap: true });
});

test('state.lock 被崩溃的进程留下：很快判定失效，写状态不报错', () => {
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  const lock = store.metaFile(tree, 'state.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 3000);
  fs.utimesSync(lock, old, old);
  store.touch(tree, ['C2']);
  store.writeConfig(tree, { recorder: 'off' });
  assert.ok(store.readTouched(tree).C2);
  assert.strictEqual(store.readConfig(tree).recorder, 'off');
});

// 锁一直拿不到：把 state.lock 建成目录，独占创建永远失败、也删不掉
const blockState = tree => fs.mkdirSync(store.metaFile(tree, 'state.lock'), { recursive: true });

test('锁被占着时：插件的异步写会等锁释放；不等锁的编译直接跳过', async () => {
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  const lock = store.metaFile(tree, 'tree.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, '');
  assert.strictEqual(store.compileTree(tree, { wait: false }), null);
  assert.ok(!fs.existsSync(rulesDir(dir)));
  let done = false;
  const p = store.updateTreeAsync(tree, t => t + '- 异步写的\n').then(() => { done = true; });
  await new Promise(r => setTimeout(r, 100));
  assert.ok(!done, '锁还在，不该写进去');
  fs.unlinkSync(lock);
  await p;
  assert.match(fs.readFileSync(tree, 'utf8'), /- 异步写的/);
  assert.match(ruleFile(dir, 'C2.1'), /异步写的/);
});

test('排队加锁：往队列里加和取出时都持有队列锁', () => {
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  const isQueue = f => path.basename(f) === 'queue.json';
  store.setEditing(tree, true);
  const seen = lockHeldWhileWriting(isQueue, store.metaFile(tree, 'queue.lock'), () => {
    store.submitOps(tree, [{ op: 'add_rule', node: 'C2', text: '甲' }]);
    store.submitOps(tree, [{ op: 'add_rule', node: 'C2', text: '乙' }]);
  });
  assert.ok(seen.length >= 2 && seen.every(Boolean), '读改写队列时没加锁');
  store.setEditing(tree, false);
  assert.strictEqual(store.flushQueue(tree).length, 2);
  assert.ok(!fs.existsSync(store.metaFile(tree, 'queue.lock')), '锁已释放');
});

test('用户编辑中：记录员的改动排队，保存后写入', () => {
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  store.setEditing(tree, true);
  const r = store.submitOps(tree, [{ op: 'add_rule', node: 'C2', text: '新规则' }]);
  assert.strictEqual(r.queued, 1);
  assert.strictEqual(fs.readFileSync(tree, 'utf8'), TREE, '编辑中不碰文件');
  assert.deepStrictEqual(store.flushQueue(tree), [], '编辑中也不 flush');
  store.setEditing(tree, false);
  assert.strictEqual(store.flushQueue(tree).length, 1);
  assert.match(fs.readFileSync(tree, 'utf8'), /^- 新规则$/m, '默认直接生效，不带标记');
});

// ---------- compile ----------

const { compile, ensureCompiled } = require('../src/compile');
const rulesDir = dir => path.join(dir, '.claude', 'rules', 'reqtree');
const ruleFile = (dir, id) => fs.readFileSync(path.join(rulesDir(dir), `${id}.md`), 'utf8');

test('编译：每个节点一份原生规则，继承交给 glob 嵌套，覆盖写成明确说明', () => {
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  fs.writeFileSync(tree, TREE.replace('- 开场用霍乱', '- [段落] 开场段落可以到 6 行\n- 开场用霍乱') + '\n### C2.2 子需求没有文件\n- 只在数据科学课范围内\n\n## G1 写作（全局分类）\n- 先场景后概念\n');
  const r = compile(tree);
  assert.deepStrictEqual(r.written.sort(), ['C2.1.md', 'C2.2.md', 'C2.md', 'P.md', '_index.md'], 'G1 没有文件对应，不编译（否则会在做别的事时也加载）');
  assert.ok(!ruleFile(dir, 'P').startsWith('---'), '根节点规则全局加载，不写 paths');
  assert.match(ruleFile(dir, 'C2'), /paths:\n  - "DataScience\/\*\*"/);
  assert.ok(!ruleFile(dir, 'C2.1').includes('不引原话'), '不抄上级规则，靠 glob 嵌套继承');
  assert.match(ruleFile(dir, 'C2.1'), /开场段落可以到 6 行（在本范围内以此为准，取代上级 P 的「段落不超过 4 行」）/);
  assert.match(ruleFile(dir, 'C2.2'), /"DataScience\/\*\*"/, '没写文件对应就沿用上级范围');
  assert.match(ruleFile(dir, '_index'), /进行中：C2 数据科学课/);
});

test('编译：旧版本生成的 _index.md（说明文字过时）升级后会重新生成，哪怕它比树新', () => {
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  compile(tree);
  const idx = path.join(rulesDir(dir), '_index.md');
  fs.writeFileSync(idx, '<!-- reqtree:generated -->\n## 需求树\n用户提出的长期要求由后台记录员在每轮结束后写进需求树（标 🆕，等用户确认）\n');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(idx, later, later);
  assert.ok(ensureCompiled(tree), '应该重新编译');
  assert.doesNotMatch(fs.readFileSync(idx, 'utf8'), /确认/);
  assert.strictEqual(ensureCompiled(tree), null, '当前格式的不再重编');
});

test('编译：内容没变不重写（免得触发无谓的变更通知）；ensureCompiled 只在树更新后才编译', () => {
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  compile(tree);
  assert.deepStrictEqual(compile(tree).written, []);
  assert.strictEqual(ensureCompiled(tree), null);
  const later = new Date(Date.now() + 5000);
  fs.writeFileSync(tree, TREE + '- 新规则\n');
  fs.utimesSync(tree, later, later);
  assert.deepStrictEqual(ensureCompiled(tree).written, ['C2.1.md']);
});

test('store.updateTree 写完自动编译', () => {
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  store.updateTree(tree, t => t.replace('- 不引原话', '- 不引原话\n- 每章配一张地图'));
  assert.match(ruleFile(dir, 'C2'), /每章配一张地图/);
});

// ---------- hook ----------

const sid = () => `s${process.pid}-${++session}`;
const activity = dir => store.readActivity(path.join(dir, '需求树.md'), 3600000);

test('hook：不往 AI 上下文里塞东西；发消息时编译规则', () => {
  const dir = project();
  const out = hook(dir, { hook_event_name: 'UserPromptSubmit', session_id: sid(), prompt: '你好' });
  assert.strictEqual(out, '');
  assert.ok(fs.existsSync(path.join(rulesDir(dir), 'C2.1.md')));
});

test('hook：记下 AI 改了哪个需求（含子 agent），未归属的文件记为 null', () => {
  const dir = project();
  const s = sid();
  assert.strictEqual(hook(dir, edit(dir, 'DataScience/ch01-a.html', { session_id: s })), '');
  hook(dir, edit(dir, 'DataScience/css/x.css', { session_id: s, agent_id: 'sub1' }));
  hook(dir, edit(dir, 'notes/todo.md', { session_id: s }));
  hook(dir, edit(dir, '.claude/rules/reqtree/C2.md', { session_id: s }));
  const a = activity(dir);
  assert.deepStrictEqual(a.map(e => [e.node, e.agent]), [['C2.1', null], ['C2', 'sub1'], [null, null]]);
  assert.strictEqual(fs.readFileSync(path.join(dir, '需求树.md'), 'utf8'), TREE, 'hook 不写树');
});

test('hook：AI 改了需求树，规则立刻重新编译', () => {
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  hook(dir, { hook_event_name: 'UserPromptSubmit', session_id: sid() });
  fs.writeFileSync(tree, TREE + '- 一屏内出现悬念\n');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(tree, later, later);
  hook(dir, edit(dir, '需求树.md'));
  assert.match(ruleFile(dir, 'C2.1'), /一屏内出现悬念/);
});

test('hook：不跟踪 Bash（旧配置里 matcher 还带 Bash 时也不记）', () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, 'DataScience', 'ch01-x.html'), 'x');
  hook(dir, { hook_event_name: 'PostToolUse', session_id: sid(), tool_name: 'Bash', tool_input: { command: 'sed -i "s/a/b/" DataScience/ch01-x.html' } });
  assert.deepStrictEqual(activity(dir), []);
});

test('hook：读到旧版本的状态文件也能正常工作', () => {
  const dir = project();
  const s = sid();
  const tree = path.join(dir, '需求树.md');
  const key = require('crypto').createHash('md5').update((['win32', 'darwin'].includes(process.platform) ? tree.toLowerCase() : tree) + '|' + s).digest('hex');
  fs.mkdirSync(path.join(os.tmpdir(), 'reqtree'), { recursive: true });
  fs.writeFileSync(path.join(os.tmpdir(), 'reqtree', key + '.json'), JSON.stringify({ tree: {}, node: 'C2', prompts: ['旧'], agents: 'bad' }));
  hook(dir, { hook_event_name: 'UserPromptSubmit', session_id: s, prompt: '以后都用伦敦地图开场' });
  const log = fs.readFileSync(path.join(os.tmpdir(), 'reqtree', 'hook.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(!log.some(e => e.error), log.filter(e => e.error).map(e => e.error).join('\n'));
});

test('hook：记录员自己调用 claude 时不触发', () => {
  const dir = project();
  hook(dir, { hook_event_name: 'UserPromptSubmit', session_id: sid() }, { REQTREE_RECORDER: '1' });
  assert.ok(!fs.existsSync(rulesDir(dir)));
});

test('hook：一轮结束交给记录员——只用公开字段（prompt、last_assistant_message），不读对话记录', async () => {
  const dir = project();
  const s = sid();
  const log = path.join(dir, 'fake.log');
  const env = { REQTREE_CLAUDE_CMD: `"${process.execPath}" "${FAKE}"`, FAKE_LOG: log, FAKE_OUT: '{"ops":[{"op":"add_rule","node":"C2.1","text":"开场用伦敦地图"}]}' };
  hook(dir, { hook_event_name: 'UserPromptSubmit', session_id: s, prompt: '第1章开头别用霍乱了，改成伦敦地图' }, env);
  hook(dir, edit(dir, 'DataScience/ch01-a.html', { session_id: s }), env);
  hook(dir, edit(dir, 'notes/unmapped.md', { session_id: s }), env);
  hook(dir, { hook_event_name: 'Stop', session_id: s, transcript_path: path.join(dir, '不存在.jsonl'), last_assistant_message: '好的，已改成伦敦地图' }, env);
  const tree = path.join(dir, '需求树.md');
  for (let i = 0; i < 100 && !store.readRecorderStatus(tree); i++) await new Promise(r => setTimeout(r, 100));
  const st = store.readRecorderStatus(tree);
  assert.ok(st && st.ok, JSON.stringify(st));
  const call = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').pop());
  assert.match(call.input, /用户：第1章开头别用霍乱了/);
  assert.match(call.input, /AI：好的，已改成伦敦地图/);
  assert.match(call.input, /notes\/unmapped\.md/);
  const text = fs.readFileSync(tree, 'utf8');
  assert.match(text, /### C2\.1 第1章 🔨/, '改过的需求自动标 🔨');
  assert.match(text, /^- 开场用伦敦地图$/m, '默认直接生效');
  assert.match(ruleFile(dir, 'C2.1'), /开场用伦敦地图/, '记录员写完树，规则已重新编译');
  assert.ok(store.readTouched(tree)['C2.1']);
});

test('hook：state.json 写不进去（锁一直被占）时，Stop 照样整理活动日志、不报错', () => {
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  const s = sid();
  const env = { REQTREE_CLAUDE_CMD: `"${process.execPath}" "${FAKE}"`, FAKE_LOG: path.join(dir, 'fake.log') };
  blockState(tree);
  // 一份超过 512 KB 的旧活动日志，Stop 时应该被截到 2000 行
  const junk = JSON.stringify({ node: null, file: 'old/x.md', time: 1, session: 'old' }) + '\n';
  fs.writeFileSync(store.metaFile(tree, 'activity.jsonl'), junk.repeat(12000));
  assert.ok(fs.statSync(store.metaFile(tree, 'activity.jsonl')).size > 512 * 1024);
  hook(dir, { hook_event_name: 'UserPromptSubmit', session_id: s, prompt: '好' }, env);
  hook(dir, edit(dir, 'DataScience/ch01-a.html', { session_id: s }), env);
  hook(dir, { hook_event_name: 'Stop', session_id: s, last_assistant_message: '好的' }, env);
  const lines = fs.readFileSync(store.metaFile(tree, 'activity.jsonl'), 'utf8').trim().split('\n').length;
  assert.ok(lines <= 2000, `活动日志没整理：${lines} 行`);
  const trace = fs.readFileSync(path.join(os.tmpdir(), 'reqtree', 'hook.log'), 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.ev === 'Stop').pop();
  assert.ok(!trace.error, trace.error);
});

// ---------- recorder ----------

test('记录员：树已经改好、只是状态写不进去时，不记成「出错」', () => {
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  blockState(tree);
  const r = runRecorder(dir, { turns: [{ user: '以后每章例子要足一点', ai: '好' }] }, { FAKE_OUT: '{"ops":[{"op":"add_rule","node":"C2","text":"每章例子要足一点"}]}' });
  assert.match(r.tree, /^- 每章例子要足一点$/m);
  const lines = fs.readFileSync(path.join(os.tmpdir(), 'reqtree', 'recorder.log'), 'utf8').split('\n').filter(l => l.includes('每章例子要足一点'));
  assert.ok(lines.length, '记录员没把结果写进日志');
  assert.ok(lines.every(l => !l.includes('出错')), lines.join('\n'));
});

test('记录员：理解"就按你说的"，调用模型时带上 AI 的回复和本轮改动', () => {
  const dir = project();
  const t = transcript(dir, [['练习题太少了', '我建议加到 5 道，其中一道考为什么被发明'], ['就按你说的，以后每章都这样', '好的']]);
  const out = '{"ops":[{"op":"add_rule","node":"P","text":"每章 5 道练习题，其中一道考为什么被发明"}]}';
  const r = runRecorder(dir, { transcriptPath: t, touched: ['C2.1'], unmapped: ['notes/x.md'] }, { FAKE_OUT: out });
  assert.strictEqual(r.calls.length, 1);
  assert.ok(r.calls[0].env, '调用模型时带 REQTREE_RECORDER，防止递归');
  assert.match(r.calls[0].input, /我建议加到 5 道/);
  assert.match(r.calls[0].input, /C2\.1/);
  assert.match(r.calls[0].input, /notes\/x\.md/);
  assert.match(r.tree, /^- 每章 5 道练习题/m);
  assert.match(r.tree, /### C2\.1 第1章 🔨/);
  assert.match(r.status.message, /记下 1 条(；|$)/);
});

test('记录员：没实质内容的消息不调用模型，但仍标 🔨', () => {
  for (const msg of ['好', '继续', '好的。', '/compact', '这个文件在哪？']) {
    const dir = project();
    const r = runRecorder(dir, { transcriptPath: transcript(dir, [[msg, '...']]), touched: ['C2.1'] });
    assert.strictEqual(r.calls.length, 0, msg);
    assert.match(r.tree, /C2\.1 第1章 🔨/, msg);
  }
  const dir = project();
  const r = runRecorder(dir, { transcriptPath: transcript(dir, [['第1章开头用伦敦地图', '好']]) });
  assert.strictEqual(r.calls.length, 1, '没有关键词的要求也要交给模型');
});

test('记录员：出错写进状态文件，面板能显示', () => {
  const dir = project();
  const r = runRecorder(dir, { transcriptPath: transcript(dir, [['以后都不要用表情符号', '好']]) }, { FAKE_EXIT: '1' });
  assert.strictEqual(r.status.ok, false);
  assert.match(r.status.message, /Not logged in/);
  const r2 = runRecorder(dir, { transcriptPath: path.join(dir, 'missing.jsonl') });
  assert.strictEqual(r2.status.ok, false);
  assert.match(r2.status.message, /拿不到这一轮的对话/);
  const r3 = runRecorder(dir, { transcriptPath: transcript(dir, [['以后都不要用表情符号', '好']]) }, { FAKE_OUT: '我觉得没有' });
  assert.match(r3.status.message, /没有返回 JSON/);
});

test('记录员：用户编辑中，改动排队并在状态里说明', () => {
  const dir = project();
  store.setEditing(path.join(dir, '需求树.md'), true);
  const r = runRecorder(dir, { transcriptPath: transcript(dir, [['以后都不要用表情符号', '好']]) },
    { FAKE_OUT: '{"ops":[{"op":"add_rule","node":"P","text":"不用表情符号"}]}' });
  assert.strictEqual(r.tree, TREE);
  assert.match(r.status.message, /等你保存/);
});

test('记录员：树很大时只发精简版', () => {
  const dir = project();
  const big = TREE + Array.from({ length: 120 }, (_, i) => `## X${i} 节点${i}\n- 规则${i}\n`).join('');
  fs.writeFileSync(path.join(dir, '需求树.md'), big);
  const r = runRecorder(dir, { transcriptPath: transcript(dir, [['以后都不要用表情符号', '好']]), touched: ['C2.1'] });
  assert.match(r.calls[0].input, /1 条规则未列出/);
  assert.match(r.calls[0].input, /开场用霍乱/, '本轮改过的分支保留原文');
});

test('记录员：暂停时不调用模型，只标进行中', () => {
  const dir = project();
  store.writeConfig(path.join(dir, '需求树.md'), { recorder: 'off' });
  const r = runRecorder(dir, { turns: [{ user: '以后都不要用表情符号', ai: '好' }], touched: ['C2.1'] });
  assert.strictEqual(r.calls.length, 0);
  assert.match(r.tree, /C2.1 第1章 🔨/);
  assert.match(r.status.message, /已暂停/);
});

test('改动记录：记录员和面板的改动都记下来，可以撤销，撤销后规则也重新编译', () => {
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  store.applyChange(tree, [{ op: 'replace_rule', node: 'C2.1', old: '开场用霍乱', text: '开场用伦敦地图' }], { source: '记录员' });
  store.applyChange(tree, [{ op: 'set_status', node: 'C2.1', status: 'done' }], { source: '你' });
  const list = store.readChanges(tree);
  assert.deepStrictEqual(list.map(c => c.source), ['你', '记录员'], '新的在前');
  assert.match(list[1].summary[0], /把 C2.1 的「开场用霍乱」改成「开场用伦敦地图」/);
  assert.match(ruleFile(dir, 'C2.1'), /伦敦地图/);
  // 撤销较早的那条：之后又改过状态，也能按反操作撤回
  assert.ok(store.undoChange(tree, list[1].id));
  const text = fs.readFileSync(tree, 'utf8');
  assert.match(text, /^- 开场用霍乱$/m);
  assert.match(text, /### C2.1 第1章 ✅/, '后面那次改动不受影响');
  assert.match(ruleFile(dir, 'C2.1'), /霍乱/);
  assert.strictEqual(store.readChanges(tree)[1].undone, true);
  assert.ok(!store.undoChange(tree, list[1].id), '不能撤销两次');
});

// ---------- init ----------

test('init：可重复运行，升级时替换旧配置、保留别的 hook', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqtree-test-'));
  const settings = path.join(dir, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(settings));
  fs.writeFileSync(settings, JSON.stringify({ permissions: { allow: ['x'] }, hooks: {
    // 旧版本 --track-bash 装的：matcher 带 Bash
    PostToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: 'node "C:/old/reqtree/hooks/hook.js"' }] },
      { matcher: 'Edit', hooks: [{ type: 'command', command: 'prettier' }] }],
    // 从改过名的目录装的旧版本也要认出来
    Stop: [{ hooks: [{ type: 'command', command: 'node "C:\\\\Users\\\\me\\\\reqtree-0.7.0\\\\hooks\\\\hook.js"', async: true }] }],
  } }));
  const run = () => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'reqtree.js'), 'init', dir], { encoding: 'utf8' });
  run(); run();
  const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.deepStrictEqual(s.permissions, { allow: ['x'] });
  const cmds = ev => s.hooks[ev].flatMap(g => g.hooks.map(h => h.command));
  assert.strictEqual(cmds('PostToolUse').filter(c => c.includes('reqtree')).length, 1);
  assert.ok(cmds('PostToolUse').includes('prettier'));
  assert.strictEqual(s.hooks.PostToolUse.find(g => g.hooks[0].command.includes('reqtree')).matcher, 'Edit|Write|MultiEdit|NotebookEdit', '升级时去掉 Bash');
  // 旧的 --track-bash 选项被忽略，不会把目录当成 "--track-bash"
  spawnSync(process.execPath, [path.join(ROOT, 'bin', 'reqtree.js'), 'init', dir, '--track-bash']);
  const s2 = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.doesNotMatch(JSON.stringify(s2.hooks), /Bash/);
  assert.strictEqual(s2.hooks.PostToolUse.filter(g => g.hooks[0].command.includes('reqtree')).length, 1);
  assert.strictEqual(cmds('Stop').length, 1);
  assert.strictEqual(cmds('UserPromptSubmit').length, 1);
  assert.ok(fs.existsSync(path.join(dir, '需求树.md')));
  assert.strictEqual((fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').match(/\.reqtree/g) || []).length, 1);
});

test('viewmodel：🔨 久未动、活动过期；开始跟踪时间从 since 取', () => {
  const { viewData } = require('../src/viewmodel');
  const now = Date.now();
  const text = TREE.replace('### C2.1 第1章 ⏳', '### C2.1 第1章 🔨');
  const since = now - 5 * 86400000;
  const d = viewData([{ uri: 'u', name: 't', text, activity: [{ node: 'C2', time: now - 10 * 60000 }], touched: {}, since }], now);
  const c2 = d.files[0].nodes[0].children[0];
  const c21 = c2.children[0];
  assert.strictEqual(c21.stale, true);
  assert.strictEqual(c2.stale, false, '上级的 🔨 由下级撑着，不提示');
  assert.strictEqual(c2.active, null, '10 分钟前的活动已过期');
  // config 里不再有 since（它在 state.json）：放在那里不认
  const legacy = viewData([{ uri: 'u', name: 't', text, touched: {}, config: { since } }], now);
  assert.strictEqual(legacy.files[0].nodes[0].children[0].children[0].stale, false);
  const d2 = viewData([{ uri: 'u', name: 't', text, touched: { 'C2.1': now }, since }], now);
  const fresh = viewData([{ uri: 'u', name: 't', text, touched: {}, since: now - 3600000 }], now);
  assert.strictEqual(fresh.files[0].nodes[0].children[0].children[0].stale, false, '刚开始跟踪不算久未动');
  assert.strictEqual(d2.files[0].nodes[0].children[0].children[0].stale, false);
});

test('viewmodel：分支颜色、编译状态、久未动天数；不再给待确认相关字段', () => {
  const { viewData, STALE_DAYS } = require('../src/viewmodel');
  const text = TREE.replace('- 开场用霍乱', '- 🆕 新的\n- 🗑 删掉的\n- 开场用霍乱') + '\n## C3 🆕 新课\n- 🆕 新课的规则\n\n### C3.1 更细\n> 文件：🆕 X/**\n';
  const compile = { ok: false, message: '写不进去', time: 1 };
  const d = viewData([{ uri: 'u', name: 't', text, compile, config: { recorder: 'off' } }]);
  assert.strictEqual(d.staleDays, STALE_DAYS);
  assert.deepStrictEqual(d.files[0].compile, compile);
  assert.deepStrictEqual(d.files[0].config, { recorder: 'off' });
  const [p] = d.files[0].nodes;
  const [c2, c3] = p.children;
  assert.deepStrictEqual([p.branch, c2.branch, c2.children[0].branch, c3.branch, c3.children[0].branch], ['--fg', '--blue', '--blue', '--purple', '--purple']);
  // 🆕 🗑 只是普通文字（旧标记在升级时由 store 一次性清掉，viewmodel 不管）
  assert.strictEqual(c3.title, '🆕 新课');
  assert.deepStrictEqual(c2.children[0].groups[0].rules.map(r => r.text), ['🆕 新的', '🗑 删掉的', '开场用霍乱']);
  const json = JSON.stringify(d);
  for (const k of ['pending', 'pendingSelf', 'pendingDeep', 'pendingCount', 'pendingFiles', 'pendingTotal', 'canMoveUp']) {
    assert.ok(!json.includes(`"${k}"`), `还有 ${k} 字段`);
  }
});

test('改动记录：撤销没生效时返回 false、不记成已撤销', () => {
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  // 改动的内容后来被手改掉了：反操作一条都对不上
  store.applyChange(tree, [{ op: 'add_rule', node: 'C2', text: '例子要足' }], { source: '记录员' });
  const [c2] = store.readChanges(tree);
  fs.writeFileSync(tree, TREE);
  assert.strictEqual(store.undoChange(tree, c2.id), false);
  assert.strictEqual(store.readChanges(tree)[0].undone, false);
});

test('applyChange / undoChange 给了写入函数就交给它写，返回 Promise', async () => {
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  const calls = [];
  const write = async (p, update) => { calls.push(p); await new Promise(r => setTimeout(r, 5)); store.updateTree(p, update); };
  const r = store.applyChange(tree, [{ op: 'add_rule', node: 'C2', text: '例子要足' }], { source: '你', write });
  assert.ok(r instanceof Promise);
  assert.strictEqual((await r).length, 1);
  assert.strictEqual(calls.length, 1);
  const [c] = store.readChanges(tree);
  assert.strictEqual(c.summary[0], '给 C2 加规则「例子要足」');
  assert.strictEqual(await store.undoChange(tree, c.id, { write }), true);
  assert.strictEqual(fs.readFileSync(tree, 'utf8'), TREE);
  assert.strictEqual(calls.length, 2);
});

test('记录员：模型给出不允许的操作（删需求、换文件）一律丢掉', () => {
  const dir = project();
  const out = { ops: [{ op: 'delete_node', node: 'C2' }, { op: 'set_files', node: 'C2', globs: [] }, { op: 'insert_lines', at: 0, lines: ['x'] }, { op: 'add_rule', node: 'C2', text: '例子要足' }] };
  const r = runRecorder(dir, { turns: [{ user: '以后每章例子要足', ai: '好' }] }, { FAKE_OUT: JSON.stringify(out) });
  assert.ok(r.status.ok, JSON.stringify(r.status));
  assert.strictEqual(r.tree, TREE.replace('- 不引原话', '- 不引原话\n- 例子要足'));
});

test('hook：Stop 不写会话状态文件（避免和下一轮的 UserPromptSubmit 互相覆盖），上一轮 AI 的回复仍然带给记录员', async () => {
  const dir = project();
  const s = sid();
  const tree = path.join(dir, '需求树.md');
  const log = path.join(dir, 'fake.log');
  const env = { REQTREE_CLAUDE_CMD: `"${process.execPath}" "${FAKE}"`, FAKE_LOG: log };
  const key = require('crypto').createHash('md5').update((['win32', 'darwin'].includes(process.platform) ? tree.toLowerCase() : tree) + '|' + s).digest('hex');
  const stateFile = path.join(os.tmpdir(), 'reqtree', key + '.json');
  const waitRecorder = async n => { for (let i = 0; i < 100 && !(fs.existsSync(log) && fs.readFileSync(log, 'utf8').trim().split('\n').length >= n); i++) await new Promise(r => setTimeout(r, 100)); };
  hook(dir, { hook_event_name: 'UserPromptSubmit', session_id: s, prompt: '练习题太少了' }, env);
  const before = fs.readFileSync(stateFile, 'utf8');
  hook(dir, { hook_event_name: 'Stop', session_id: s, last_assistant_message: '我建议加到 5 道' }, env);
  assert.strictEqual(fs.readFileSync(stateFile, 'utf8'), before, 'Stop 改了状态文件');
  await waitRecorder(1);
  hook(dir, { hook_event_name: 'UserPromptSubmit', session_id: s, prompt: '就按你说的，以后每章都这样' }, env);
  hook(dir, { hook_event_name: 'Stop', session_id: s, last_assistant_message: '好的' }, env);
  await waitRecorder(2);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.match(calls[1].input, /我建议加到 5 道/, '上一轮 AI 的回复丢了');
  assert.match(calls[1].input, /用户：就按你说的/);
});

test('check：只读，不写配置', () => {
  const dir = project();
  const res = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'reqtree.js'), 'check', path.join(dir, '需求树.md')], { encoding: 'utf8' });
  assert.match(res.stdout, /没有发现问题/);
  assert.ok(!fs.existsSync(path.join(dir, '.reqtree', 'config.json')), 'check 写了配置');
  assert.ok(!fs.existsSync(path.join(dir, '.reqtree', 'state.json')), 'check 写了状态');
});

// ---------- 插件（用假的 vscode 模块跑 extension.js 的逻辑） ----------

function fakeVscode(dir, { input } = {}) {
  const docs = [];
  const shown = [];
  const disposable = { dispose() {} };
  const Uri = { file: p => ({ scheme: 'file', fsPath: p, toString: () => 'file:///' + p.replace(/\\/g, '/') }), joinPath: (u, ...s) => Uri.file(path.join(u.fsPath, ...s)) };
  let panel = null;
  const vscode = {
    Uri,
    Range: class { constructor(...a) { this.a = a; } },
    RelativePattern: class {},
    ThemeIcon: class {},
    ViewColumn: { Active: 1 },
    WorkspaceEdit: class { replace(uri, range, text) { this.text = text; } },
    workspace: {
      workspaceFolders: [{ uri: Uri.file(dir) }],
      textDocuments: docs,
      asRelativePath: p => path.basename(p),
      createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }),
      applyEdit: async e => { docs[0].text = e.text; return true; },
      onDidChangeTextDocument: () => disposable, onDidSaveTextDocument: () => disposable,
      onDidCloseTextDocument: () => disposable, onDidChangeWorkspaceFolders: () => disposable,
    },
    window: {
      registerWebviewViewProvider: (id, p) => { panel = p; return disposable; },
      showInputBox: async () => input,
      showInformationMessage: m => shown.push(m), showWarningMessage: async m => { shown.push(m); return '删除'; },
      showErrorMessage: m => shown.push(m),
    },
    commands: { registerCommand: () => disposable },
  };
  return { vscode, docs, shown, panel: () => panel };
}

function activateWith(fake, extra = {}) {
  const Module = require('module');
  const load = Module._load;
  Module._load = function (req, ...rest) { return req === 'vscode' ? fake.vscode : load.call(this, req, ...rest); };
  try {
    delete require.cache[require.resolve('../extension')];
    const ext = require('../extension');
    const context = { subscriptions: [], extensionUri: fake.vscode.Uri.file(ROOT), ...extra };
    const api = ext.activate(context);
    return { panel: fake.panel(), api, dispose: () => context.subscriptions.forEach(d => d.dispose && d.dispose()) };
  } finally { Module._load = load; }
}

test('插件：需求树在编辑器里有没保存的改动时，面板的编辑和撤销都写进编辑器，不丢用户的改动', async () => {
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  const fake = fakeVscode(dir, { input: '例子要足' });
  const doc = {
    uri: fake.vscode.Uri.file(tree), text: TREE + '- 用户还没保存的规则\n', isDirty: true,
    getText() { return this.text; }, get lineCount() { return this.text.split('\n').length; },
    async save() { fs.writeFileSync(tree, this.text); this.isDirty = false; return true; },
  };
  fake.docs.push(doc);
  const { panel, dispose } = activateWith(fake);
  try {
    const uri = panel.trees[0].uri;
    await panel.handle({ type: 'edit', uri, action: 'addRule', node: 'C2' });
    const disk = fs.readFileSync(tree, 'utf8');
    assert.match(disk, /- 用户还没保存的规则/, '用户没保存的改动被覆盖了');
    assert.match(disk, /^- 例子要足$/m);
    assert.match(ruleFile(dir, 'C2'), /例子要足/, '规则已编译');
    const [c] = store.readChanges(tree);
    assert.strictEqual(c.source, '你');
    // 撤销时用户又改了一处没保存
    doc.text = fs.readFileSync(tree, 'utf8') + '- 又一处没保存的\n'; doc.isDirty = true;
    await panel.handle({ type: 'undo', uri, id: c.id });
    const after = fs.readFileSync(tree, 'utf8');
    assert.ok(!after.includes('例子要足'));
    assert.match(after, /又一处没保存的/);
    // 树行改状态也走 edit，记进改动记录
    await panel.handle({ type: 'edit', uri, action: 'setStatus', node: 'C2.1', status: 'done' });
    assert.match(fs.readFileSync(tree, 'utf8'), /### C2\.1 第1章 ✅/);
    assert.match(store.readChanges(tree)[0].summary[0], /C2\.1 标为完成/);
    // 没改动时按操作给提示
    fake.vscode.window.showInputBox = async () => '第1章';
    await panel.handle({ type: 'edit', uri, action: 'rename', node: 'C2.1' });
    assert.match(fake.shown.pop(), /名字没变/);
  } finally { dispose(); }
});

test('插件：确认模式的消息（accept/reject/moveUp/acceptAll/rejectAll）一律忽略；⚙ 只写 recorder；打开原文按原文找回行号；面板数据带 since', async () => {
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  fs.writeFileSync(tree, TREE);
  const fake = fakeVscode(dir);
  const opened = [];
  fake.vscode.window.showTextDocument = async (uri, opts) => { opened.push(opts.selection.a[0]); };
  const { panel, dispose } = activateWith(fake);
  try {
    const uri = panel.trees[0].uri;
    assert.ok(panel.trees[0].since, '插件加载时记下开始跟踪的时间');
    assert.strictEqual(fs.readFileSync(tree, 'utf8'), TREE, '插件加载时不改树');
    const line = TREE.split('\n').findIndex(l => l.includes('霍乱'));
    for (const type of ['accept', 'reject', 'moveUp', 'acceptAll', 'rejectAll']) await panel.handle({ type, uri, line, expect: TREE.split('\n')[line] });
    assert.strictEqual(fs.readFileSync(tree, 'utf8'), TREE, '这些消息不该再改树');
    await panel.handle({ type: 'setConfig', uri, patch: { confirm: true, recorder: 'off' } });
    assert.deepStrictEqual(store.readConfig(tree), { recorder: 'off', sweepEvery: 8, aiFindings: true, principles: true, recordEvery: 1, codeMap: true });
    assert.ok(!('confirm' in JSON.parse(fs.readFileSync(store.metaFile(tree, 'config.json'), 'utf8'))));
    // 面板拿到行号后，树的上方被插了一行：按原文找回来
    const raw = TREE.split('\n')[1];
    assert.match(raw, /段落不超过 4 行/);
    fs.writeFileSync(tree, TREE.replace('# P 测试项目\n', '# P 测试项目\n- 新插入的一行\n'));
    await panel.handle({ type: 'open', uri, line: 1, expect: raw });
    await panel.handle({ type: 'open', uri, line: 1, expect: '- 已经不存在的一行' });
    assert.deepStrictEqual(opened, [2, 1], '找不到原文时退回原行号');
  } finally { dispose(); }
});

test('插件：⚙ 设置写不进去（state.lock 一直被占）时给出提示，不是悄悄没反应', async () => {
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  blockState(tree);
  const fake = fakeVscode(dir);
  const { panel, dispose } = activateWith(fake);
  try {
    await panel.handle({ type: 'setConfig', uri: panel.trees[0].uri, patch: { recorder: 'off' } });
    assert.ok(fake.shown.some(m => /设置没保存/.test(m)), fake.shown.join('\n'));
  } finally { dispose(); }
});

// ---------- 跨平台（Mac / Linux） ----------

function withPlatform(platform, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...desc, value: platform });
  try { return fn(); } finally { Object.defineProperty(process, 'platform', desc); }
}

test('samePath：Windows 和 macOS 不分大小写，Linux 区分', () => {
  assert.ok(withPlatform('win32', () => store.samePath('C:\\A\\b.md', 'c:\\a\\B.md')));
  assert.ok(withPlatform('darwin', () => store.samePath('/Users/A/b.md', '/users/a/B.md')));
  assert.ok(!withPlatform('linux', () => store.samePath('/home/A/b.md', '/home/a/b.md')));
});

test('hook：macOS 上会话状态的文件名也按小写路径算（和 Windows 一样，免得一个会话变成两份状态）', () => {
  const dir = path.join(project(), 'Proj');
  fs.mkdirSync(path.join(dir, 'DataScience'), { recursive: true });
  fs.writeFileSync(path.join(dir, '需求树.md'), TREE);
  const preload = path.join(SANDBOX, 'as-darwin.js');
  fs.writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'darwin' });\n");
  const s = sid();
  const res = spawnSync(process.execPath, ['-r', preload, HOOK], { input: JSON.stringify({ cwd: dir, session_id: s, hook_event_name: 'UserPromptSubmit', prompt: '以后都要配图' }), encoding: 'utf8' });
  assert.strictEqual(res.stderr, '');
  const tree = path.join(dir, '需求树.md');
  const key = require('crypto').createHash('md5').update(tree.toLowerCase() + '|' + s).digest('hex');
  assert.ok(fs.existsSync(path.join(SANDBOX, 'reqtree', key + '.json')), '状态文件名没按小写路径算');
});

test('hook：项目经过符号链接 / 目录联接打开时，改的文件照样归到需求（两边都先解析成真实路径）', () => {
  const real = project();
  const link = path.join(SANDBOX, `link-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(real, 'DataScience', 'ch01-a.html'), '');
  // cwd 走链接、文件给真实路径；反过来也一样
  hook(link, edit(real, 'DataScience/ch01-a.html'));
  hook(real, edit(link, 'DataScience/ch01-a.html'));
  const acts = activity(real).filter(e => e.file === 'DataScience/ch01-a.html');
  assert.strictEqual(acts.length, 2, JSON.stringify(activity(real)));
  assert.ok(acts.every(e => e.node === 'C2.1'));
});

test('记录员：posix 上不经过 shell，命令按引号拆成参数', () => {
  const { splitCommand } = require('../hooks/recorder');
  assert.deepStrictEqual(splitCommand('claude -p --model haiku'), ['claude', '-p', '--model', 'haiku']);
  assert.deepStrictEqual(splitCommand(`"/opt/my node/node" '/a b/fake.js' x\\ y ""`), ['/opt/my node/node', '/a b/fake.js', 'x y', '']);
  assert.deepStrictEqual(splitCommand(`"a \\"q\\" b" 'it'\\''s'`), ['a "q" b', "it's"]);
});

test('记录员：模型超时时整棵进程树都被杀掉（Windows 上 claude.cmd 背后的 node 也是）', () => {
  const dir = project();
  const pidFile = path.join(dir, 'grandchild.pid');
  const jobFile = path.join(dir, 'job-hang.json');
  fs.writeFileSync(jobFile, JSON.stringify({ treePath: path.join(dir, '需求树.md'), touched: [], unmapped: [], turns: [{ user: '以后每章都加一道思考题', ai: '好' }] }));
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [RECORDER, jobFile], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, REQTREE_CLAUDE_CMD: `"${process.execPath}" "${FAKE}"`, FAKE_HANG: pidFile, REQTREE_CLAUDE_TIMEOUT_MS: '1500' },
  });
  assert.ok(!res.error, `记录员自己没在超时后退出：${res.error && res.error.message}`);
  assert.ok(Date.now() - t0 < 15000);
  const status = store.readRecorderStatus(path.join(dir, '需求树.md'));
  assert.strictEqual(status.ok, false);
  assert.match(status.message, /超时/);
  const pid = +fs.readFileSync(pidFile, 'utf8');
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const until = Date.now() + 5000;
  while (alive() && Date.now() < until) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},100)']);
  const still = alive();
  if (still) try { process.kill(pid); } catch {}
  assert.ok(!still, '孙进程还活着');
});

test('init：hook 命令的引号——posix 用单引号（$、反引号、单引号都不会被 shell 解释），Windows 用双引号', () => {
  const { hookCommand } = require('../bin/reqtree');
  assert.strictEqual(hookCommand("/home/o'neil/$x/hook.js", 'linux'), `node '/home/o'\\''neil/$x/hook.js'`);
  assert.strictEqual(hookCommand('/Users/a b/`x`/hook.js', 'darwin'), "node '/Users/a b/`x`/hook.js'");
  assert.strictEqual(hookCommand('C:\\Users\\a b\\hook.js', 'win32'), 'node "C:/Users/a b/hook.js"');
  // 有 sh 时真的跑一遍：路径里带 $ 和单引号的脚本能被执行
  if (spawnSync('sh', ['-c', 'exit 0']).status !== 0) return;
  const dir = path.join(SANDBOX, "it's $HOME `x`");
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'hook.js');
  fs.writeFileSync(script, "process.stdout.write('ran')");
  const r = spawnSync('sh', ['-c', hookCommand(script.split(path.sep).join('/'), 'linux')], { encoding: 'utf8' });
  assert.strictEqual(r.stdout, 'ran', r.stderr);
});

// ---------- 一键安装：hook 复制到固定位置 ~/.reqtree/runtime ----------

const RUNTIME = path.join(process.env.REQTREE_HOME, 'runtime');
const VERSION = require('../package.json').version;
const settingsOf = dir => JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8'));
const allCmds = s => Object.values(s.hooks || {}).flat().flatMap(g => g.hooks.map(h => h.command));

test('init：把 hooks/ 和 src/ 复制到 ~/.reqtree/runtime，hook 命令指向那里；从那里运行的 hook 能用', () => {
  const dir = project();
  const res = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'reqtree.js'), 'init', dir], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stderr);
  for (const f of ['hooks/hook.js', 'hooks/recorder.js', 'src/store.js', 'src/parser.js', 'src/compile.js']) assert.ok(fs.existsSync(path.join(RUNTIME, f)), f);
  assert.strictEqual(fs.readFileSync(path.join(RUNTIME, 'version'), 'utf8').trim(), VERSION);
  const { hookCommand } = require('../bin/reqtree');
  const expected = hookCommand(path.join(RUNTIME, 'hooks', 'hook.js'));
  const s = settingsOf(dir);
  for (const ev of ['UserPromptSubmit', 'Stop', 'PostToolUse', 'InstructionsLoaded', 'PreCompact']) assert.deepStrictEqual(s.hooks[ev].flatMap(g => g.hooks.map(h => h.command)), [expected], ev);
  // 从 runtime 运行 hook：发消息时把规则编译好
  fs.rmSync(path.join(dir, '.claude', 'rules'), { recursive: true, force: true });
  const r = spawnSync(process.execPath, [path.join(RUNTIME, 'hooks', 'hook.js')], { input: JSON.stringify({ cwd: dir, session_id: sid(), hook_event_name: 'UserPromptSubmit', prompt: 'x' }), encoding: 'utf8' });
  assert.strictEqual(r.stderr, '');
  assert.match(ruleFile(dir, 'C2.1'), /开场用霍乱/);
});

test('init：重复运行无副作用；把指向旧位置（Desktop\\reqtree、git clone 的 Vibecoding-Friend）的 hook 换掉，别的 hook 不动；runtime 里多余的旧文件删掉', () => {
  const dir = project();
  const settings = path.join(dir, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(settings));
  fs.writeFileSync(settings, JSON.stringify({ hooks: {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "C:/Users/me/Desktop/reqtree/hooks/hook.js"' }, { type: 'command', command: 'node "C:/tools/myhooks/hook.js"' }] }],
    Stop: [{ hooks: [{ type: 'command', command: "node '/home/me/Vibecoding-Friend/hooks/hook.js'", async: true }] }],
    PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'prettier' }] }],
  } }));
  fs.mkdirSync(path.join(RUNTIME, 'src'), { recursive: true });
  fs.writeFileSync(path.join(RUNTIME, 'src', 'gone-in-new-version.js'), '');
  const run = () => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'reqtree.js'), 'init', dir], { encoding: 'utf8' });
  assert.strictEqual(run().status, 0);
  const first = fs.readFileSync(settings, 'utf8');
  assert.strictEqual(run().status, 0);
  assert.strictEqual(fs.readFileSync(settings, 'utf8'), first, '第二次运行改了设置');
  const cmds = allCmds(JSON.parse(first));
  assert.ok(!cmds.some(c => /Desktop\/reqtree|Vibecoding-Friend/.test(c)), cmds.join('\n'));
  assert.ok(cmds.includes('node "C:/tools/myhooks/hook.js"'), '用户自己的 hook（名字也叫 hook.js）被删了');
  assert.ok(cmds.includes('prettier'));
  assert.strictEqual(cmds.filter(c => c.includes('.reqtree')).length, 5);
  assert.ok(!fs.existsSync(path.join(RUNTIME, 'src', 'gone-in-new-version.js')));
});

test('init：--tool 默认 claude；不认识的工具报错退出，不改项目', () => {
  const dir = project();
  const bin = path.join(ROOT, 'bin', 'reqtree.js');
  assert.strictEqual(spawnSync(process.execPath, [bin, 'init', dir, '--tool', 'claude']).status, 0);
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'settings.local.json')));
  const dir2 = project();
  const bad = spawnSync(process.execPath, [bin, 'init', '--tool=nope', dir2], { encoding: 'utf8' });
  assert.notStrictEqual(bad.status, 0);
  assert.match(bad.stderr, /nope/);
  assert.ok(!fs.existsSync(path.join(dir2, '.claude')));
  // 不给目录就用当前目录
  const dir3 = project();
  assert.strictEqual(spawnSync(process.execPath, [bin, 'init'], { cwd: dir3 }).status, 0);
  assert.ok(fs.existsSync(path.join(dir3, '.claude', 'settings.local.json')));
});

test('package.json：npx 能直接跑 init（bin 有 shebang、files 带上运行要的目录、没有依赖）', () => {
  const pkg = require('../package.json');
  assert.strictEqual(pkg.bin.reqtree, './bin/reqtree.js');
  assert.match(fs.readFileSync(path.join(ROOT, 'bin', 'reqtree.js'), 'utf8'), /^#!\/usr\/bin\/env node\r?\n/);
  for (const f of ['bin/', 'hooks/', 'src/']) assert.ok((pkg.files || []).includes(f), f);
  assert.ok(!pkg.dependencies || !Object.keys(pkg.dependencies).length);
});

// ---------- 插件：提示启用、升级时刷新 runtime ----------

function memento() { const m = new Map(); return { get: k => m.get(k), update: async (k, v) => { m.set(k, v); } }; }

function promptFake(dir, answer) {
  const fake = fakeVscode(dir);
  fake.asked = [];
  fake.commands = {};
  fake.vscode.window.showInformationMessage = async (m, ...buttons) => { fake.shown.push(m); if (buttons.length) { fake.asked.push({ m, buttons }); return answer; } };
  fake.vscode.commands.registerCommand = (id, fn) => { fake.commands[id] = fn; return { dispose() {} }; };
  return fake;
}

test('插件：项目没装 hook 时提示「在这个项目启用需求树？」，点启用就装好并提醒新开会话', async () => {
  const dir = project();
  const fake = promptFake(dir, '启用');
  const { api, dispose } = activateWith(fake, { workspaceState: memento() });
  try {
    await api.prompted;
    assert.deepStrictEqual(fake.asked.map(a => [a.m, a.buttons]), [['在这个项目启用需求树？', ['启用', '不再提示']]]);
    const cmds = allCmds(settingsOf(dir));
    assert.strictEqual(cmds.filter(c => c.includes('.reqtree') && c.includes('hook.js')).length, 5);
    assert.ok(fake.shown.some(m => /新开.*Claude Code 会话/.test(m)), fake.shown.join('\n'));
  } finally { dispose(); }
  // 装好以后再打开不再提示
  const again = promptFake(dir, '启用');
  const b = activateWith(again, { workspaceState: memento() });
  try { await b.api.prompted; assert.strictEqual(again.asked.length, 0); } finally { b.dispose(); }
});

test('插件：点「不再提示」后这个工作区不再问；点叉关掉下次还问', async () => {
  const dir = project();
  const state = memento();
  for (const [answer, expectAsk] of [[undefined, 1], ['不再提示', 1], ['启用', 0]]) {
    const fake = promptFake(dir, answer);
    const { api, dispose } = activateWith(fake, { workspaceState: state });
    try { await api.prompted; assert.strictEqual(fake.asked.length, expectAsk, String(answer)); } finally { dispose(); }
  }
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'settings.local.json')), '没点启用却装了');
});

test('插件：.claude/settings.json 里已经有需求树的 hook（哪怕指向旧位置，只要脚本还在）就不提示；「需求树：在本项目启用」命令随时可用', async () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, '.claude'));
  // 旧位置（git clone 的仓库）的脚本还在：算装过。脚本已经不在的情况见 review.test.js 的 hasHooks
  const old = path.join(SANDBOX, 'Desktop', 'reqtree', 'hooks', 'hook.js');
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(old, '');
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `node "${old.replace(/\\/g, '/')}"` }] }] } }));
  const fake = promptFake(dir);
  const { api, dispose } = activateWith(fake, { workspaceState: memento() });
  try {
    await api.prompted;
    assert.strictEqual(fake.asked.length, 0);
    assert.ok(fake.commands['reqtree.enable'], '没注册启用命令');
    await fake.commands['reqtree.enable']();
    assert.strictEqual(allCmds(settingsOf(dir)).filter(c => c.includes('.reqtree')).length, 5);
    const pkg = require('../package.json');
    // 命令标题写在 package.nls*.json 里（中文界面看 zh-cn 那份）
    const nlsZh = require('../package.nls.zh-cn.json');
    const cmd = pkg.contributes.commands.find(c => c.command === 'reqtree.enable');
    assert.ok(cmd && /^%(.+)%$/.test(cmd.title) && nlsZh[cmd.title.slice(1, -1)] === '需求树：在本项目启用');
  } finally { dispose(); }
});

test('插件：~/.reqtree/runtime 比插件旧时悄悄刷新；没有 runtime（从没启用过）时不创建；比插件新时不动', async () => {
  fs.rmSync(RUNTIME, { recursive: true, force: true });
  const dir = project();
  let a = activateWith(promptFake(dir), {});
  await a.api.prompted; a.dispose();
  assert.ok(!fs.existsSync(RUNTIME), '没启用过也建了 runtime');
  fs.mkdirSync(path.join(RUNTIME, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(RUNTIME, 'version'), '0.0.1\n');
  fs.writeFileSync(path.join(RUNTIME, 'hooks', 'hook.js'), '// old');
  a = activateWith(promptFake(dir), {});
  await a.api.prompted; a.dispose();
  assert.strictEqual(fs.readFileSync(path.join(RUNTIME, 'version'), 'utf8').trim(), VERSION);
  assert.strictEqual(fs.readFileSync(path.join(RUNTIME, 'hooks', 'hook.js'), 'utf8'), fs.readFileSync(HOOK, 'utf8'));
  fs.writeFileSync(path.join(RUNTIME, 'version'), '99.0.0\n');
  fs.writeFileSync(path.join(RUNTIME, 'hooks', 'hook.js'), '// newer');
  a = activateWith(promptFake(dir), {});
  await a.api.prompted; a.dispose();
  assert.strictEqual(fs.readFileSync(path.join(RUNTIME, 'hooks', 'hook.js'), 'utf8'), '// newer');
  fs.rmSync(RUNTIME, { recursive: true, force: true });
});

// ---------- 插件：新建需求时猜对应文件 ----------

test('插件：新建子需求时按名字猜文件，QuickPick 选「用 …」就写上；选「先不设」不写；猜不到不打扰', async () => {
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  fs.writeFileSync(path.join(dir, 'DataScience', 'ch03-regression.html'), '');
  const fake = fakeVscode(dir, { input: '第3章 回归' });
  const picks = [];
  let choose = items => items[0];
  fake.vscode.window.showQuickPick = async items => { picks.push(items.map(i => i.label)); return choose(items); };
  const { panel, dispose } = activateWith(fake);
  try {
    const uri = panel.trees[0].uri;
    const child = title => P.findById(P.parse(fs.readFileSync(tree, 'utf8')), 'C2').children.find(n => n.title === title);
    await panel.handle({ type: 'edit', uri, action: 'addChild', node: 'C2' });
    assert.deepStrictEqual(picks[0], ['用 DataScience/ch03-*.html', '自己选文件夹…', '先不设']);
    assert.deepStrictEqual(child('第3章 回归').files, ['DataScience/ch03-*.html']);
    choose = items => items.find(i => i.label === '先不设');
    fake.vscode.window.showInputBox = async () => '第3章 习题';
    await panel.handle({ type: 'edit', uri, action: 'addChild', node: 'C2' });
    assert.deepStrictEqual(child('第3章 习题').files, []);
    // 猜不到：不弹
    const before = picks.length;
    fake.vscode.window.showInputBox = async () => '术语表';
    await panel.handle({ type: 'edit', uri, action: 'addChild', node: 'C2' });
    assert.strictEqual(picks.length, before);
    assert.ok(child('术语表'));
  } finally { dispose(); }
});

// ---------- 上下文用量表：InstructionsLoaded hook 记下每个会话加载了哪些规则文件 ----------

const loaded = (dir, file, extra = {}) => ({ hook_event_name: 'InstructionsLoaded', file_path: file, memory_type: 'Project', load_reason: 'session_start', ...extra });
const contextLog = dir => store.readContext(path.join(dir, '需求树.md'), 3600000);

test('hook：InstructionsLoaded 记下加载的文件、字数（按字符不按字节）、原因、子 agent、触发文件', () => {
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  store.compileTree(tree, { force: true });
  const claudeMd = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(claudeMd, '# 规则\n- 段落短😀\n');
  const user = path.join(SANDBOX, 'user-home', '.claude', 'CLAUDE.md');
  fs.mkdirSync(path.dirname(user), { recursive: true });
  fs.writeFileSync(user, 'abc');
  const s = sid();
  const rule = path.join(dir, '.claude', 'rules', 'reqtree', 'C2.1.md');
  const index = path.join(dir, '.claude', 'rules', 'reqtree', '_index.md');
  assert.ok(fs.existsSync(rule) && fs.existsSync(index));
  hook(dir, loaded(dir, claudeMd, { session_id: s }));
  hook(dir, loaded(dir, index, { session_id: s }));
  hook(dir, loaded(dir, user, { session_id: s, memory_type: 'User' }));
  hook(dir, loaded(dir, rule, { session_id: s, load_reason: 'path_glob_match', globs: ['DataScience/ch01-*.html'], trigger_file_path: path.join(dir, 'DataScience', 'ch01-a.html'), agent_id: 'agent-1' }));
  hook(dir, loaded(dir, path.join(dir, 'gone', 'CLAUDE.md'), { session_id: s, load_reason: 'nested_traversal' }));
  const log = contextLog(dir).filter(e => e.session === s);
  assert.strictEqual(log.length, 5, JSON.stringify(log));
  const by = f => log.find(e => e.file === f);
  const md = by('CLAUDE.md');
  assert.strictEqual(md.chars, [...'# 规则\n- 段落短😀\n'].length, '字数要按字符算（emoji 算 1 个）');
  assert.notStrictEqual(md.chars, Buffer.byteLength('# 规则\n- 段落短😀\n'));
  assert.deepStrictEqual([md.source, md.reason, md.memory, md.agent, md.node], ['claude-md', 'session_start', 'Project', null, null]);
  assert.deepStrictEqual([by('.claude/rules/reqtree/_index.md').source, by('.claude/rules/reqtree/_index.md').node], ['reqtree', null]);
  const r = by('.claude/rules/reqtree/C2.1.md');
  assert.deepStrictEqual([r.source, r.node, r.reason, r.agent, r.trigger], ['reqtree', 'C2.1', 'path_glob_match', 'agent-1', 'DataScience/ch01-a.html']);
  assert.strictEqual(r.chars, [...fs.readFileSync(rule, 'utf8')].length);
  // 项目外的文件：记绝对路径（正斜杠），来源按文件名分
  const u = log.find(e => e.memory === 'User');
  assert.strictEqual(u.file, user.split(path.sep).join('/'));
  assert.deepStrictEqual([u.source, u.chars], ['claude-md', 3]);
  // 读不到的文件：字数记 null，不报错
  assert.strictEqual(by('gone/CLAUDE.md').chars, null);
  assert.ok(log.every(e => typeof e.time === 'number'));
});

test('hook：没有需求树的项目里 InstructionsLoaded 什么都不记', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqtree-test-'));
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'x');
  hook(dir, loaded(dir, path.join(dir, 'CLAUDE.md')));
  assert.ok(!fs.existsSync(path.join(dir, '.reqtree')));
});

test('init：InstructionsLoaded hook 注册成后台运行，重复 init 不重复', () => {
  const dir = project();
  const bin = path.join(ROOT, 'bin', 'reqtree.js');
  spawnSync(process.execPath, [bin, 'init', dir]);
  spawnSync(process.execPath, [bin, 'init', dir]);
  const groups = settingsOf(dir).hooks.InstructionsLoaded;
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].hooks.length, 1);
  assert.strictEqual(groups[0].hooks[0].async, true);
  assert.match(groups[0].hooks[0].command, /\.reqtree.*hooks.*hook\.js/);
  assert.ok(!('matcher' in groups[0]), '所有加载原因都要记');
});

test('context.jsonl 太长时每轮结束裁到最近 2000 行', () => {
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  const line = JSON.stringify({ session: 'old', agent: null, file: 'CLAUDE.md', chars: 1, reason: 'session_start', time: Date.now() }) + '\n';
  fs.mkdirSync(store.metaFile(tree, ''), { recursive: true });
  fs.writeFileSync(store.metaFile(tree, 'context.jsonl'), line.repeat(Math.ceil(600 * 1024 / line.length)));
  hook(dir, { hook_event_name: 'Stop', session_id: sid(), last_assistant_message: 'ok' }, { REQTREE_CLAUDE_CMD: `"${process.execPath}" "${FAKE}"` });
  const lines = fs.readFileSync(store.metaFile(tree, 'context.jsonl'), 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 2000);
  assert.strictEqual(store.readContext(tree, 3600000).length, 2000, '裁过以后还能读');
});

test('viewmodel：context 按会话汇总——最近 24 小时、最多 5 个、新的在前；同一文件只算一次；常驻 / 按需分开算', () => {
  const { viewData } = require('../src/viewmodel');
  const now = Date.now();
  const e = (session, file, chars, reason, extra = {}) => ({ session, agent: null, file, chars, reason, memory: 'Project', source: extra.source || (file.includes('reqtree/') ? 'reqtree' : 'claude-md'), node: null, time: now - 1000, ...extra });
  const context = [
    e('S1', 'CLAUDE.md', 1000, 'session_start', { time: now - 60000 }),
    e('S1', '.claude/rules/reqtree/_index.md', 200, 'session_start', { time: now - 60000 }),
    e('S1', '.claude/rules/reqtree/C2.md', 300, 'path_glob_match', { node: 'C2', trigger: 'DataScience/a.html', time: now - 50000 }),
    // 压缩后重新加载、子 agent 再加载：同一个文件只算一次，记下加载次数和几个 agent 用过
    e('S1', 'CLAUDE.md', 1000, 'compact', { time: now - 40000 }),
    e('S1', 'CLAUDE.md', 1000, 'session_start', { agent: 'sub-1', time: now - 30000 }),
    e('S1', '.claude/rules/reqtree/C2.1.md', 150, 'path_glob_match', { node: 'C2.1', agent: 'sub-1', time: now - 20000 }),
    // 文件改过：字数取最后一次
    e('S1', '.claude/rules/reqtree/C2.md', 320, 'path_glob_match', { node: 'C2', time: now - 10000 }),
    e('S1', 'gone/CLAUDE.md', null, 'nested_traversal', { time: now - 9000 }),
    e('OLD', 'CLAUDE.md', 1000, 'session_start', { time: now - 25 * 3600000 }),
    ...[2, 3, 4, 5, 6].map(i => e(`S${i}`, 'CLAUDE.md', 1000, 'session_start', { time: now - i * 3600000 })),
  ];
  const tree = { uri: 'file:///t.md', name: 't.md', text: TREE, context };
  const [f] = viewData([tree], now).files;
  assert.deepStrictEqual(f.context.map(s => s.session), ['S1', 'S2', 'S3', 'S4', 'S5']);
  const s1 = f.context[0];
  assert.deepStrictEqual({ total: s1.total, resident: s1.resident, demand: s1.demand, agents: s1.agents, start: s1.start, end: s1.end },
    { total: 1000 + 200 + 320 + 150, resident: 1200, demand: 470, agents: 2, start: now - 60000, end: now - 9000 });
  // 常驻在前，同类按字数从多到少
  assert.deepStrictEqual(s1.files.map(x => [x.file, x.chars, x.kind]), [
    ['CLAUDE.md', 1000, 'resident'], ['.claude/rules/reqtree/_index.md', 200, 'resident'],
    ['.claude/rules/reqtree/C2.md', 320, 'demand'], ['.claude/rules/reqtree/C2.1.md', 150, 'demand'], ['gone/CLAUDE.md', null, 'demand'],
  ]);
  const md = s1.files[0];
  assert.deepStrictEqual({ loads: md.loads, agents: md.agents, source: md.source, reason: md.reason }, { loads: 3, agents: 2, source: 'claude-md', reason: 'session_start' });
  const c2 = s1.files[2];
  assert.deepStrictEqual({ node: c2.node, trigger: c2.trigger, loads: c2.loads }, { node: 'C2', trigger: 'DataScience/a.html', loads: 2 });
  // reqtree 自己的规则单独合计，方便和 CLAUDE.md 对比
  assert.strictEqual(s1.reqtree, 200 + 320 + 150);
  // 没有记录时是空数组
  assert.deepStrictEqual(viewData([{ ...tree, context: undefined }], now).files[0].context, []);
});

test('插件：面板里直接改名带着 title，不弹输入框；空名字不改', async () => {
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  const fake = fakeVscode(dir);
  let asked = 0;
  fake.vscode.window.showInputBox = async () => { asked++; return '不该用到'; };
  const { panel, dispose } = activateWith(fake);
  try {
    const uri = panel.trees[0].uri;
    await panel.handle({ type: 'edit', uri, action: 'rename', node: 'C2.1', title: '  霍乱开场  ' });
    assert.match(fs.readFileSync(tree, 'utf8'), /^### C2\.1 霍乱开场 ⏳$/m);
    assert.match(store.readChanges(tree)[0].summary[0], /霍乱开场/, '改名记进改动记录，能撤销');
    await panel.handle({ type: 'edit', uri, action: 'rename', node: 'C2.1', title: '   ' });
    assert.match(fs.readFileSync(tree, 'utf8'), /^### C2\.1 霍乱开场 ⏳$/m, '空名字不该改');
    assert.strictEqual(asked, 0, '带了 title 就不弹输入框');
    // 没带 title（旧的入口）还是弹输入框
    await panel.handle({ type: 'edit', uri, action: 'rename', node: 'C2.1' });
    assert.strictEqual(asked, 1);
  } finally { dispose(); }
});

test('插件：界面语言——设置 reqtree.language 优先；auto 时 VS Code 中文就中文，英文界面看需求树写的什么语言；网页拿到 data-lang', async () => {
  const dir = project();
  const enDir = project();
  fs.writeFileSync(path.join(enDir, '需求树.md'), '# P Project\n- Keep paragraphs short\n\n## C2 Data course\n> 文件：ds/**\n\n### C2.1 Chapter one ⏳\n');
  for (const [setting, display, want, d] of [['auto', 'en', 'zh', dir], ['auto', 'en', 'en', enDir], ['auto', 'zh-cn', 'zh', dir], ['zh', 'en', 'zh', enDir], ['en', 'zh-cn', 'en', dir]]) {
    const fake = fakeVscode(d);
    fake.vscode.env = { language: display };
    fake.vscode.workspace.getConfiguration = () => ({ get: (k, d) => (k === 'language' ? setting : d) });
    const { panel, dispose } = activateWith(fake);
    try {
      const uri = panel.trees[0].uri;
      await panel.handle({ type: 'edit', uri, action: 'setStatus', node: 'C2.1', status: 'todo' }); // 本来就是待做：没有改动
      const msg = fake.shown.pop();
      assert.match(msg, want === 'en' ? /^RuleTree: nothing changed \(the status didn't change\)$/ : /^需求树：没有改动（状态没变）$/, `${setting}/${display}/${d === dir ? '中文树' : '英文树'}`);
      const webview = { options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: u => u, onDidReceiveMessage() {}, postMessage() {} };
      panel.resolveWebviewView({ webview, onDidChangeVisibility() {}, visible: true });
      assert.match(webview.html, new RegExp(`<body data-lang="${want}">`));
      assert.match(webview.html, /strings\.js/);
    } finally { dispose(); }
  }
});

test('界面语言：记录员状态、锁的错误、升级清理都带结构化文字（键都在文字表里），旧的中文 message 照样保留', () => {
  const S = require('../media/strings');
  const { describe, describeParts } = require('../hooks/recorder');
  const applied = [{ op: 'add_rule', node: 'C2' }, { op: 'replace_rule', node: 'C2' }, { op: 'set_status', node: 'C2.1', status: 'done' }, { op: 'set_status', node: 'C2.2', status: 'doing' }];
  assert.strictEqual(describe(applied, 1), '记下 2 条；C2.1 标为完成；C2.2 标为进行中；1 条改动等你保存需求树后写入', '中文说明不变');
  const parts = describeParts(applied, 1);
  assert.deepStrictEqual(parts.map(p => p.k), ['rec.rules', 'rec.done', 'rec.doing', 'rec.queued']);
  for (const p of parts) assert.ok(p.k in S.zh && p.k in S.en, p.k);
  // 用文字表拼出来，中文和 describe 一样
  const zh = S.make('zh');
  assert.strictEqual(parts.map(p => (p.k === 'rec.done' || p.k === 'rec.doing') ? zh(p.k, p.a[0].join(zh('rec.join')) + ' ') : zh(p.k, ...p.a)).join(zh('rec.sep')), describe(applied, 1)); // 面板里写编号时后面补一个空格
  assert.deepStrictEqual(describeParts([], 0), [{ k: 'rec.none', a: [] }]);
  // 锁：拿不到时错误带 t
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  const lock = path.join(dir, '.reqtree', 'tree.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, 'x');
  let err;
  try { store.updateTree(tree, t => t + '\n', { waitMs: 50 }); } catch (e) { err = e; }
  fs.unlinkSync(lock);
  assert.ok(err, '锁被占着时应该报错');
  {
    assert.strictEqual(err.code, 'REQTREE_BUSY');
    assert.deepStrictEqual(err.t && err.t.k, 'err.busy');
    assert.ok(err.t.k in S.en);
    assert.match(err.message, /需求树被占用/, '命令行和旧版本看的中文 message 还在');
  }
});

test('插件：需求树有没保存的改动时不体检，先请你保存（体检会直接改记忆和文档，树没保存两边对不上）', async () => {
  const dir = project();
  const tree = path.join(dir, '需求树.md');
  const fake = fakeVscode(dir);
  fake.docs.push({ uri: fake.vscode.Uri.file(tree), text: TREE + '- 没保存的\n', isDirty: true, getText() { return this.text; }, get lineCount() { return 1; } });
  const { panel, dispose } = activateWith(fake);
  try {
    const r = await panel.runCheck(tree, { rules: true, memory: false, docs: false }, false, false);
    assert.strictEqual(r, undefined);
    assert.match(fake.shown.pop(), /先保存/);
    assert.ok(!fs.existsSync(path.join(dir, '.reqtree', 'checkup-report.md')));
  } finally { dispose(); }
});
