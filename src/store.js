'use strict';
// 需求树的存取：读写 .claude/rules/ruletree/ 里的规则文件、改动记录和撤销、程序状态、日志。
// hook、命令行、插件都只通过这里写规则文件，避免互相覆盖。所有函数都以项目根目录 dir 为准。
//
// .ruletree/ 里的文件（不进 git）
//   snapshot.json   每个规则文件上次记下的内容：和磁盘对不上就是有人改了（AI 用编辑工具改的由 hook 记成「AI」）
//   changes.jsonl   改动记录，每条带改动的文件改前改后，可以撤销（只追加）
//   state.json      { since 开始跟踪的时间, touched {需求编号: AI 最后改它的文件的时间} }
//   activity.jsonl  AI 改了哪些文件（只追加）；context.jsonl  每个会话加载了哪些规则文件、多少字（只追加）
//   categories.json 体检给规则分的组（只改面板显示）；checkup-report.md  上次体检的报告
//   rules.lock / state.lock  锁（用完即删，进程崩溃留下的按时间判定失效）
const fs = require('fs');
const path = require('path');
const T = require('./tree');

const RULES_DIR = path.join('.claude', 'rules', 'ruletree');
const META_DIR = '.ruletree';
const rulesDir = dir => path.join(dir, RULES_DIR);
const metaFile = (dir, name) => path.join(dir, META_DIR, name);

// Windows 和 macOS 的文件系统默认不分大小写
const caseInsensitive = () => process.platform === 'win32' || process.platform === 'darwin';
const pathKey = p => (caseInsensitive() ? p.toLowerCase() : p);
const samePath = (a, b) => pathKey(path.resolve(a)) === pathKey(path.resolve(b));

// 旧版的一整份树文件（需求树.md、*.tree.md），升级时拆成规则文件（src/migrate.js）
function legacyTree(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  const name = names.find(n => n === '需求树.md') || names.filter(n => n.endsWith('.tree.md')).sort()[0];
  return name ? path.join(dir, name) : null;
}
const hasRules = dir => { try { return fs.readdirSync(rulesDir(dir)).some(T.isRuleFile); } catch { return false; } };
// 这个文件夹是不是用需求树的项目（有规则文件，或者还没升级的旧树文件）
const isProject = dir => hasRules(dir) || !!legacyTree(dir);

// ---------- 小工具 ----------

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
// 只读文件末尾 bytes 字节；从中间截断时丢掉第一行残缺的内容
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
// 'wx' 独占创建锁文件。hook、命令行是短命的独立进程，同步等锁没问题；插件宿主里同步等会卡住 VS Code，插件走 *Async（每次只试一下，拿不到就异步等）。
// 加锁顺序固定为 rules.lock → state.lock，不会死锁。进程被杀留下的锁超过 staleMs 没动就当它失效
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const LOCK_WAIT_MS = 5000, LOCK_STALE_MS = 10000, STATE_WAIT_MS = 3000, STATE_STALE_MS = 1500;
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
    e.code = 'RULETREE_BUSY';
    e.t = { k: 'err.busy', a: [Math.round(waitMs / 1000)] };
    throw e;
  }
  try { return fn(); } finally { fs.closeSync(fd); try { fs.unlinkSync(lock); } catch {} }
}
const rulesLock = dir => metaFile(dir, 'rules.lock');
const stateLock = dir => metaFile(dir, 'state.lock');
// 插件用：不在宿主线程里同步等锁
async function retryBusy(fn) {
  for (const until = Date.now() + LOCK_WAIT_MS; ;) {
    try { return fn(0); } catch (e) {
      if (e.code !== 'RULETREE_BUSY' || Date.now() >= until) throw e;
      await new Promise(r => setTimeout(r, 30));
    }
  }
}

// ---------- 规则文件 ----------

// 文件夹里的规则文件：Map 文件名 → 文本（不含工具生成的 _guide.md）
function readFiles(dir) {
  const files = new Map();
  let names = [];
  try { names = fs.readdirSync(rulesDir(dir)); } catch {}
  for (const n of names.filter(T.isRuleFile)) try { files.set(n, fs.readFileSync(path.join(rulesDir(dir), n), 'utf8')); } catch {}
  return files;
}
const readTree = dir => T.build(readFiles(dir));

