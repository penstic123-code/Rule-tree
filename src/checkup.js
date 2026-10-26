'use strict';
// 体检：先用程序查（不调用模型），再调用一次模型找重复、矛盾、过时的规则，顺带给规则多的需求分组。
// 能改的直接改成一条改动（来源「体检」，面板上可以撤销）；「决定：」开头的规则模型不许删改，拿不准的写进报告让用户定。
// 程序查：编号重复、上级不存在、没写文件范围（每次都加载）、范围一个文件都匹配不到、下级范围超出上级、规则太多、挂的文档或节不在、
//         规则里提到的文件不在（交给模型判断是不是过时）、意思一样的规则（直接删掉一条）。
// 规则自上次体检后一条没变，就不调用模型
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const T = require('./tree');
const store = require('./store');
const Docs = require('./docs');
const Cats = require('./categories');
const STRINGS = require('../media/strings');

const MANY_RULES = 12;
const SEEN = 'checkup-seen.json';
const REPORT = 'checkup-report.md';

// 规则里提到的文件、路径（带 / 或常见扩展名的词）在项目里找不到 → 可能过时
const PATHY = /`([^`\s]+)`|((?:[\w.-]+\/)+[\w.-]+|[\w-]+\.(?:md|js|ts|gd|tscn|tres|py|html|css|json|mjs|cjs|sh|ps1|cs|go|rs))/g;
function goneMentions(text, files) {
  const low = files.map(f => f.toLowerCase());
  const have = new Set(low), base = new Set(low.map(f => f.split('/').pop()));
  return [...String(text).matchAll(PATHY)].map(m => m[1] || m[2])
    .filter(p => /[/.]/.test(p) && !/[*?{}]/.test(p) && !/^(https?:|~|\.\.?\/)/.test(p) && !/^\.\w+$/.test(p))
    .filter(p => { const l = p.toLowerCase().replace(/\/$/, ''); return !have.has(l) && !base.has(l.split('/').pop()) && !low.some(f => f.startsWith(l + '/')); });
}

// 意思一样的两条：同一个需求里的删前面那条（后写的是后来说的），「决定：」留着，删另一条；
// 下级重复上级的删下级的。下级那条是「决定：」、上级的不是时两条都留：删上级的会让别的下级没了这条，删下级的又丢了「决定」
function duplicateOps(root) {
  const ops = [];
  const gone = new Set();
  const drop = (keep, lose) => {
    if (lose.decision && !keep.decision) [keep, lose] = [lose, keep];
    if (gone.has(lose) || gone.has(keep)) return;
    gone.add(lose);
    ops.push({ op: 'remove_rule', node: lose.owner.id, text: lose.text, why: { k: 'ck.dupWhy', a: [keep.owner.id, keep.text] } });
  };
  for (const n of T.walk(root)) {
    n.rules.forEach((r, i) => n.rules.slice(i + 1).forEach(later => { if (T.sameMeaning(r.text, later.text)) drop(later, r); }));
    for (let p = n.parent; p && p.parent; p = p.parent) for (const up of p.rules) for (const r of n.rules) if (T.sameMeaning(up.text, r.text) && !(r.decision && !up.decision)) drop(up, r);
  }
  return ops;
}

// 程序能查出来的问题 [{ k, ... }]（noteText 写成句子）
function programChecks(dir, { files } = {}) {
  const root = store.readTree(dir);
  const list = files || require('./files').listFiles(dir);
  const notes = root.problems.map(p => ({ ...p }));
  for (const n of T.walk(root)) {
    if (T.isRoot(n)) continue;
    if (!n.files.length) { if (n.rules.length) notes.push({ k: 'global', id: n.id }); }
    else {
      const mine = list.filter(f => T.matchesAny(n.files, f));
      if (!mine.length && n.status !== 'done') notes.push({ k: 'noMatch', id: n.id, globs: n.files });
      const up = T.pathOf(n).slice(0, -1).reverse().find(a => !T.isRoot(a) && a.files.length);
      const out = up ? mine.filter(f => !T.matchesAny(up.files, f)) : [];
      if (out.length) notes.push({ k: 'outside', id: n.id, parent: up.id, file: out[0], count: out.length });
    }
    if (n.rules.length > MANY_RULES) notes.push({ k: 'many', id: n.id, count: n.rules.length });
  }
  for (const n of T.walk(root)) for (const d of n.docs) {
    if (!Docs.exists(dir, d)) { notes.push({ k: 'docGone', id: n.id, doc: d }); continue; }
    const { file, section } = Docs.splitRef(d);
    if (section && !Docs.findSection(fs.readFileSync(Docs.resolve(dir, file), 'utf8'), section)) notes.push({ k: 'docSection', id: n.id, doc: d });
  }
  return notes;
}

const make = T_ => (T_ && typeof T_ === 'function' ? T_ : STRINGS.make('zh'));
function noteText(n, tr) {
  const t = make(tr);
  switch (n.k) {
    case 'dupId': return t('ck.dupId', n.id, n.file, n.other);
    case 'noParent': return t('ck.noParent', n.id, n.parent);
    case 'noId': return t('ck.noId', n.file);
    case 'global': return t('ck.global', n.id);
    case 'noMatch': return t('ck.noMatch', n.id, n.globs.join(', '));
    case 'outside': return t('ck.outside', n.id, n.parent, n.file, n.count);
    case 'many': return t('ck.many', n.id, n.count);
    case 'docGone': return t('ck.docGone', n.id, n.doc);
    case 'docSection': return t('ck.docSection', n.id, n.doc);
    default: return n.k;
  }
}

// 每条规则最后一次被写下的时间（从改动记录里找：加上、改成这句话的那次）
function ruleTimes(dir) {
  const out = new Map();
  for (const e of store.readChanges(dir, 500).reverse()) for (const o of e.ops || []) if ((o.op === 'add_rule' || o.op === 'replace_rule') && o.text) out.set(`${o.node}|${T.norm(o.text)}`, e.time);
  return out;
}
const day = t => new Date(t).toISOString().slice(0, 10);

// 给模型看的规则清单：每条带编号 R1#3，「决定：」标出来，知道时间的写上日期；规则里提到却找不到的文件写在后面
function listing(root, times, files) {
  const lines = [];
  for (const n of [root.children[0], ...[...T.walk(root)].filter(x => !T.isRoot(x))]) {
    if (!n || !n.rules.length) continue;
    lines.push(`${n.id} ${n.title}（${T.isRoot(n) ? '全项目' : n.files.length ? '管 ' + n.files.join(', ') : '没写范围'}）`);
    n.rules.forEach((r, i) => {
      const when = times.get(`${n.id}|${T.norm(r.text)}`);
      const gone = goneMentions(r.text, files);
      lines.push(`  ${n.id}#${i + 1}${when ? ` [${day(when)}]` : ''} ${r.text}${gone.length ? `  ←项目里找不到：${gone.join('、')}` : ''}`);
    });
  }
  return lines.join('\n');
}

