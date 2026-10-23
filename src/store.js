'use strict';
// 需求树文件的存取：找树文件、加锁原子写、编辑中排队、程序状态（记录员、编译、需求最后改动时间）。
// hook、记录员、命令行、插件都只通过这里写树，避免互相覆盖。
//
// .reqtree/ 里的文件
//   长期保存
//     config.json     用户开关（面板 ⚙）：{ recorder: 'turn' 每轮记录 | 'off' 暂停, sweepEvery 补漏间隔（轮） }
//     state.json      程序状态：{ recorder 记录员上次结果, compile 上次编译结果, since 开始跟踪的时间, touched {需求ID: 最后被 AI 改的时间},
//                     legacyCleaned 升级时清掉旧版本 🆕 🗑 标记的时间（有了就再也不清） }
//     activity.jsonl  AI 改了哪些文件（只追加）
//     context.jsonl   每个会话加载了哪些规则文件、各多少字（只追加，给上下文用量表）
//     changes.jsonl   改动记录，每条带反操作，可以撤销（只追加）
//     questions.jsonl 拿不准、要问用户的事（只追加；回答、关掉也追加一行，见 src/questions.js）
//   临时（用完即删，进程崩溃留下的也会按时间判定失效）
//     tree.lock   写树的锁         state.lock  读改写 state.json / config.json 的锁
//     queue.lock  读改写队列的锁   queue.json  用户编辑中时记录员的改动排队
//     editing     用户有未保存改动的标记       *.tmp  原子写的中间文件
const fs = require('fs');
const path = require('path');
const { applyOps, legacyCleanupOps, parse, findById, STATUS_LABEL } = require('./parser');
const { compile, ensureCompiled } = require('./compile');

// 只认项目根目录：优先 需求树.md，其次第一个 *.tree.md
function findTree(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  const name = names.find(n => n === '需求树.md') || names.filter(n => n.endsWith('.tree.md')).sort()[0];
  return name ? path.join(dir, name) : null;
}

// Windows 和 macOS 的文件系统默认不分大小写：C:\ 和 c:\、/Users/A 和 /users/a 是同一个文件。Linux 区分
const caseInsensitive = () => process.platform === 'win32' || process.platform === 'darwin';
// 比较或当键用的路径：不分大小写的系统统一成小写
const pathKey = p => (caseInsensitive() ? p.toLowerCase() : p);
const samePath = (a, b) => pathKey(a) === pathKey(b);

// 新建需求树时的模板（命令行 init 和插件共用）
const TEMPLATE = `# P 项目名
- [语气] 全项目通用的规则写在这里，子节点用同一个键可以覆盖

## R1 第一个需求 🔨
> 文件：src/**
- 只管这个需求的规则

### R1.1 子需求 ⏳
- 子需求自己的规则
`;

const metaDir = treePath => path.join(path.dirname(treePath), '.reqtree');
const metaFile = (treePath, name) => path.join(metaDir(treePath), name);

// 先写临时文件再改名：别的进程读到的要么是旧的、要么是完整的新内容
function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
const writeJson = (file, value) => atomicWrite(file, JSON.stringify(value, null, 2));

// 只读文件末尾 bytes 字节（日志再长也快）；从中间截断时丢掉第一行残缺的内容
function readTail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start ? text.slice(text.indexOf('\n') + 1) : text;
  } finally { fs.closeSync(fd); }
}

// ---------- 锁 ----------
// 锁文件用 'wx' 独占创建。hook、记录员、命令行是短命的独立进程，同步等锁没问题；
// 插件宿主里同步等会卡住整个 VS Code 的插件，所以插件写树走 updateTreeAsync：每次只试一下（waitMs 0），拿不到就异步等一会再试。
// state.lock 只在读写一个小 JSON 的一瞬间被占着，插件同步等也只是几毫秒。
// 加锁顺序固定为 tree.lock → state.lock（编译在写树的锁里记编译结果），反过来的嵌套不存在，不会死锁。
// 进程被杀时锁会留下来，超过 staleMs 没动就当它失效删掉。state.lock 的失效时间必须比等待时间短，
// 不然留下的锁在失效前会让每次写状态都等满再报「被占用」；写树要编译、可能慢，tree.lock 放宽些。
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const LOCK_STALE_MS = 10 * 1000;
const LOCK_WAIT_MS = 5000;
const STATE_STALE_MS = 1500;
const STATE_WAIT_MS = 3000;