// 把 after 写到磁盘：比 before 多的、变了的写，少了的删。返回改动 [{ name, before, after }]（null 表示没有这个文件）
function writeFiles(dir, before, after) {
  const out = [];
  // 只改了大小写的改名（R1-Foo.md → R1-foo.md）：不分大小写的系统上两个名字是同一个文件，先写新的再删旧的会把它删掉。先改名
  if (caseInsensitive()) {
    for (const name of before.keys()) {
      if (after.has(name)) continue;
      const to = [...after.keys()].find(n => !before.has(n) && n.toLowerCase() === name.toLowerCase());
      if (to) try { fs.renameSync(path.join(rulesDir(dir), name), path.join(rulesDir(dir), to)); } catch {}
    }
  }
  const renamedTo = name => caseInsensitive() && [...after.keys()].some(n => n !== name && n.toLowerCase() === name.toLowerCase());
  for (const [name, text] of after) {
    if (before.get(name) === text) continue;
    atomicWrite(path.join(rulesDir(dir), name), text);
    out.push({ name, before: before.has(name) ? before.get(name) : null, after: text });
  }
  for (const [name, text] of before) {
    if (after.has(name)) continue;
    if (!renamedTo(name)) try { fs.unlinkSync(path.join(rulesDir(dir), name)); } catch {}
    out.push({ name, before: text, after: null });
  }
  return out;
}

// ---------- 快照和改动记录 ----------
// 快照记着每个规则文件上次见到的内容。谁改了文件，谁就对一下快照记一条改动：面板、体检在写的时候记；
// AI 用编辑工具改的，PostToolUse hook 记（syncFiles）；别的途径（命令行、git、手动）改的，插件刷新时补记成「其他」
const SNAPSHOT = 'snapshot.json';
const readSnapshot = dir => readJson(metaFile(dir, SNAPSHOT), null);
const writeSnapshot = (dir, snap) => writeJson(metaFile(dir, SNAPSHOT), snap);
const newChangeId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function logChange(dir, entry) {
  fs.mkdirSync(path.join(dir, META_DIR), { recursive: true });
  fs.appendFileSync(metaFile(dir, 'changes.jsonl'), JSON.stringify(entry) + '\n');
}

// 一组文件改动 → 给人看的操作列表（和编辑操作同样的名字，面板按语言写成句子）。
// 文件改名（同一个编号，旧文件没了、新文件有了）算同一个需求改了标题
function describeChange(diffs) {
  const byId = new Map();
  const idOf = (name, text) => T.parseFile(name, text || '').id;
  const items = diffs.map(d => ({ ...d, id: idOf(d.name, d.after != null ? d.after : d.before) }));
  const merged = [];
  for (const d of items) {
    const pair = byId.get(d.id);
    if (pair && ((pair.before == null) !== (d.before == null))) {
      const [gone, made] = pair.before != null ? [pair, d] : [d, pair];
      Object.assign(pair, { name: made.name, before: gone.before, after: made.after });
      continue;
    }
    byId.set(d.id, d);
    merged.push(d);
  }
  const ops = [];
  for (const d of merged) {
    if (d.before == null) { const n = T.parseFile(d.name, d.after); ops.push({ op: 'add_node', node: n.id, id: n.id, title: n.title }); continue; }
    if (d.after == null) { const n = T.parseFile(d.name, d.before); ops.push({ op: 'delete_node', node: n.id, title: n.title }); continue; }
    const b = T.parseFile(d.name, d.before), a = T.parseFile(d.name, d.after);
    const id = a.id, start = ops.length;
    if (b.title !== a.title) ops.push({ op: 'rename_node', node: id, title: a.title, old: b.title });
    if (b.status !== a.status) ops.push({ op: 'set_status', node: id, status: a.status });
    if (b.files.join('\n') !== a.files.join('\n')) ops.push({ op: 'set_files', node: id, globs: a.files });
    if (b.docs.join('\n') !== a.docs.join('\n')) ops.push({ op: 'set_docs', node: id, docs: a.docs });
    const left = a.rules.map(r => r.text);
    const removed = [];
    for (const r of b.rules) { const i = left.indexOf(r.text); if (i >= 0) left.splice(i, 1); else removed.push(r.text); }
    if (removed.length === left.length) removed.forEach((old, i) => ops.push({ op: 'replace_rule', node: id, old, text: left[i] }));
    else {
      removed.forEach(text => ops.push({ op: 'remove_rule', node: id, text }));
      left.forEach(text => ops.push({ op: 'add_rule', node: id, text }));
    }
    if (ops.length === start) ops.push({ op: 'edit_file', node: id, file: d.name });
  }
  return ops;
}

