'use strict';
// 体检里查规则的两样新东西，和原来的冲突检查是同一次模型调用（见 checkup.buildCheckPrompt）：
// 1. 一起送到的规则：AI 改一个文件时，范围覆盖它的需求的规则都会送到。两个不在一条上下级链上的需求（「写作」和某门课）
//    在同一个文件上一起送到，它们之间重复、打架，和上下级之间一样要管。哪些需求会一起送到，程序按项目里真有的文件算；
//    两条话题相近（字面重合度够）的才交给模型判断：重复、冲突，还是不相干 / 有意的例外。
// 2. 过时的规则：程序先找证据（提到的文件、路径在项目里已经没有了；读着像进度、计划），模型确认了才删。不按时间长短删。
// 只查变了的：.reqtree/checkup-seen.json 里记着上次查过的每条规则，这次只看新加、改过的规则和跟它们一起送到的（第一次全查）。
// 规则一条都没变就不调用模型（checkup.checkPlan 里不排规则那一批）。
const fs = require('fs');
const crypto = require('crypto');
const { parse, walk, pathOf, similarity, norm, globToRegExp } = require('./parser');
const { scopeOf, autoLoads } = require('./compile');
const { isRoot } = require('./common');
const Docs = require('./docs');

const NEAR = 0.35;       // 两条规则字面重合度到这么多才算话题相近，交给模型看
const MAX_PAIRS = 25;
const MAX_STALE = 20;

const ruleKey = (node, text) => crypto.createHash('md5').update(`${node}|${norm(text)}`).digest('hex').slice(0, 10);
const ruleKeys = text => [...walk(parse(text))].flatMap(n => n.rules.map(r => ruleKey(n.id, r.text)));
// 上次查过之后新加、改过的规则；seen 是上次记下的 ruleKeys（没有就是全部）
function changedRules(text, seen) {
  const old = new Set(seen || []);
  return [...walk(parse(text))].flatMap(n => n.rules.filter(r => !old.has(ruleKey(n.id, r.text))).map(r => ({ node: n, rule: r })));
}

// 每个会加载规则的需求在项目里匹配到的文件（根节点全局，不算）
function fileSets(root, files) {
  const out = new Map();
  for (const n of walk(root)) {
    if (isRoot(n) || !n.rules.length || !autoLoads(n)) continue;
    const res = scopeOf(n).map(globToRegExp);
    out.set(n, new Set(files.filter(f => res.some(re => re.test(f)))));
  }
  return out;
}
const related = (a, b) => pathOf(a).includes(b) || pathOf(b).includes(a);

// 改同一个文件时一起送到、又不在一条上下级链上的两条话题相近的规则。only：只要牵涉到这几条的（ruleKey 的集合，增量时）
function pairs(text, files, only = null) {
  const root = parse(text);
  const sets = fileSets(root, files);
  const nodes = [...sets.keys()];
  const out = [];
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j];
    if (related(a, b)) continue;
    const [small, big] = sets.get(a).size <= sets.get(b).size ? [sets.get(a), sets.get(b)] : [sets.get(b), sets.get(a)];
    let shared = null;
    for (const f of small) if (big.has(f)) { shared = f; break; }
    if (!shared) continue;
    for (const ra of a.rules) for (const rb of b.rules) {
      if (only && !only.has(ruleKey(a.id, ra.text)) && !only.has(ruleKey(b.id, rb.text))) continue;
      const s = similarity(ra.text, rb.text);
      if (s >= NEAR) out.push({ a: { node: a.id, text: ra.text }, b: { node: b.id, text: rb.text }, file: shared, s });
    }
  }
  return out.sort((x, y) => y.s - x.s).slice(0, MAX_PAIRS);
}