function withLock(lock, fn, waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS) {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  let fd = null;
  for (const until = Date.now() + waitMs; fd === null;) {
    try { fd = fs.openSync(lock, 'wx'); }
    catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) fs.unlinkSync(lock); } catch {}
      if (Date.now() >= until) break;
      sleep(20);
    }
  }
  if (fd === null) {
    const e = new Error(`需求树被占用，${Math.round(waitMs / 1000)} 秒内没拿到锁`);
    e.code = 'REQTREE_BUSY';
    e.t = { k: 'err.busy', a: [Math.round(waitMs / 1000)] }; // 给界面按语言显示（strings.js），message 留给命令行和旧版本
    throw e;
  }
  try { return fn(); }
  finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(lock); } catch {}
  }
}
const treeLock = treePath => metaFile(treePath, 'tree.lock');
const stateLock = treePath => metaFile(treePath, 'state.lock');

// ---------- 用户开关：config.json ----------
// 开关 recorder，补漏间隔 sweepEvery（每 N 轮把最近 N 句用户原话再交给记录员查一遍漏记，0 关掉）。只认 DEFAULT_CONFIG 里有的键：旧版本的 confirm（「先让我确认」，已去掉）、
// since（已搬到 state.json）读的时候忽略，迁移时删掉；面板传来别的键也不写。
// aiFindings：AI 在回复里说出的、以后还用得上的做法和坑也记成规则（开头标「（AI 发现）」），默认开
const DEFAULT_CONFIG = { recorder: 'turn', sweepEvery: 8, aiFindings: true };
const pickConfig = c => Object.fromEntries(Object.keys(DEFAULT_CONFIG).map(k => [k, c[k] === undefined ? DEFAULT_CONFIG[k] : c[k]]));
const rawConfig = treePath => readJson(metaFile(treePath, 'config.json'), null);
const readConfig = treePath => pickConfig(rawConfig(treePath) || {});
function writeConfig(treePath, patch) {
  return withLock(stateLock(treePath), () => {
    migrateUnlocked(treePath); // 先把旧 config 里的 since 搬走，再按新格式重写
    const next = pickConfig({ ...readConfig(treePath), ...patch });
    writeJson(metaFile(treePath, 'config.json'), next);
    return next;
  }, STATE_WAIT_MS, STATE_STALE_MS);
}

// ---------- 程序状态：state.json ----------
// 多个 hook 进程（后台的记录员、PostToolUse、插件）会同时写，读改写都在 state.lock 里做
const STATE_FILE = 'state.json';
const DEFAULT_STATE = { recorder: null, compile: null, since: null, touched: {} };
// 旧版本拆开存的文件 → state 里的字段
const LEGACY_FILES = { recorder: 'recorder.json', compile: 'compile.json', touched: 'touched.json' };

function hasLegacy(treePath) {
  if (Object.values(LEGACY_FILES).some(f => fs.existsSync(metaFile(treePath, f)))) return true;
  const raw = rawConfig(treePath);
  return !!raw && Object.keys(raw).some(k => !(k in DEFAULT_CONFIG));
}

// 只读：state.json 加上旧文件里还没迁移的内容（迁移要写文件，留给第一次写 state 时做，
// 这样 check 这类只读命令没有副作用）。state.json 里有的以它为准，touched 两边合并
function readState(treePath) {
  const old = {};
  for (const [k, f] of Object.entries(LEGACY_FILES)) {
    const v = readJson(metaFile(treePath, f), null);
    if (v != null) old[k] = v;
  }
  const raw = rawConfig(treePath);
  if (raw && raw.since) old.since = raw.since;
  const cur = readJson(metaFile(treePath, STATE_FILE), null) || {};
  const set = Object.fromEntries(Object.entries(cur).filter(([, v]) => v != null));
  return { ...DEFAULT_STATE, ...old, ...set, touched: { ...(old.touched || {}), ...(cur.touched || {}) } };
}

// 内容没变不写：插件监视 .reqtree/*.json，每写一次就刷新一次
function writeStateUnlocked(treePath, state) {
  const file = metaFile(treePath, STATE_FILE);
  const text = JSON.stringify(state, null, 2);
  let old = null;
  try { old = fs.readFileSync(file, 'utf8'); } catch {}
  if (old !== text) atomicWrite(file, text);
}