// 改动记录的中文说明（命令行用；面板按 ops 用当前语言重新写）
function describeOp(o) {
  const q = s => `「${s}」`;
  switch (o.op) {
    case 'add_rule': return `给 ${o.node} 加规则${q(o.text)}`;
    case 'replace_rule': return `把 ${o.node} 的${q(o.old)}改成${q(o.text)}`;
    case 'remove_rule': return `删掉 ${o.node} 的规则${q(o.text)}`;
    case 'add_node': return `新需求 ${o.id} ${o.title}`;
    case 'delete_node': return `删除需求 ${o.node} ${o.title || ''}`.trim();
    case 'rename_node': return `${o.node} 改名为${q(o.title)}`;
    case 'set_status': return `${o.node} 标为${T.STATUS_LABEL[o.status] || '无状态'}`;
    case 'set_files': return o.globs.length ? `${o.node} 的文件改成 ${o.globs.join(', ')}` : `清空 ${o.node} 的文件范围`;
    case 'set_docs': return o.docs.length ? `${o.node} 的文档改成 ${o.docs.join(', ')}` : `清空 ${o.node} 挂的文档`;
    default: return `改了 ${o.file || o.node}`;
  }
}

// 记一条改动，返回它（没有改动返回 null）
function record(dir, diffs, source, extra = {}) {
  if (!diffs.length) return null;
  const ops = describeChange(diffs);
  const entry = { id: newChangeId(), time: Date.now(), source, summary: ops.map(describeOp), ops, files: diffs, ...extra };
  logChange(dir, entry);
  return entry;
}

// 快照里这些文件换成磁盘上现在的样子（删掉的去掉）
function snapTo(snap, dir, names) {
  for (const n of names) {
    let t = null;
    try { t = fs.readFileSync(path.join(rulesDir(dir), n), 'utf8'); } catch {}
    if (t == null) delete snap[n]; else snap[n] = t;
  }
  return snap;
}
const filesOf = dir => Object.fromEntries(readFiles(dir));

// 在规则文件上做编辑操作（面板、体检）：加锁、写文件、记一条改动、更新快照。
// 返回做成的操作（数组，上面挂 skipped：没做成的和原因，见 tree.applyOps；entry：这条改动记录）
function commitUnlocked(dir, ops, source) {
  const before = readFiles(dir);
  const r = T.applyOps(before, ops);
  const snap = readSnapshot(dir) || filesOf(dir);
  // 要改的文件和快照对不上：别人（多半是 AI，它的 hook 还没跑到）刚改过，还没记。先单独记一条，免得并进这次、撤销时一起没了
  const touched = new Set([...r.files.keys(), ...before.keys()].filter(n => r.files.get(n) !== before.get(n)));
  recordDrift(dir, snap, before, [...touched]);
  const diffs = writeFiles(dir, before, r.files);
  const entry = record(dir, diffs, source);
  writeSnapshot(dir, snapTo(snap, dir, diffs.map(d => d.name)));
  const out = r.applied;
  out.skipped = r.skipped;
  out.entry = entry;
  return out;
}
const commit = (dir, ops, { source = '你' } = {}) => withLock(rulesLock(dir), () => commitUnlocked(dir, ops, source));
const commitAsync = (dir, ops, { source = '你' } = {}) => retryBusy(w => withLock(rulesLock(dir), () => commitUnlocked(dir, ops, source), w));

// 整份写入一组规则文件（升级、新建项目）：files 是要有的全部规则文件，原来有、这里没有的删掉
const replaceAll = (dir, files, { source }) => withLock(rulesLock(dir), () => {
  const diffs = writeFiles(dir, readFiles(dir), files);
  const entry = record(dir, diffs, source);
  writeSnapshot(dir, filesOf(dir));
  return entry;
});

// 快照和 known（Map 文件名 → 文本，null 是没有这个文件）对不上的文件：记成「其他」的一条，快照跟上 known
function recordDrift(dir, snap, known, names) {
  const diffs = [];
  for (const n of names) {
    const was = n in snap ? snap[n] : null, now = known.has(n) ? known.get(n) : null;
    if (was !== now) diffs.push({ name: n, before: was, after: now });
  }
  if (!diffs.length) return null;
  for (const d of diffs) { if (d.after == null) delete snap[d.name]; else snap[d.name] = d.after; }
  return record(dir, diffs, '其他');
}

