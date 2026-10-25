'use strict';
// 要问用户的事和自动处理了的判断。每个判断先按 decide 定问不问：问的开着，插件弹出选项让用户改选；
// 不问的默认做法照样写进树，这里记成「已自动处理」（可以撤销，下次也不再提）。
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
const { parse, walk, findById, norm, DECISION_RE } = require('./parser');
const { isStale } = require('./viewmodel');

const FILE = 'questions.jsonl';
const EXPIRE_MS = 7 * 86400000;
// 「久未动」的问题同时最多开着几个：刚装好时可能一下子有很多 🔨 很久没动，别一次弹一串
const STALE_OPEN_MAX = 3;

const newId = () => 'q' + store.newChangeId();

// 直接改还是问：记录员、体检的每个判断都走这里，别处不再各自定（以前散在六处，说法一处一个样）。
// 要改掉、删掉一条「决定：」的总是问，问的时候先不动它。
// 拿不准的（q.confirm 记录员拿不准、按最可能的做法写了；q.unsure 体检没把握，选「不动」）只在 askUnsure 开着时问（项目设置，默认开）：默认做法照样先写进去，用户改选再换，不挡着干活。
// 别的（模型有把握的）直接改，可以撤销，不问；q.partial 内容没看全的不动、不问。
// 🔨 久未动的问题不走这里：做完没有只有用户知道，staleQuestions 直接开着问。
// 返回 { ask, default }
function decide(q, text, { askUnsure = false } = {}) {
  const keep = q.options.findIndex(o => !o.ops.length);
  if (changesDecision(text, q.options[q.default].ops)) return { ask: true, default: keep >= 0 ? keep : q.default };
  // 没看全是长度限制，问用户也帮不上：不动、不问
  if (q.partial && keep >= 0) return { ask: false, default: keep };
  if (q.unsure && keep >= 0) return { ask: !!askUnsure, default: keep };
  return { ask: !!askUnsure && !!q.confirm, default: q.default };
}
// 这些改动里有没有改掉、删掉、在下级推翻一条「决定：」
function changesDecision(text, ops) {
  const root = parse(text);
  return ops.some(o => {
    const said = o.op === 'replace_rule' ? o.old : (o.op === 'remove_rule' || o.op === 'override_rule') ? o.text : null;
    if (typeof said !== 'string') return false;
    if (DECISION_RE.test(said.trim())) return true;
    const n = findById(root, o.op === 'override_rule' ? o.from : o.node);
    const bare = t => norm(t.replace(DECISION_RE, ''));
    return !!n && n.rules.some(r => r.decision && bare(r.text) === bare(said));
  });
}

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
  FILE, EXPIRE_MS, STALE_OPEN_MAX, newId, decide, readQuestions, openQuestions, addQuestion,
  answerQuestion, dismissQuestion, acceptDefault, staleQuestions,
};