// 旧文件读一次并进 state.json，再删掉；config.json 只留用户开关
function migrateUnlocked(treePath) {
  if (!hasLegacy(treePath)) return;
  writeStateUnlocked(treePath, readState(treePath));
  for (const f of Object.values(LEGACY_FILES)) try { fs.unlinkSync(metaFile(treePath, f)); } catch {}
  const raw = rawConfig(treePath);
  if (raw) writeJson(metaFile(treePath, 'config.json'), pickConfig(raw));
}

// 加锁读-改-写 state。fn(state) 返回新的 state
function updateState(treePath, fn) {
  return withLock(stateLock(treePath), () => {
    migrateUnlocked(treePath);
    const next = fn(readState(treePath));
    writeStateUnlocked(treePath, next);
    return next;
  }, STATE_WAIT_MS, STATE_STALE_MS);
}

// 读状态，没记过开始跟踪的时间就记下现在：判断 🔨 久未动时，没被跟踪过的需求从这一刻算起，免得刚装好就满屏误报。
// 顺便完成旧文件的迁移。只给 init 和插件用；check 这类只读命令用 readState，不能有副作用
function ensureTracking(treePath) {
  const s = readState(treePath);
  if (s.since && !hasLegacy(treePath)) return s;
  return updateState(treePath, st => (st.since ? st : { ...st, since: Date.now() }));
}

// 记录员最近一次运行的结果，给面板显示：{ ok, time, message, asked }
const writeRecorderStatus = (treePath, status) => updateState(treePath, s => ({ ...s, recorder: { ...status, time: Date.now() } }));
const readRecorderStatus = treePath => readState(treePath).recorder || null;
const readCompileStatus = treePath => readState(treePath).compile || null;

// 每个需求最后一次被 AI 改动的时间，用来提示"🔨 很久没动了"
function touch(treePath, ids) {
  const now = Date.now();
  updateState(treePath, s => ({ ...s, touched: { ...s.touched, ...Object.fromEntries(ids.map(id => [id, now])) } }));
}
const readTouched = treePath => readState(treePath).touched || {};

// ---------- 编译 ----------
// 编译必须和写树在同一把锁里：不然两个写入方各自编译时，拿旧内容的那个可能后写，
// 盖掉新规则、删掉新节点的 .md，而时间戳已经刷新，之后也不会再重编。
// 结果记进 state.json 的 compile（{ ok, message, time }），面板据此提示「规则没有生成」。
// t：结构化的错误（{ k: 文字表的键, a: 参数 }），界面按当前语言显示；没有就显示 message
function setCompileStatus(treePath, ok, message, t = null) {
  const prev = readState(treePath).compile;
  // 成功时只在之前没记过或失败过才写；同样的错误不重写：插件监视 .reqtree/*.json，每写一次就刷新、刷新又会重试编译，会转圈
  if (prev && (ok ? prev.ok : !prev.ok && prev.message === message)) return;
  // 不开面板的人看不到 state.json：新的失败也写进 hook.log（hook 在下一句用户的话时还会告诉 AI 一次）
  if (!ok) require('./common').appendTmpLog('hook.log', JSON.stringify({ t: new Date().toISOString(), ev: 'compile', tree: treePath, compileError: `编译失败：${message}` }));
  // 编译结果只是给面板看的提示，记不下来不能影响写树
  try { updateState(treePath, s => ({ ...s, compile: { ok, message, ...(t ? { t } : {}), time: Date.now() } })); } catch {}
}

function compileUnlocked(treePath, force) {
  try {
    const r = force ? compile(treePath) : ensureCompiled(treePath);
    setCompileStatus(treePath, true, '');
    return r;
  } catch (e) {
    setCompileStatus(treePath, false, e.message, e.t || null);
    return null;
  }
}