// 对一下快照，把这些文件（names 为空：全部）的改动记成 source 的一条。第一次（还没有快照）只建快照不记。
// minAgeMs：最近这么久内改过的先不记（可能是 AI 刚改的，hook 马上会以「AI」记）。
// known：Map 文件名 → 这次改动之前的内容（hook 从 Edit 的参数里推出来的）。快照和它对不上的部分是别人改的，先单独记成「其他」，
// 不然 git pull 下来的需求会算成 AI 新建的，撤销 AI 那次就把整个文件删了
function syncFiles(dir, names, source, { minAgeMs = 0, known = null } = {}) {
  if (!hasRules(dir) && !readSnapshot(dir)) return null;
  return withLock(rulesLock(dir), () => syncUnlocked(dir, names, source, { minAgeMs, known }));
}
const syncFilesAsync = (dir, names, source, opts = {}) => (!hasRules(dir) && !readSnapshot(dir) ? Promise.resolve(null)
  : retryBusy(w => withLock(rulesLock(dir), () => syncUnlocked(dir, names, source, opts), w)));
function syncUnlocked(dir, names, source, { minAgeMs = 0, known = null } = {}) {
  {
    const snap = readSnapshot(dir);
    if (!snap) { writeSnapshot(dir, filesOf(dir)); return null; }
    if (known) recordDrift(dir, snap, known, [...known.keys()]);
    const disk = readFiles(dir);
    const list = names && names.length ? names : [...new Set([...Object.keys(snap), ...disk.keys()])];
    const diffs = [];
    for (const name of list) {
      if (!T.isRuleFile(name)) continue;
      const before = name in snap ? snap[name] : null, after = disk.has(name) ? disk.get(name) : null;
      if (before === after) continue;
      if (minAgeMs && after != null) { try { if (Date.now() - fs.statSync(path.join(rulesDir(dir), name)).mtimeMs < minAgeMs) continue; } catch {} }
      diffs.push({ name, before, after });
    }
    const entry = record(dir, diffs, source);
    if (diffs.length || known) writeSnapshot(dir, snapTo(snap, dir, diffs.map(d => d.name)));
    return entry;
  }
}

// ---------- 撤销：按行反着打补丁 ----------

// 两份文本的不同之处（按行，最长公共子序列）：[{ a, aEnd, b, bEnd }] 表示 A[a..aEnd) 换成了 B[b..bEnd)
function diffLines(A, B) {
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const hunks = [];
  let i = 0, j = 0, cur = null;
  const flush = () => { if (cur) { cur.aEnd = i; cur.bEnd = j; hunks.push(cur); cur = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { flush(); i++; j++; continue; }
    if (!cur) cur = { a: i, b: j };
    if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) j++; else i++;
  }
  flush();
  return hunks;
}

// 把 before → after 这次改动从 current 里撤掉（current 之后可能又被改过）。返回新文本，一处都撤不掉返回 null。
// 每一处：after 里的那几行在 current 里找得到（离原位最近的一处）就换回 before 的；纯删除的按前后的行找回原位插回去
function reversePatch(current, before, after) {
  const nl = T.lineEnding(current);
  const B = T.splitLines(before), A = T.splitLines(after);
  const cur = T.splitLines(current);
  let done = 0;
  for (const h of diffLines(B, A).reverse()) {
    const want = A.slice(h.b, h.bEnd), put = B.slice(h.a, h.aEnd);
    let at = -1;
    if (want.length) {
      const hits = [];
      for (let k = 0; k + want.length <= cur.length; k++) if (want.every((l, x) => cur[k + x] === l)) hits.push(k);
      if (hits.length) at = hits.reduce((best, k) => (Math.abs(k - h.b) < Math.abs(best - h.b) ? k : best));
    } else {
      const prev = h.b > 0 ? A[h.b - 1] : null, next = h.b < A.length ? A[h.b] : null;
      const near = (line, off) => { const hits = cur.map((l, k) => (l === line ? k + off : -1)).filter(k => k >= 0); return hits.length ? hits.reduce((best, k) => (Math.abs(k - h.b) < Math.abs(best - h.b) ? k : best)) : -1; };
      at = prev != null ? near(prev, 1) : next != null ? near(next, 0) : 0;
    }
    if (at < 0) continue;
    cur.splice(at, want.length, ...put);
    done++;
  }
  return done ? cur.join(nl) : null;
}