function buildPrompt(root, times, files, groupNodes) {
  return `你在给一个项目的规则做体检。规则按需求分组，每个需求管一批文件，改到这些文件时它和它上级的规则会一起交给干活的 AI。
找出下面三类问题，能改的直接给出改法：
1. 重复：两条说的是同一件事（换了说法也算）。删掉一条，或者合成一条（改写留下的那条）。同一个需求里留后写的；下级重复上级的删下级的。
2. 矛盾：两条要求互相打架，而且会一起送到（同一个需求、上下级、或范围有重叠的需求）。以后写的为准（看日期；没日期的，同一个需求里写在后面的是后写的），删掉或改写先写的那条。下级有意对上级做的例外不算矛盾。
3. 过时：规则说的东西已经不在了（后面标了「项目里找不到」的文件），或者读着是进度、计划而不是以后都要守的要求。删掉。只是提到文件名、而文件改了名的，改写成新名字（只在你确定新名字时）。
以「决定：」开头的规则是用户拍板的：不许删、不许改写；它和别的规则冲突时，改别的那条；拿不准就写进 ask 让用户定。
没有把握的不要改，写进 ask。不要为了措辞好看改写规则。
${groupNodes.length ? `另外给规则多的需求分组（只改界面显示）：每个需求分 2–${Cats.MAX_GROUPS} 组，组名 2–4 个字（例：画风、写作、互动、工作流），用规则的语言，同一个意思全项目用同一个组名；每条规则都放进一组，rules 里只写序号。要分组的：${groupNodes.map(n => n.id).join('、')}。` : ''}

规则：
${listing(root, times, files)}

只输出 JSON，不要别的文字；没有问题就输出空数组：
{"fixes":[{"op":"remove","rule":"R1#3","why":"和 R1#5 重复"},{"op":"replace","rule":"R2#1","text":"改写后的规则","why":"合并了 R2#4"}],"ask":[{"rules":["R1#2","R3#1"],"why":"一个说……，一个说……，不知道以哪个为准"}],"categories":[{"node":"R1","groups":[{"name":"写作","rules":[1,2,5]}]}]}`;
}