// ---------- 升级：一次性清掉旧版本「先让我确认」模式留下的 🆕 🗑 标记 ----------
// 只在 state.json 还没有 legacyCleaned 时做一次，之后 🆕 🗑 就是普通文字（用户可以写「🗑 删除按钮用红色」这样的规则）。
// 在写树的锁里、编译之前做，这样编译出的规则已经是清理后的。清理记成一条改动，面板上可以撤销。
// 用户正在编辑需求树时先不做：磁盘上清了，用户一保存又被编辑器里的旧内容盖回去。返回树有没有被改
function cleanupLegacyUnlocked(treePath) {
  if (readState(treePath).legacyCleaned || isEditing(treePath)) return false;
  const before = fs.readFileSync(treePath, 'utf8');
  const { text, applied } = applyOps(before, legacyCleanupOps(before));
  if (text !== before) atomicWrite(treePath, text);
  if (applied.length) logChange(treePath, { id: newChangeId(), time: Date.now(), source: '升级', summary: [`清掉旧版本留下的待确认标记（${applied.length} 处）`], event: { k: 'chg.legacy', a: [applied.length] }, ops: applied });
  // 标记记不下来也没关系：下次再跑一遍，清理过的树里已经没有可清的东西
  try { updateState(treePath, s => ({ ...s, legacyCleaned: Date.now() })); } catch {}
  return text !== before;
}

// 加锁编译。wait=false 时拿不到锁就跳过：拿着锁的一方正在写树，它释放前会编译
function compileTree(treePath, { force = false, wait = true } = {}) {
  try {
    return withLock(treeLock(treePath), () => {
      const cleaned = cleanupLegacyUnlocked(treePath);
      return compileUnlocked(treePath, force || cleaned);
    }, wait ? LOCK_WAIT_MS : 0);
  } catch (e) { if (e.code === 'REQTREE_BUSY' && !wait) return null; throw e; }
}

// 加锁读-改-写。fn(text) 返回新文本；返回值相同就不写。谁写了树，谁就在锁里顺手重新编译成原生规则
function updateTree(treePath, fn, { waitMs = LOCK_WAIT_MS } = {}) {
  return withLock(treeLock(treePath), () => {
    const cleaned = cleanupLegacyUnlocked(treePath);
    const before = fs.readFileSync(treePath, 'utf8');
    const after = fn(before);
    if (after !== before) atomicWrite(treePath, after);
    compileUnlocked(treePath, cleaned || after !== before);
    return after;
  }, waitMs);
}

// 插件用：不在宿主线程里同步等锁
async function updateTreeAsync(treePath, fn) {
  for (const until = Date.now() + LOCK_WAIT_MS; ;) {
    try { return updateTree(treePath, fn, { waitMs: 0 }); }
    catch (e) {
      if (e.code !== 'REQTREE_BUSY' || Date.now() >= until) throw e;
      await new Promise(r => setTimeout(r, 30));
    }
  }
}

// ---------- 只追加的日志：多个 hook 同时写也不会互相覆盖 ----------
// activity.jsonl  AI 改了哪些文件，每行 { node, file, time, session, agent }；node 为 null 表示这个文件还没归属任何需求
// context.jsonl   Claude Code 往上下文里加载了哪些规则文件（InstructionsLoaded hook），
//                 每行 { session, agent, file, chars, reason, memory, source, node, trigger, parent, time }
function appendLog(treePath, name, entry) {
  fs.mkdirSync(metaDir(treePath), { recursive: true });
  fs.appendFileSync(metaFile(treePath, name), JSON.stringify(entry) + '\n');
}

// 读最近 sinceMs 毫秒内的记录（只读文件末尾一段，日志再长也快）
function readLog(treePath, name, sinceMs, tailBytes = 256 * 1024) {
  let text;
  try { text = readTail(metaFile(treePath, name), tailBytes); } catch { return []; }
  const cutoff = Date.now() - sinceMs;
  return text.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(e => e && e.time >= cutoff);
}

// 日志太长就只留最近 2000 行（每轮结束时调用一次）
function trimLog(treePath, name) {
  const f = metaFile(treePath, name);
  try {
    if (fs.statSync(f).size < 512 * 1024) return;
    atomicWrite(f, fs.readFileSync(f, 'utf8').trim().split('\n').slice(-2000).join('\n') + '\n');
  } catch {}
}

// AI 写了这个项目的自动记忆（PostToolUse 记，Stop 时交给记录员看是不是该收进树）：{ dir, file, time, session }
const appendMemoryWrite = (treePath, entry) => appendLog(treePath, 'memory-writes.jsonl', entry);
const readMemoryWrites = (treePath, sinceMs) => readLog(treePath, 'memory-writes.jsonl', sinceMs);
const trimMemoryWrites = treePath => trimLog(treePath, 'memory-writes.jsonl');
const appendActivity = (treePath, entry) => appendLog(treePath, 'activity.jsonl', entry);
const readActivity = (treePath, sinceMs) => readLog(treePath, 'activity.jsonl', sinceMs);
const trimActivity = treePath => trimLog(treePath, 'activity.jsonl');
const appendContext = (treePath, entry) => appendLog(treePath, 'context.jsonl', entry);
// 一个会话开头一次加载几十个文件，多读一些
const readContext = (treePath, sinceMs) => readLog(treePath, 'context.jsonl', sinceMs, 512 * 1024);
const trimContext = treePath => trimLog(treePath, 'context.jsonl');