// 最近的改动（新的在前），标出已撤销的
function readChanges(dir, limit = 20) {
  let text = '';
  try { text = readTail(metaFile(dir, 'changes.jsonl'), 4 << 20); } catch {}
  const entries = text.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const undone = new Set(entries.filter(e => e.undone).map(e => e.undone));
  return entries.filter(e => e.id && Array.isArray(e.files))
    .map(e => ({ ...e, undone: undone.has(e.id), undoable: !undone.has(e.id) })).reverse().slice(0, limit);
}
// 给面板的：不带文件全文（太大）
const changeSummaries = (dir, limit) => readChanges(dir, limit).map(({ files, ...e }) => e);

// 撤销一条改动：每个文件反着打补丁。一处都没撤成（早被改掉了）返回 false，也不记成已撤销
function undoUnlocked(dir, id) {
  const entry = readChanges(dir, 500).find(e => e.id === id);
  if (!entry || entry.undone) return false;
  const disk = readFiles(dir);
  const next = new Map(disk);
  const idOf = f => T.parseFile(f.name, f.after != null ? f.after : f.before).id;
  // 改名（同一个编号，新文件建了、旧文件删了）：新文件后来又被改过、删不掉时，旧文件也不放回，不然有两个同编号的需求
  const stuck = new Set(entry.files.filter(f => f.before == null && f.after != null && disk.has(f.name) && disk.get(f.name) !== f.after).map(idOf));
  let count = 0;
  for (const f of entry.files) {
    const cur = disk.has(f.name) ? disk.get(f.name) : null;
    if (f.after == null) { if (cur == null && !stuck.has(idOf(f))) { next.set(f.name, f.before); count++; } continue; }
    if (cur === f.after) { if (f.before == null) next.delete(f.name); else next.set(f.name, f.before); count++; continue; }
    if (f.before == null || cur == null) continue; // 新建的文件后来又改过、或已经删了：不动
    const t = reversePatch(cur, f.before, f.after);
    if (t != null) { next.set(f.name, t); count++; }
  }
  if (!count) return false;
  const diffs = writeFiles(dir, disk, next);
  logChange(dir, { undone: id, time: Date.now() });
  const snap = readSnapshot(dir) || {};
  writeSnapshot(dir, snapTo(snap, dir, diffs.map(d => d.name)));
  // 有的文件后来又被改过、撤不回去：返回 'partial'，插件提醒用户（这条也算撤销过了，不能再撤）
  return count < entry.files.length ? 'partial' : true;
}
const undoChange = (dir, id) => withLock(rulesLock(dir), () => undoUnlocked(dir, id));
const undoChangeAsync = (dir, id) => retryBusy(w => withLock(rulesLock(dir), () => undoUnlocked(dir, id), w));

// 改动记录只留最近 500 条（每条带文件全文）
function trimChanges(dir) {
  const f = metaFile(dir, 'changes.jsonl');
  try {
    if (fs.statSync(f).size < 2 << 20) return;
    withLock(rulesLock(dir), () => atomicWrite(f, fs.readFileSync(f, 'utf8').trim().split('\n').slice(-500).join('\n') + '\n'));
  } catch {}
}

// ---------- 程序状态：state.json ----------
const DEFAULT_STATE = { since: null, touched: {} };
function readState(dir) {
  const cur = readJson(metaFile(dir, 'state.json'), null) || {};
  return { ...DEFAULT_STATE, since: cur.since || null, touched: { ...(cur.touched || {}) } };
}
function updateState(dir, fn) {
  return withLock(stateLock(dir), () => {
    const next = fn(readState(dir));
    const file = metaFile(dir, 'state.json'), text = JSON.stringify(next, null, 2);
    let old = null;
    try { old = fs.readFileSync(file, 'utf8'); } catch {}
    if (old !== text) atomicWrite(file, text); // 内容没变不写：插件监视 .ruletree/*.json，每写一次就刷新一次
    return next;
  }, STATE_WAIT_MS, STATE_STALE_MS);
}
// 开始跟踪的时间：判断「🔨 很久没动」时，没被跟踪过的需求从这一刻算起（刚装好不误报）
function ensureTracking(dir) {
  const s = readState(dir);
  return s.since ? s : updateState(dir, st => (st.since ? st : { ...st, since: Date.now() }));
}
function touch(dir, ids) {
  const now = Date.now();
  updateState(dir, s => ({ ...s, touched: { ...s.touched, ...Object.fromEntries(ids.map(id => [id, now])) } }));
}