// 过时的证据：规则里提到的文件、路径（带 / 或扩展名的词）在项目里找不到；读着像进度、计划
const PATHY = /`([^`\s]+)`|((?:[\w.-]+\/)+[\w.-]+|[\w-]+\.(?:md|js|ts|gd|tscn|tres|py|html|css|json|mjs|cjs|sh|ps1|cs|go|rs))/g;
// 「暂时不能用 X」「先不做 Y」是现在要守的限制，不是进度，不当证据（2026-10-25 副本上把「四种皮肤样稿还没验收，暂时不能用」当进度搬走了）
const PROGRESS = /已完成|下一步|进度|做到第|已做完/;
// 规则里写的代码名字：反引号里的、snake_case、两段以上驼峰的（EventBus、ShopHours）。words：代码里出现过的名字（codemap.build），
// 不给（没有代码的项目）就不查。名字也可能是文件夹、文件名（pig_actions），这些在项目文件里找得到的不算
const FILE_EXT = /\.(md|js|ts|gd|tscn|tres|py|html?|css|json|mjs|cjs|sh|ps1|cs|go|rs|png|jpe?g|svg|glb|wav|ogg)$/i;
const CODEY = /`([A-Za-z_]\w*)(?:\.\w+)?`|(?<![\w/.-])([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+)(?![\w/-])/g;
const codeNames = s => [...new Set([...String(s).matchAll(CODEY)].map(m => m[1] || m[2]).filter(n => [...n].length >= 4))];
function staleEvidence(text, files, only = null, words = null) {
  // 文件名不分大小写比（规则里写 Claude.md，项目里是 CLAUDE.md）
  const low = files.map(f => f.toLowerCase());
  const have = new Set(low), base = new Set(low.map(f => f.split('/').pop()));
  const segs = words ? new Set(files.flatMap(f => f.split('/').map(s => s.replace(/\.[^.]+$/, '')))) : null;
  const out = [];
  for (const n of walk(parse(text))) for (const r of n.rules) {
    if (only && !only.has(ruleKey(n.id, r.text))) continue;
    // 文件、路径：带 / 或常见扩展名的（反引号里的 `Foo.bar` 是代码名字，不是文件）
    const gone = [...r.text.matchAll(PATHY)].map(m => m[1] || m[2])
      .filter(p => (p.includes('/') || FILE_EXT.test(p)) && !/^https?:/.test(p) && !/[*?{]/.test(p))
      .filter(p => { const q = p.toLowerCase(); return !have.has(q) && !base.has(q.split('/').pop()) && !low.some(f => f.startsWith(q.replace(/\/$/, '') + '/') || f.endsWith('/' + q)); });
    const names = words ? codeNames(r.text).filter(name => !words.has(name) && !segs.has(name) && !gone.some(p => p.includes(name))) : [];
    const why = [gone.length ? `提到的 ${gone.join('、')} 在项目里找不到` : '', names.length ? `代码里找不到 ${names.join('、')}（类、函数这类名字，可能改名或删了）` : ''].filter(Boolean).join('；')
      || (PROGRESS.test(r.text) ? '读着像进度、计划' : '');
    if (why) out.push({ node: n.id, text: r.text, why, progress: !gone.length && !names.length });
  }
  return out.slice(0, MAX_STALE);
}

// 提示词里的这一段。focus：这次只看的规则（增量时）；pairList、staleList 见上
function promptTask({ focus, pairList, staleList }) {
  const parts = [];
  if (focus && focus.length) parts.push(`这次只查上次体检之后新加、改过的规则，和跟它们有关的（同一需求、上下级、下面列出的一起送到的）。新加、改过的：\n${focus.map(f => `- ${f.node.id}「${f.rule.text}」`).join('\n')}`);
  if (pairList.length) parts.push(`下面每对规则不在一条上下级链上，却会在改同一个文件时一起送到 AI 手上。逐对判断，写进 pairs（序号从 1 起）：kind 是 dup（说的是同一件事，留一条就够）、conflict（说法互相矛盾）或 ok（不相干，或者一条是另一条有意的例外）。dup、conflict 时 keep 写留哪条（"a" 或 "b"）：dup 留管得更全的那条；conflict 按后定下的、和正在做的事有关的为准；看不出写 sure:false（就都不动）。
${pairList.map((p, i) => `${i + 1}. a ${p.a.node}「${p.a.text}」 / b ${p.b.node}「${p.b.text}」（一起送到的文件例：${p.file}）`).join('\n')}`);
  if (staleList.length) parts.push(`下面这些规则程序看着可能过时了（括号里是证据）。逐条确认，写进 stale（序号从 1 起）：kind 是 gone（说的东西已经没有了，规则没用了；要 AI 去用的类、函数在代码里找不到了，多半是改名或删了，照做只会出错，也是 gone；「别再用 X」这类禁止的话照样有用，不算；只是顺带提到的东西没了、规则主要的做法还有用的，也不算，写 ok）、progress（只是记做到哪、下一步做什么，AI 照着做不了任何事；「X 还没验收，暂时不能用」「先不做 Y」这类现在要守的限制是规则，不算）或 ok（还有用）。拿不准写 ok。