// 插件在用户有未保存改动时写这个标记；记录员看到就排队，不去碰文件
const EDITING_STALE_MS = 30 * 60 * 1000;
function isEditing(treePath) {
  try { return Date.now() - fs.statSync(metaFile(treePath, 'editing')).mtimeMs < EDITING_STALE_MS; }
  catch { return false; }
}
function setEditing(treePath, on) {
  const f = metaFile(treePath, 'editing');
  if (on) { fs.mkdirSync(metaDir(treePath), { recursive: true }); fs.writeFileSync(f, String(Date.now())); }
  else try { fs.unlinkSync(f); } catch {}
}

// ---------- 改动记录：记录员和面板的每次改动都记一条，带反操作，可以撤销 ----------
// 每行 { id, time, source, summary, ops: [applied 带 undo] } 或 { undone: id, time }。
// summary 是中文说明（命令行和旧版本用）；界面按 ops（结构化）用当前语言重新写，特殊的一条带 event: { k, a }
function describeOp(o) {
  const q = s => `「${s}」`;
  switch (o.op) {
    case 'add_rule': return `给 ${o.node} 加规则${q(o.text)}`;
    case 'replace_rule': return `把 ${o.node} 的${q(o.old)}改成${q(o.text)}`;
    case 'remove_rule': return `删掉 ${o.node} 的规则${q(o.text)}`;
    case 'add_node': return `新需求 ${o.id} ${o.title}`;
    case 'add_files': return `${o.node} 对应文件 ${o.globs.join(', ')}`;
    case 'set_files': return o.globs.length ? `${o.node} 的文件改成 ${o.globs.join(', ')}` : `清空 ${o.node} 的文件对应`;
    case 'set_status': return `${o.node} 标为${STATUS_LABEL[o.status] || '无状态'}`;
    case 'rename_node': return `${o.node} 改名为${q(o.title)}`;
    case 'delete_node': return `删除需求 ${o.node}`;
    case 'override_rule': return `在 ${o.node} 里把上级的${q(o.text)}改成${q(o.new)}`;
    case 'memory_remove': return o.wholeFile ? `删掉记忆文件 ${o.file}（${q(o.text)}）` : `删掉记忆 ${o.file} 里的${q(o.text)}`;
    default: return o.op;
  }
}

const newChangeId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function logChange(treePath, entry) {
  fs.mkdirSync(metaDir(treePath), { recursive: true });
  fs.appendFileSync(metaFile(treePath, 'changes.jsonl'), JSON.stringify(entry) + '\n');
}

// 反操作里会出现的操作（applyOps 认的）
const UNDO_OPS = new Set(['add_rule', 'replace_rule', 'remove_rule', 'add_node', 'add_files', 'set_files', 'set_status', 'rename_node', 'delete_node', 'override_rule', 'restore_node', 'set_key', 'memory_restore']);
// 旧版本「先让我确认」模式记下的反操作 reject_pending（applyOps 已经不认），能翻译的条件见 translateLegacyUndo
const canTranslate = o => o.op === 'reject_pending' && !!o.node && (Array.isArray(o.globs) ? o.globs.length > 0 : !!o.text && (o.pending === 'add' || o.pending === 'remove'));
const undoable = e => e.ops.every(o => (o.undo || []).every(u => UNDO_OPS.has(u.op) || canTranslate(u)));

// 最近的改动（新的在前），标出已撤销的；撤销不了的（旧版本留下、翻译不了的反操作）标 undoable: false，面板不给撤销按钮
function readChanges(treePath, limit = 20) {
  let lines = [];
  try { lines = fs.readFileSync(metaFile(treePath, 'changes.jsonl'), 'utf8').trim().split('\n').slice(-500); } catch {}
  const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const undone = new Set(entries.filter(e => e.undone).map(e => e.undone));
  return entries.filter(e => e.id && Array.isArray(e.ops)).map(e => ({ ...e, undone: undone.has(e.id), undoable: undoable(e) })).reverse().slice(0, limit);
}

