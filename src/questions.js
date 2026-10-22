'use strict';
// 拿不准、要问用户的事。有把握的改动直接写进树；拿不准的（管全项目还是只管这一块、新说法是取代还是补充、做完没有）
// 先按最可能的做法写进树（默认做法），同时在这里记一个问题，插件弹出选项让用户改选。
//
// .reqtree/questions.jsonl，只追加（记录员在后台、插件在前台，同时写也不会互相覆盖）：
//   问题一行 { id, time, source, kind?, node?, staleKey?, t?, text, options: [{ label, t?, ops }], default,
//             defaultApplied 默认做法是否已经写进树, changeId 默认做法那条改动的编号（没改动为 null）, queued 默认做法在排队 }
//     source：'记录员' | '体检' | '久未动'
//     t / options[].t：结构化文字（{ k, a }），插件按界面语言显示；没有就用 text / label（记录员按用户的语言写）
//   更新一行 { update: id, time, changeId?, status?: 'answered' | 'dismissed', choice?, auto?, answerChangeId? }
// 读的时候按 id 合并。开着超过 7 天没回答的算过期（status 'expired'），保留默认做法。
const fs = require('fs');
const store = require('./store');
const { parse, walk, findById } = require('./parser');
const { isStale } = require('./viewmodel');

const FILE = 'questions.jsonl';
const EXPIRE_MS = 7 * 86400000;
// 「久未动」的问题同时最多开着几个：刚装好时可能一下子有很多 🔨 很久没动，别一次弹一串
const STALE_OPEN_MAX = 3;

const newId = () => 'q' + store.newChangeId();

function readAll(treePath) {
  let text = '';
  try { text = fs.readFileSync(store.metaFile(treePath, FILE), 'utf8'); } catch { return []; }
  const byId = new Map();
  for (const line of text.split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== 'object') continue;
    if (e.update) {
      const q = byId.get(e.update);
      if (!q) continue;
      if (e.changeId !== undefined) q.changeId = e.changeId;
      if (e.status && q.status === 'open') Object.assign(q, { status: e.status, choice: e.choice, auto: !!e.auto, answerChangeId: e.answerChangeId || null, answeredAt: e.time });
    } else if (e.id && typeof e.text === 'string' && Array.isArray(e.options)) {
      byId.set(e.id, { ...e, status: 'open' });
    }
  }
  return [...byId.values()];
}

// 所有问题（新的在前）；开着超过 7 天的标成 expired
function readQuestions(treePath, now = Date.now()) {
  return readAll(treePath)
    .map(q => (q.status === 'open' && now - q.time > EXPIRE_MS ? { ...q, status: 'expired' } : q))
    .sort((a, b) => b.time - a.time);
}
const openQuestions = (treePath, now) => readQuestions(treePath, now).filter(q => q.status === 'open');

function addQuestion(treePath, q) {
  const rec = { id: q.id || newId(), time: Date.now(), changeId: null, queued: false, defaultApplied: false, ...q };
  store.appendLog(treePath, FILE, rec);
  return { ...rec, status: 'open' };
}

const mark = (treePath, id, patch) => store.appendLog(treePath, FILE, { update: id, time: Date.now(), ...patch });

// 回答过程中又收到同一个问题的回答（通知按钮和选择框同时点）：只认第一次
const busy = new Set();