// ---------- 只追加的日志 ----------
// activity.jsonl  AI 改了哪些文件 { node, file, time, session, agent }；node 为 null 表示这个文件不属于任何需求
// context.jsonl   Claude Code 往上下文里加载了哪些规则文件 { session, agent, file, chars, reason, source, node, trigger, parent, time }
function appendLog(dir, name, entry) {
  fs.mkdirSync(path.join(dir, META_DIR), { recursive: true });
  fs.appendFileSync(metaFile(dir, name), JSON.stringify(entry) + '\n');
}
function readLog(dir, name, sinceMs, tailBytes = 256 * 1024) {
  let text;
  try { text = readTail(metaFile(dir, name), tailBytes); } catch { return []; }
  const cutoff = Date.now() - sinceMs;
  return text.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(e => e && e.time >= cutoff);
}
// 日志太长就只留最近 2000 行
function trimLog(dir, name) {
  const f = metaFile(dir, name);
  try {
    if (fs.statSync(f).size < 512 * 1024) return;
    atomicWrite(f, fs.readFileSync(f, 'utf8').trim().split('\n').slice(-2000).join('\n') + '\n');
  } catch {}
}
const appendActivity = (dir, e) => appendLog(dir, 'activity.jsonl', e);
const readActivity = (dir, sinceMs) => readLog(dir, 'activity.jsonl', sinceMs);
const appendContext = (dir, e) => appendLog(dir, 'context.jsonl', e);
const readContext = (dir, sinceMs) => readLog(dir, 'context.jsonl', sinceMs, 512 * 1024);

// .ruletree/ 不进 git（规则文件进）。返回改了没有
function ensureGitignore(dir) {
  const gi = path.join(dir, '.gitignore');
  let text = '';
  try { text = fs.readFileSync(gi, 'utf8'); } catch {}
  if (/^\.ruletree\/?$/m.test(text)) return false;
  fs.writeFileSync(gi, text + (text && !text.endsWith('\n') ? '\n' : '') + '.ruletree/\n');
  return true;
}

// ---------- 新项目 ----------
// 第一棵树：根需求 + 按项目最上一层的文件夹各建一个需求（带上文件范围）。文件跟着 .gitignore；文件夹太多只取文件最多的 INIT_MAX 个
const INIT_MAX = 12;
const ROOT_INTRO = '这里是全项目都要守的规则。每个需求一个文件，在同一个文件夹里；改名、合并、删掉都行。';
function initialFiles(dir) {
  const files = new Map([[T.ROOT_FILE, `# P ${path.basename(dir)}\n${ROOT_INTRO}\n`]]);
  let list = [];
  try { list = require('./files').listFiles(dir); } catch {}
  const count = new Map();
  for (const f of list) {
    const i = f.indexOf('/');
    if (i < 0) continue;
    const top = f.slice(0, i);
    if (top.startsWith('.') || /^(node_modules|dist|build|out|target|coverage|vendor)$/i.test(top)) continue;
    count.set(top, (count.get(top) || 0) + 1);
  }
  [...count].sort((a, b) => b[1] - a[1]).slice(0, INIT_MAX).forEach(([t], i) => {
    files.set(T.fileName(`R${i + 1}`, t), T.newFile({ id: `R${i + 1}`, title: t, globs: [`${t}/**`] }));
  });
  return files;
}

module.exports = {
  RULES_DIR, META_DIR, rulesDir, metaFile, legacyTree, hasRules, isProject, samePath, pathKey, caseInsensitive,
  atomicWrite, readJson, writeJson, readTail, withLock,
  readFiles, readTree, commit, commitAsync, replaceAll, syncFiles, syncFilesAsync, readChanges, changeSummaries, undoChange, undoChangeAsync, trimChanges,
  describeChange, describeOp, diffLines, reversePatch,
  readState, updateState, ensureTracking, touch,
  appendLog, readLog, trimLog, appendActivity, readActivity, appendContext, readContext,
  initialFiles, ROOT_INTRO, ensureGitignore,
};