// 把旧的 reject_pending 翻译成现在的操作。升级清理之后，树里的样子等于用户当时点了 ✓：
//   pending:'add'（撤回新增）    → remove_rule
//   pending:'remove'（撤回删除） → 在原位置 add_rule；规则还在（用户当时点了 ✕）就不用加，免得重复
//   globs（撤回文件对应）         → set_files 去掉这些路径
// 要看树现在的样子才能决定，所以在写入函数里、拿到当前文本时翻译
function translateLegacyUndo(text, ops) {
  if (!ops.some(o => o.op === 'reject_pending')) return ops;
  const root = parse(text);
  return ops.flatMap(o => {
    if (o.op !== 'reject_pending') return [o];
    const node = canTranslate(o) && findById(root, o.node);
    if (!node) return [];
    if (Array.isArray(o.globs)) {
      const rest = node.files.filter(g => !o.globs.includes(g));
      return rest.length === node.files.length ? [] : [{ op: 'set_files', node: o.node, globs: rest }];
    }
    if (o.pending === 'add') return [{ op: 'remove_rule', node: o.node, text: o.text }];
    if (node.rules.some(r => r.text === o.text)) return [];
    return [{ op: 'add_rule', node: o.node, key: o.key || null, text: o.text, index: o.index, force: true }];
  });
}

// 写入 + 写完之后的收尾。没给 write 就加锁同步写；给了（插件的 writeTree，异步）就交给它，返回 Promise。
// 插件要自己写，是因为用户可能在编辑器里有没保存的改动：直接写磁盘的话，用户一保存就把这次改动盖掉。
function writeThen(treePath, update, write, after) {
  if (!write) { updateTree(treePath, update); return after(); }
  return Promise.resolve(write(treePath, update)).then(after);
}

// 改树的唯一入口：加锁写入、自动编译、记一条改动。source：'记录员' | '你'（升级清理记为 '升级'）。
// id：这条改动记录用的编号（问题要记下默认做法是哪条改动，之后好撤销）；不给就新起一个。
// 返回生效的改动（数组），数组上另挂 skipped：没做成的改动和原因（见 parser.applyOps）
// 改记忆文件的操作（memory_*，见 src/memory.js）不改树，和树的改动记成同一条。
// 记忆放在树写成功之后才改：同一批里树的改动没写进去（找不到需求、找不到规则……，「已经有了」不算），
// 或者写树出错，记忆都不动，免得规则从记忆里删了、树里却没加上
function applyChange(treePath, ops, { source, write, id } = {}) {
  const mem = require('./memory');
  const memOps = (ops || []).filter(mem.isMemoryOp);
  const treeOps = (ops || []).filter(o => !mem.isMemoryOp(o));
  let applied = [], skipped = [];
  const update = text => { const r = applyOps(text, treeOps); applied = r.applied; skipped = r.skipped; return r.text; };
  const after = () => {
    const blocked = skipped.some(s => s.reason !== 'duplicate' && s.reason !== 'same');
    for (const o of memOps) {
      let a = null;
      if (!blocked) try { a = o.op === 'memory_remove' ? mem.removeMemory(treePath, o) : null; } catch {}
      if (a) applied.push(a); else skipped.push({ op: o, reason: blocked ? 'blocked' : 'no-rule' });
    }
    if (applied.length) {
      logChange(treePath, { id: id || newChangeId(), time: Date.now(), source, summary: applied.map(describeOp), ops: applied });
    }
    applied.skipped = skipped;
    return applied;
  };
  if (!treeOps.length) return write ? Promise.resolve(after()) : after();
  return writeThen(treePath, update, write, after);
}

// 撤销某次改动：反操作倒着执行。一条都没生效（已经撤销过，或者内容早被改掉了）返回 false，也不记成已撤销
function undoChange(treePath, id, { write } = {}) {
  const entry = readChanges(treePath, 500).find(e => e.id === id);
  if (!entry || entry.undone || !entry.undoable) return write ? Promise.resolve(false) : false;
  const all = entry.ops.slice().reverse().flatMap(o => o.undo || []);
  // 记忆文件的反操作（memory_restore）不改树，直接做
  const mem = require('./memory');
  let count = 0;
  for (const u of all.filter(mem.isMemoryOp)) { try { if (mem.restoreMemory(u)) count++; } catch {} }
  const undo = all.filter(u => !mem.isMemoryOp(u));
  const update = text => { const r = applyOps(text, translateLegacyUndo(text, undo)); count += r.applied.length; return r.text; };
  return writeThen(treePath, update, write, () => {
    if (count) logChange(treePath, { undone: id, time: Date.now() });
    return count > 0;
  });
}