// 选第 k 个选项：选的就是已经写进树的默认做法，只记一下；否则撤销默认做法，再把选的做法记成一条「你」的改动。
// write：插件传 writeTree（用户在编辑器里有未保存的改动时改编辑器），返回 Promise。
// 返回 { ok, applied, reason }；reason：'gone' 已经回答、关掉或过期了，'bad' 没有这个选项，'busy' 正在回答
async function answerQuestion(treePath, id, k, { write } = {}) {
  if (busy.has(id)) return { ok: false, reason: 'busy', applied: [] };
  busy.add(id);
  try {
    const q = readQuestions(treePath).find(x => x.id === id);
    if (!q || q.status !== 'open') return { ok: false, reason: 'gone', applied: [] };
    const opt = q.options[k];
    if (!opt) return { ok: false, reason: 'bad', applied: [] };
    let applied = [], answerChangeId = null;
    if (!(k === q.default && q.defaultApplied)) {
      if (q.defaultApplied) {
        // 默认做法已经被用户自己撤销、或后来又被改掉时，undoChange 什么都不做，照样往下写选的做法
        if (q.changeId) await store.undoChange(treePath, q.changeId, { write });
        else if (q.queued) store.dropQueued(treePath, q.id);
      }
      if (opt.ops.length) {
        answerChangeId = store.newChangeId();
        applied = await store.applyChange(treePath, opt.ops, { source: '你', write, id: answerChangeId });
        if (!applied.length) answerChangeId = null;
      }
    }
    mark(treePath, id, { status: 'answered', choice: k, answerChangeId });
    // 「还在做」：重新开始算久未动，过一个周期再问
    if (q.kind === 'stale' && q.node && !opt.ops.length) try { store.touch(treePath, [q.node]); } catch {}
    return { ok: true, applied };
  } finally { busy.delete(id); }
}

// 关掉：保留现在的样子（默认做法写进去了就留着），不再问
function dismissQuestion(treePath, id) {
  const q = readQuestions(treePath).find(x => x.id === id);
  if (!q || q.status !== 'open') return false;
  mark(treePath, id, { status: 'dismissed' });
  return true;
}

// 设置「不问我」：记录员的问题直接按默认做法算（已经写进树了，只记一下）
function acceptDefault(treePath, id) {
  const q = readQuestions(treePath).find(x => x.id === id);
  if (!q || q.status !== 'open' || !q.defaultApplied) return false;
  mark(treePath, id, { status: 'answered', choice: q.default, auto: true });
  return true;
}

// 标着 🔨、很久没被 AI 改过的需求，变成同一种问题（不调用模型）。每个需求每个「没动的周期」只问一次：
// 周期按最后一次改动的时间（没有就是开始跟踪的时间）算，回答「还在做」会重新开始算。返回新加的问题
const STALE_TEXT = (title, days) => `「${title}」${days} 天没动了，做完了吗？`;
function staleQuestions(treePath, now = Date.now()) {
  const root = parse(fs.readFileSync(treePath, 'utf8'));
  const { touched = {}, since } = store.readState(treePath);
  const all = readAll(treePath);
  const asked = new Set(all.map(q => q.staleKey).filter(Boolean));
  // 已经不算久未动的（AI 又改了它、用户自己改了状态、需求删了）：问题自动收起
  let open = 0;
  for (const q of all) {
    if (q.kind !== 'stale' || q.status !== 'open' || now - q.time > EXPIRE_MS) continue;
    const n = findById(root, q.node);
    if (!n || !isStale(n, touched, since, now) || `${n.id}@${Math.max(touched[n.id] || 0, since || now)}` !== q.staleKey) mark(treePath, q.id, { status: 'dismissed', auto: true });
    else open++;
  }
  const added = [];
  for (const n of walk(root)) {
    if (open >= STALE_OPEN_MAX) break;
    if (!isStale(n, touched, since, now)) continue;
    const base = Math.max(touched[n.id] || 0, since || now);
    const staleKey = `${n.id}@${base}`;
    if (asked.has(staleKey)) continue;
    const days = Math.floor((now - base) / 86400000);
    added.push(addQuestion(treePath, {
      source: '久未动', kind: 'stale', node: n.id, staleKey,
      text: STALE_TEXT(n.title, days), t: { k: 'q.stale', a: [n.title, days] },
      options: [
        { label: '完成', t: { k: 'q.optDone', a: [] }, ops: [{ op: 'set_status', node: n.id, status: 'done' }] },
        { label: '暂停（待定）', t: { k: 'q.optPause', a: [] }, ops: [{ op: 'set_status', node: n.id, status: 'question' }] },
        { label: '还在做', t: { k: 'q.optDoing', a: [] }, ops: [] },
      ],
      default: 2, defaultApplied: true,
    }));
    open++;
  }
  return added;
}

module.exports = {
  FILE, EXPIRE_MS, STALE_OPEN_MAX, newId, readQuestions, openQuestions, addQuestion,
  answerQuestion, dismissQuestion, acceptDefault, staleQuestions,
};