${staleList.map((s, i) => `${i + 1}. ${s.node}「${s.text}」（${s.why}）`).join('\n')}`);
  // 能写成检查的规则（src/checks.js）：AI 改完文件程序马上查，比写在规则里管用
  parts.push(`另外从${focus && focus.length ? '上面新加、改过的' : '需求树里的'}规则里，挑出能用一个正则在文件内容里查出违反的（禁止出现的词、写法、调用这类，只看一行就能判断的），写进 checks，最多 10 条：node 是需求 ID，rule 是树里原文，glob 是查哪些文件（要落在这个需求的范围里，如 **/*.gd），forbid 是 JavaScript 正则（不带斜杠；匹配到的那一行就可能违反），why 一句话说查什么。要看效果、要跑程序、要看整篇或整体、要靠理解判断的规则不写；拿不准会不会误报的不写；没有就给 []。`);
  return '\n' + parts.join('\n\n') + '\n';
}
const OUTPUT_HINT = ',"pairs":[{"i":1,"kind":"dup","keep":"b"}],"stale":[{"i":1,"kind":"ok"}],"checks":[{"node":"R2","rule":"树里原文","glob":"**/*.gd","forbid":"^\\\\s*print\\\\(","why":"不留调试输出"}]';

// 模型对一起送到的规则的判断 → 问题格式的判断（交给 checkup.settle → Q.decide：直接做、可撤销）
function pairJudgments(items, pairList) {
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    const p = it && pairList[Number(it.i) - 1];
    if (!p || !['dup', 'conflict'].includes(it.kind)) continue;
    const del = x => [{ op: 'remove_rule', node: x.node, text: x.text }];
    const what = it.kind === 'dup' ? '说的是同一件事' : '说法矛盾';
    out.push({
      source: '体检', kind: 'pair', memKey: `pair|${ruleKey(p.a.node, p.a.text)}|${ruleKey(p.b.node, p.b.text)}`,
      text: `${p.a.node}「${p.a.text}」和 ${p.b.node}「${p.b.text}」改同一个文件时一起送到，${what}`,
      t: { k: it.kind === 'dup' ? 'q.pairDup' : 'q.pairConflict', a: [p.a.node, p.a.text, p.b.node, p.b.text] },
      options: [
        { label: `留 ${p.a.node} 的`, t: { k: 'q.optKeepOf', a: [p.a.node] }, ops: del(p.b) },
        { label: `留 ${p.b.node} 的`, t: { k: 'q.optKeepOf', a: [p.b.node] }, ops: del(p.a) },
        { label: '都留着', t: { k: 'q.optKeepBoth', a: [] }, ops: [] },
      ],
      default: it.keep === 'a' ? 0 : it.keep === 'b' ? 1 : 2, unsure: it.sure === false,
    });
  }
  return out;
}

// 模型确认过时的 → 判断：说的东西没有了的删掉；进度、计划搬到这个需求（或上级）挂的文档末尾，再从树里删（没挂文档的不动）
function staleJudgments(items, staleList, { text, projectDir }) {
  const root = parse(text);
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    const s = it && staleList[Number(it.i) - 1];
    if (!s || !['gone', 'progress'].includes(it.kind)) continue;
    const del = { op: 'remove_rule', node: s.node, text: s.text };
    let ops = [del];
    if (it.kind === 'progress') {
      let holder = [...walk(root)].find(n => n.id === s.node);
      while (holder && holder.id && !holder.docs.some(d => !Docs.splitRef(d).section && Docs.exists(projectDir, d))) holder = holder.parent;
      if (!holder || !holder.id) continue;
      const doc = holder.docs.find(d => !Docs.splitRef(d).section && Docs.exists(projectDir, d));
      let old = '';
      try { old = fs.readFileSync(Docs.resolve(projectDir, doc), 'utf8'); } catch { continue; }
      const nl = /\r\n/.test(old) ? '\r\n' : '\n';
      ops = [del, { op: 'doc_write', file: doc, text: `${old.replace(/\s*$/, '')}${nl}${nl}- ${s.text}（${new Date().toISOString().slice(0, 10)} 从需求树 ${s.node} 搬来）${nl}` }];
    }
    out.push({
      source: '体检', kind: 'staleRule', memKey: `staleRule|${ruleKey(s.node, s.text)}`,
      text: `${s.node}「${s.text}」过时了（${s.why}）${it.kind === 'progress' ? '：是进度，搬进文档' : '：删掉'}`,
      t: { k: it.kind === 'progress' ? 'q.ruleProgress' : 'q.ruleGone', a: [s.node, s.text, s.why] },
      options: [{ label: '照做', t: { k: 'q.optDo', a: [] }, ops }, { label: '留着', t: { k: 'q.optKeepRule', a: [] }, ops: [] }],
      default: 0, unsure: it.sure === false,
    });
  }
  return out;
}

module.exports = { ruleKey, ruleKeys, changedRules, pairs, staleEvidence, codeNames, promptTask, pairJudgments, staleJudgments, OUTPUT_HINT };