// 规则 R1#3 → { node, rule }
function ruleRef(root, ref) {
  const m = String(ref || '').match(/^\s*(\S+?)#(\d+)\s*$/);
  const n = m && T.findById(root, m[1]);
  const r = n && n.rules[Number(m[2]) - 1];
  return r ? { node: n, rule: r } : null;
}

// 模型的答复 → 编辑操作；碰「决定：」的、对不上的不做（前者进 ask）。返回 { ops, ask }
function planFixes(root, out) {
  const ops = [], ask = [];
  const used = new Set();
  for (const f of Array.isArray(out && out.fixes) ? out.fixes : []) {
    const hit = f && ruleRef(root, f.rule);
    if (!hit || used.has(hit.rule)) continue;
    const why = typeof f.why === 'string' ? f.why.trim() : '';
    if (hit.rule.decision) { ask.push({ rules: [hit.node.id + '#' + (hit.node.rules.indexOf(hit.rule) + 1)], texts: [hit.rule.text], why }); continue; }
    used.add(hit.rule);
    if (f.op === 'remove') ops.push({ op: 'remove_rule', node: hit.node.id, text: hit.rule.text, why });
    else if (f.op === 'replace' && typeof f.text === 'string' && f.text.trim() && f.text.trim() !== hit.rule.text) ops.push({ op: 'replace_rule', node: hit.node.id, old: hit.rule.text, text: f.text.trim(), why });
  }
  for (const a of Array.isArray(out && out.ask) ? out.ask : []) {
    const hits = (Array.isArray(a && a.rules) ? a.rules : []).map(r => ruleRef(root, r)).filter(Boolean);
    if (hits.length) ask.push({ rules: hits.map(h => h.node.id + '#' + (h.node.rules.indexOf(h.rule) + 1)), texts: hits.map(h => h.rule.text), why: typeof a.why === 'string' ? a.why.trim() : '' });
  }
  return { ops, ask };
}

// 一条编辑操作针对的是哪条规则（去重、对上原因用）
const opKey = o => `${o.node}|${o.op === 'replace_rule' ? o.old : o.text}`;
const fingerprint = files => crypto.createHash('md5').update([...files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, t]) => n + '\n' + t).join('\0')).digest('hex');

// 跑一次体检。opts：model（false 只用程序查）、ask（换掉调用模型的函数，测试用）、T（报告用哪种语言的文字表）、full（规则没变也问模型）
// 返回 { notes, applied, ask, categorized, skippedModel, error, report, entry }
async function runCheckup(dir, { model = true, ask, T: tr, full = false } = {}) {
  const t = make(tr);
  const files = require('./files').listFiles(dir);
  const res = { notes: programChecks(dir, { files }), applied: [], ask: [], categorized: [], skippedModel: false, error: null, entry: null };
  const ops = duplicateOps(store.readTree(dir));
  const seen = store.readJson(store.metaFile(dir, SEEN), {});
  const fp = fingerprint(store.readFiles(dir));
  if (model) {
    if (!full && seen.rules === fp) res.skippedModel = true;
    else {
      const root = store.readTree(dir);
      const cats = Cats.read(dir);
      const groupNodes = Cats.needGroups(root, cats, null);
      try {
        const out = await (ask || (p => require('./model').askJson(p)))(buildPrompt(root, ruleTimes(dir), files, groupNodes));
        const plan = planFixes(root, out);
        const mine = new Set(ops.map(opKey));
        ops.push(...plan.ops.filter(o => !mine.has(opKey(o))));
        res.ask = plan.ask;
        res.categorized = Cats.save(dir, root, out && out.categories);
      } catch (e) { res.error = e; }
    }
  }
  if (ops.length) {
    const why = new Map(ops.map(o => [opKey(o), o.why]));
    const done = await store.commitAsync(dir, ops.map(({ why: _, ...o }) => o), { source: '体检' });
    res.applied = done.map(o => ({ ...o, why: why.get(opKey(o)) || '' }));
    res.entry = done.entry;
  }
  // 记下这次看过的规则：下次没变就不再问模型（模型出错时不记）
  if (model && !res.error && !res.skippedModel) store.writeJson(store.metaFile(dir, SEEN), { rules: fingerprint(store.readFiles(dir)), time: Date.now() });
  res.report = report(res, t);
  try { store.atomicWrite(store.metaFile(dir, REPORT), res.report); } catch {}
  return res;
}

function report(res, t) {
  const whyText = w => (w && typeof w === 'object' ? t(w.k, ...(w.a || [])) : w || '');
  const one = o => (o.op === 'replace_rule' ? t('ck.replaced', o.node, o.old, o.text) : t('ck.removed', o.node, o.text)) + (whyText(o.why) ? `（${whyText(o.why)}）` : '');
  const out = [`# ${t('ck.title')}`, '', new Date().toLocaleString(), '', t('ck.summary', res.applied.length, res.ask.length, res.notes.length), ''];
  if (res.error) out.push(t('ck.modelFail', res.error.message), '');
  if (res.skippedModel) out.push(t('ck.sameRules'), '');
  if (res.ask.length) out.push(`## ${t('ck.askHead')}`, '', ...res.ask.map(a => `- ${a.rules.map((r, i) => `${r}「${a.texts[i]}」`).join(' / ')}${a.why ? `：${a.why}` : ''}`), '');
  if (res.notes.length) out.push(`## ${t('ck.notesHead')}`, '', ...res.notes.map(n => `- ${noteText(n, t)}`), '');
  if (res.applied.length) out.push(`## ${t('ck.doneHead')}`, '', ...res.applied.map(o => `- ${one(o)}`), '', t('ck.undoTip'), '');
  if (res.categorized.length) out.push(t('ck.grouped', res.categorized.join('、')), '');
  if (!res.applied.length && !res.ask.length && !res.notes.length && !res.error) out.push(t('ck.none'), '');
  return out.join('\n');
}

module.exports = { programChecks, noteText, duplicateOps, goneMentions, buildPrompt, planFixes, runCheckup, ruleTimes, REPORT, MANY_RULES };