// ---------- 排队：用户正在编辑需求树时，记录员的改动先放进 queue.json ----------
// 记录员（后台进程）往里加、hook 和插件往外取，读改写要加锁，否则会丢条目
const queueLock = treePath => metaFile(treePath, 'queue.lock');

// qid：这组改动是某个问题的默认做法。排队时每条带上 qid，写入时单独记成一条改动，再把改动编号补进问题（见 flushQueue）。
// 返回 { queued 排队条数, applied, skipped 没做成的, id 改动编号（一条都没生效或在排队时为 null） }
function submitOps(treePath, ops, { qid } = {}) {
  const queued = withLock(queueLock(treePath), () => {
    if (!isEditing(treePath)) return 0;
    const q = metaFile(treePath, 'queue.json');
    writeJson(q, [...readJson(q, []), ...ops.map(o => (qid ? { ...o, qid } : o))]);
    return ops.length;
  });
  if (queued) return { queued, applied: [], skipped: [], id: null };
  const id = newChangeId();
  const applied = applyChange(treePath, ops, { source: '记录员', id });
  return { queued: 0, applied, skipped: applied.skipped || [], id: applied.length ? id : null };
}

// 问题的默认做法还在排队（用户在编辑、没保存）时，用户已经选了别的：把这个问题的那几条从队列里拿掉。返回拿掉了几条
function dropQueued(treePath, qid) {
  return withLock(queueLock(treePath), () => {
    const q = metaFile(treePath, 'queue.json');
    const list = readJson(q, []);
    const rest = list.filter(o => o.qid !== qid);
    if (rest.length === list.length) return 0;
    if (rest.length) writeJson(q, rest); else try { fs.unlinkSync(q); } catch {}
    return list.length - rest.length;
  });
}

// 用户保存后（或下一次 hook 时）把队列写进去。插件传 write，返回 Promise。
// 队列锁只在读写一个小 JSON 的一瞬间被占着，插件这边只同步等很短的时间
function flushQueue(treePath, { write } = {}) {
  const ops = withLock(queueLock(treePath), () => {
    if (isEditing(treePath)) return [];
    const q = metaFile(treePath, 'queue.json');
    const list = readJson(q, []);
    if (list.length) try { fs.unlinkSync(q); } catch {}
    return list;
  }, write ? 300 : LOCK_WAIT_MS);
  if (!ops.length) return write ? Promise.resolve([]) : [];
  // 旧版本排队时给每条带了 direct，现在没用了，别带进改动记录。
  // 带 qid 的是某个问题的默认做法：每个问题单独记一条改动，把编号补进 questions.jsonl，用户改选别的时才撤得掉
  const groups = new Map();
  for (const { direct, qid, ...o } of ops) {
    const k = qid || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(o);
  }
  const all = [];
  const steps = [...groups].map(([qid, list]) => () => {
    const id = newChangeId();
    const done = applied => {
      all.push(...applied);
      if (qid && applied.length) appendLog(treePath, 'questions.jsonl', { update: qid, changeId: id, time: Date.now() });
    };
    const r = applyChange(treePath, list, { source: '记录员', write, id });
    return write ? r.then(done) : done(r);
  });
  if (!write) { steps.forEach(s => s()); return all; }
  return steps.reduce((p, s) => p.then(s), Promise.resolve()).then(() => all);
}

module.exports = {
  findTree, samePath, pathKey, caseInsensitive, TEMPLATE, metaFile, readJson, writeJson, readTail,
  updateTree, updateTreeAsync, compileTree, readCompileStatus,
  isEditing, setEditing, submitOps, flushQueue, dropQueued, appendLog, newChangeId, describeOp,
  readState, updateState, writeRecorderStatus, readRecorderStatus, touch, readTouched,
  appendActivity, readActivity, trimActivity, appendMemoryWrite, readMemoryWrites, trimMemoryWrites, appendContext, readContext, trimContext, readConfig, writeConfig, ensureTracking,
  applyChange, undoChange, readChanges,
};
