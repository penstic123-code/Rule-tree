'use strict';
// 体检：先用程序查（不调用模型），再把规则按需求分成几块（每块约 BATCH_RULES 条），各调用一次模型（最多 JOBS 个同时）找重复、矛盾、过时的规则；
// 规则多的需求另外调用一次模型分组。哪块超时或出错，只丢那一块，其余照常生效；没变的块下次不再问。
// 能改的直接改成一条改动（来源「体检」，面板上可以撤销）；「决定：」开头的规则模型不许删改，拿不准的写进报告让用户定。
// 程序查：编号重复、上级不存在、没写文件范围（每次都加载）、范围一个文件都匹配不到、下级范围超出上级、规则太多、挂的文档或节不在、
//         规则里提到的文件不在（交给模型判断是不是过时）、意思一样的规则（直接删掉一条）。
// 另外调用一次模型，找 CLAUDE.md 里规则树已有的规矩（只提示）；文档找不到时带上当前分支
// 一块规则（连同它的上级）自上次体检后一条没变，就不调用模型
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const T = require('./tree');
const store = require('./store');
const Docs = require('./docs');
const Cats = require('./categories');
const STRINGS = require('../media/strings');

const MANY_RULES = 12;
const BATCH_RULES = 30; // 每块最多这么多条规则（一个需求自己的规则再多也不拆）
const JOBS = 3; // 同时调用几次模型
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
  let branch; // 第一次用到时才问 git
  for (const n of T.walk(root)) for (const d of n.docs) {
    if (!Docs.exists(dir, d)) { notes.push({ k: 'docGone', id: n.id, doc: d, branch: branch === undefined ? (branch = require('./files').gitBranch(dir)) : branch }); continue; }
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
    case 'docGone': return t('ck.docGone', n.id, n.doc, n.branch);
    case 'claudeDup': return t('ck.claudeDup', n.line, n.rule);
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

// 给模型看的规则清单：每条带编号 R1#3，「决定：」标出来，知道时间的写上日期；规则里提到却找不到的文件写在后面。
// nodes 是这一块要检查的需求；context 是它们的上级，只用来对照
function listing(times, files, nodes, context = [], lang = 'zh') {
  const zh = lang === 'zh';
  const lines = [];
  const part = (n, tag) => {
    if (!n.rules.length) return;
    const scope = T.isRoot(n) ? (zh ? '全项目' : 'whole project') : n.files.length ? (zh ? '管 ' : 'covers ') + n.files.join(', ') : (zh ? '没写范围' : 'no paths set');
    lines.push(zh ? `${n.id} ${n.title}（${scope}）${tag}` : `${n.id} ${n.title} (${scope})${tag}`);
    n.rules.forEach((r, i) => {
      const when = times.get(`${n.id}|${T.norm(r.text)}`);
      const gone = goneMentions(r.text, files);
      lines.push(`  ${n.id}#${i + 1}${when ? ` [${day(when)}]` : ''} ${r.text}${gone.length ? (zh ? `  ←项目里找不到：${gone.join('、')}` : `  <- not found in the project: ${gone.join(', ')}`) : ''}`);
    });
  };
  context.forEach(n => part(n, zh ? '【上级，只用来对照，不要改】' : ' [PARENT: for comparison only, do not change]'));
  nodes.forEach(n => part(n, ''));
  return lines.join('\n');
}

// 把需求树切成一块一块：整棵子树规则不超过 BATCH_RULES 条就是一块，超过就先单独拿出这个需求，再切它的下级；
// 小块按顺序装在一起，凑到 BATCH_RULES 条为止。返回 [{ nodes, rules, context }]，context 是块外的上级（要对照的）
const ruleCount = nodes => nodes.reduce((a, n) => a + n.rules.length, 0);
function batches(root) {
  const top = root.children[0];
  if (!top) return [];
  const pieces = n => {
    const all = [n, ...T.walk(n)];
    return ruleCount(all) <= BATCH_RULES || !n.children.length ? [all] : [[n], ...n.children.flatMap(pieces)];
  };
  const out = [];
  for (const p of pieces(top).filter(p => ruleCount(p))) {
    const last = out[out.length - 1];
    if (last && last.rules + ruleCount(p) <= BATCH_RULES) { last.nodes.push(...p); last.rules += ruleCount(p); }
    else out.push({ nodes: [...p], rules: ruleCount(p) });
  }
  for (const b of out) {
    const inside = new Set(b.nodes);
    b.context = [];
    for (const n of b.nodes) for (const a of T.pathOf(n).slice(0, -1)) if (!inside.has(a) && !b.context.includes(a)) b.context.push(a);
    b.context.sort((x, y) => x.id < y.id ? -1 : 1);
  }
  return out;
}

function buildPrompt(root, times, files, batch, lang = 'zh') {
  if (lang !== 'zh') return `You are checking the rules of a project. Rules are grouped by requirement. Each requirement covers a set of files, and when those files are edited its rules and its parents' rules are handed to the AI doing the work.
Find the three kinds of problems below. Where you can fix one, give the fix (change only rules of requirements not marked PARENT; PARENT ones are for comparison only):
1. Duplicate: two rules say the same thing (rewording counts). Remove one, or merge them (reword the one you keep). Within one requirement keep the later one; when a child repeats its parent, remove the child's.
2. Contradiction: two rules ask for opposite things and will be delivered together (same requirement, parent and child, or requirements with overlapping paths). The later one wins (use the dates; without dates, the one written lower in the same requirement is later). Remove or reword the earlier one. A deliberate exception a child makes to its parent is not a contradiction.
3. Outdated: the rule is about something that no longer exists (a file marked "not found in the project"), or it reads like progress or a plan rather than a requirement that holds from now on. Remove it. If it only names a file that has been renamed, reword it with the new name (only when you are sure of the new name).
Rules that start with "Decision:" were decided by the user: never remove or reword them. When one conflicts with another rule, change the other one; if unsure, put it in "ask" for the user to decide.
Do not change anything you are not sure about; put it in "ask". Do not reword rules just to improve the wording. Write every "why" and rewritten rule in the language the rules use.

Rules:
${listing(times, files, batch.nodes, batch.context, lang)}

Output JSON only, no other text; output empty arrays when there is nothing to fix:
{"fixes":[{"op":"remove","rule":"R1#3","why":"duplicate of R1#5"},{"op":"replace","rule":"R2#1","text":"the reworded rule","why":"merged R2#4"}],"ask":[{"rules":["R1#2","R3#1"],"why":"one says ..., the other says ..., unclear which wins"}]}`;
  return `你在给一个项目的规则做体检。规则按需求分组，每个需求管一批文件，改到这些文件时它和它上级的规则会一起交给干活的 AI。
找出下面三类问题，能改的直接给出改法（只改没标「上级」的需求里的规则；标了「上级」的只用来对照）：
1. 重复：两条说的是同一件事（换了说法也算）。删掉一条，或者合成一条（改写留下的那条）。同一个需求里留后写的；下级重复上级的删下级的。
2. 矛盾：两条要求互相打架，而且会一起送到（同一个需求、上下级、或范围有重叠的需求）。以后写的为准（看日期；没日期的，同一个需求里写在后面的是后写的），删掉或改写先写的那条。下级有意对上级做的例外不算矛盾。
3. 过时：规则说的东西已经不在了（后面标了「项目里找不到」的文件），或者读着是进度、计划而不是以后都要守的要求。删掉。只是提到文件名、而文件改了名的，改写成新名字（只在你确定新名字时）。
以「决定：」开头的规则是用户拍板的：不许删、不许改写；它和别的规则冲突时，改别的那条；拿不准就写进 ask 让用户定。
没有把握的不要改，写进 ask。不要为了措辞好看改写规则。

规则：
${listing(times, files, batch.nodes, batch.context, lang)}

只输出 JSON，不要别的文字；没有问题就输出空数组：
{"fixes":[{"op":"remove","rule":"R1#3","why":"和 R1#5 重复"},{"op":"replace","rule":"R2#1","text":"改写后的规则","why":"合并了 R2#4"}],"ask":[{"rules":["R1#2","R3#1"],"why":"一个说……，一个说……，不知道以哪个为准"}]}`;
}

// CLAUDE.md 每次会话全文加载；项目规矩只该记在规则树里。找出 CLAUDE.md 里规则树已经有的规矩（只提示，不改任何文件）
const CLAUDE_MD = 'CLAUDE.md';
const CLAUDE_MD_MAX = 30000;
function readClaudeMd(dir) {
  try { const s = fs.readFileSync(path.join(dir, CLAUDE_MD), 'utf8').slice(0, CLAUDE_MD_MAX); return s.trim().length > 20 ? s : ''; } catch { return ''; }
}
function treeRules(root) {
  const lines = [];
  for (const n of T.walk(root)) n.rules.forEach((r, i) => lines.push(`${n.id}#${i + 1} ${r.text}`));
  return lines.join('\n');
}
function buildClaudePrompt(root, claudeMd, lang = 'zh') {
  if (lang !== 'zh') return `Below are a project's CLAUDE.md (loaded in full every session) and its rule tree (all rules, each with an id).
Find the rules in CLAUDE.md that a rule in the tree already covers: same meaning, or the tree's version is more complete. List only real duplicates; things that are merely related, or not in the tree, do not count. Do not reword or comment.

CLAUDE.md:
${claudeMd}

Rule tree:
${treeRules(root)}

Output JSON only, no other text; output an empty array when there are no duplicates. "line" is the original sentence from CLAUDE.md (the one that identifies it best, at most 60 characters):
{"dups":[{"line":"...","rule":"R4#2"}]}`;
  return `下面是一个项目的 CLAUDE.md（每次会话都会全文加载）和项目的规则树（所有规则，每条有编号）。
找出 CLAUDE.md 里已经被规则树某条规则覆盖的规矩：意思一样，或规则树里的说得更完整。只列确实重复的，只是相关、规则树里没有的不要列；不要改写、不要评价。

CLAUDE.md：
${claudeMd}

规则树：
${treeRules(root)}

只输出 JSON，不要别的文字；没有重复就输出空数组。line 写 CLAUDE.md 里那句话的原文（取最能认出它的一句，不超过 60 字）：
{"dups":[{"line":"……","rule":"R4#2"}]}`;
}
// 模型的答复 → 提示 [{ k: 'claudeDup', line, rule }]；对不上规则的丢掉
function planClaudeDups(root, out) {
  const seen = new Set();
  return (Array.isArray(out && out.dups) ? out.dups : []).flatMap(d => {
    const line = d && typeof d.line === 'string' ? d.line.trim().slice(0, 80) : '';
    const hit = line && ruleRef(root, d.rule);
    const rule = hit && hit.node.id + '#' + (hit.node.rules.indexOf(hit.rule) + 1);
    if (!rule || seen.has(line)) return [];
    seen.add(line);
    return [{ k: 'claudeDup', line, rule }];
  });
}

// 给规则多的需求分组（只改界面显示）
function buildGroupPrompt(groupNodes, lang = 'zh') {
  if (lang !== 'zh') return `Group the rules of each requirement below (this only changes how they are displayed, not the rules): split each requirement into 2-${Cats.MAX_GROUPS} groups. Group names are one short word of at most 8 letters (for example: Style, Writing, Flow), in the language the rules use, and the same meaning gets the same name across the whole project. Put every rule in one group; in "rules" write only the number (which rule in the requirement, counting from 1). Requirements to group: ${groupNodes.map(n => n.id).join(', ')}.

${groupNodes.map(n => `${n.id} ${n.title}
${n.rules.map((r, i) => `  ${i + 1}. ${r.text}`).join('\n')}`).join('\n')}

Output JSON only, no other text:
{"categories":[{"node":"R1","groups":[{"name":"Writing","rules":[1,2,5]}]}]}`;
  return `给下面每个需求的规则分组（只改界面显示，不改规则）：每个需求分 2–${Cats.MAX_GROUPS} 组，组名 2–4 个字（例：画风、写作、互动、工作流），用规则的语言，同一个意思全项目用同一个组名；每条规则都放进一组，rules 里只写序号（需求里第几条，从 1 起）。要分组的：${groupNodes.map(n => n.id).join('、')}。

${groupNodes.map(n => `${n.id} ${n.title}
${n.rules.map((r, i) => `  ${i + 1}. ${r.text}`).join('\n')}`).join('\n')}

只输出 JSON，不要别的文字：
{"categories":[{"node":"R1","groups":[{"name":"写作","rules":[1,2,5]}]}]}`;
}

// 规则 R1#3 → { node, rule }
function ruleRef(root, ref) {
  const m = String(ref || '').match(/^\s*(\S+?)#(\d+)\s*$/);
  const n = m && T.findById(root, m[1]);
  const r = n && n.rules[Number(m[2]) - 1];
  return r ? { node: n, rule: r } : null;
}

// 模型的答复 → 编辑操作；碰「决定：」的、对不上的不做（前者进 ask）；allowed（需求编号的集合）：只改这些需求里的规则。返回 { ops, ask }
function planFixes(root, out, allowed = null) {
  const ops = [], ask = [];
  const used = new Set();
  for (const f of Array.isArray(out && out.fixes) ? out.fixes : []) {
    const hit = f && ruleRef(root, f.rule);
    if (!hit || used.has(hit.rule) || (allowed && !allowed.has(hit.node.id))) continue;
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
const md5 = x => crypto.createHash('md5').update(x).digest('hex');
// 需求的指纹：它和它上级的范围、规则（上级变了，下级也要重新看）；分组只看它自己的规则
const nodeFp = n => md5(T.pathOf(n).map(a => a.files.join(',') + '\n' + a.rules.map(r => r.text).join('\n')).join('\0'));
const groupFp = n => md5(n.rules.map(r => r.text).join('\n'));

// 最多 limit 个同时跑，结果按原顺序
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

// 调用一次模型：超时就用 1.5 倍的时间再试一次。返回 { out } 或 { error }
async function callModel(job, ask) {
  try {
    if (ask) return { out: await ask(job.prompt) };
    const M = require('./model');
    const ms = M.timeoutFor(job.rules);
    try { return { out: await M.askJson(job.prompt, { timeoutMs: ms }) }; }
    catch (e) {
      if (!(e && e.t && e.t.k === 'm.timeout')) throw e;
      return { out: await M.askJson(job.prompt, { timeoutMs: Math.round(ms * 1.5) }) };
    }
  } catch (error) { return { error }; }
}

// 这次体检要问模型的活：[{ kind, nodes, rules, prompt }]，不写任何文件。runCheckup 用它，插件也用它（bin 的 --jobs）：
// 插件在另一个进程里体检，自己调用不了 $.model.complete，所以先取提示词、问完再把答案交回来。
// 返回的数组上另挂 ctx（root、旧记录等，runCheckup 接着用）
function planJobs(dir, { full = false, lang } = {}) {
  lang = lang || require('./lang').detectLang(dir, 'en');
  const files = require('./files').listFiles(dir);
  const root = store.readTree(dir);
  const old = store.readJson(store.metaFile(dir, SEEN), {});
  const seenN = (!full && old.nodes) || {}, seenG = (!full && old.groups) || {};
  const times = ruleTimes(dir), cats = Cats.read(dir);
  const regroup = new Set([...T.walk(root)].filter(n => seenG[n.id] !== groupFp(n)).map(n => n.id));
  const groupNodes = new Set(Cats.needGroups(root, cats, full ? null : regroup));
  const jobs = [];
  for (const b of batches(root)) {
    if (full || !b.nodes.every(n => seenN[n.id] === nodeFp(n))) jobs.push({ kind: 'check', batch: b, nodes: b.nodes, rules: b.rules + ruleCount(b.context), prompt: buildPrompt(root, times, files, b, lang) });
    const gn = b.nodes.filter(n => groupNodes.has(n));
    if (gn.length) jobs.push({ kind: 'group', nodes: gn, rules: ruleCount(gn), prompt: buildGroupPrompt(gn, lang) });
  }
  const claudeMd = readClaudeMd(dir);
  const claudeFp = claudeMd && md5(claudeMd + '\0' + treeRules(root));
  let claudeOld = null;
  if (claudeMd && !full && old.claudeFp === claudeFp) claudeOld = old.claudeDups || []; // 都没变：沿用上次的结果
  else if (claudeMd) jobs.push({ kind: 'claude', nodes: [], rules: ruleCount([...T.walk(root)]), prompt: buildClaudePrompt(root, claudeMd, lang) });
  Object.defineProperty(jobs, 'ctx', { value: { root, old, seenN, seenG, claudeMd, claudeFp, claudeOld } });
  return jobs;
}

// 插件把问好的答案交回来（[{ prompt, text }]）→ runCheckup 的 ask：按提示词原文找答案。
// 找不到（规则在两次调用之间变了，或这一块没问成）就抛错，那一块算没问成、下次重问
function answerLookup(answers, lang = 'en') {
  const byPrompt = new Map((Array.isArray(answers) ? answers : []).filter(a => a && typeof a.prompt === 'string').map(a => [a.prompt, a.text]));
  const M = require('./model');
  return async prompt => {
    if (!byPrompt.has(prompt) || byPrompt.get(prompt) == null) throw M.fail(STRINGS.make(lang)('m.noAnswer'), 'm.noAnswer');
    return M.parseAnswer(byPrompt.get(prompt));
  };
}

// 跑一次体检。opts：model（false 只用程序查）、ask（换掉调用模型的函数，测试用）、T（报告用哪种语言的文字表）、full（规则没变也问模型）
// 返回 { notes, applied, ask, categorized, skippedModel, failed, error, report, entry }
// failed：[{ ids, group, error }] 没问成的块；error：所有检查都没问成时的第一个错误
async function runCheckup(dir, { model = true, ask, T: tr, full = false } = {}) {
  // 提示词和改动记录的来源是写进项目的东西，跟项目的语言走；tr 只管报告这段给人看的话（VS Code 按界面语言传）。
  // 中文规则的项目开在英文界面的 VS Code 里，提示词还是中文、来源还是「体检」。项目看不出语言时才用 tr 的语言
  const lang = require('./lang').detectLang(dir, (tr && tr.lang) || 'en');
  const t = tr ? make(tr) : STRINGS.make(lang);
  const files = require('./files').listFiles(dir);
  const res = { notes: programChecks(dir, { files }), applied: [], ask: [], categorized: [], skippedModel: false, failed: [], error: null, entry: null };
  const ops = duplicateOps(store.readTree(dir));
  let seen = null, dups = null;
  if (model) {
    const jobs = planJobs(dir, { full, lang });
    const { root, old, seenN, seenG, claudeMd, claudeFp, claudeOld } = jobs.ctx;
    if (claudeOld) res.notes.push(...claudeOld);
    res.skippedModel = !jobs.length;
    const results = await pool(jobs, JOBS, job => callModel(job, ask));
    const mine = new Set(ops.map(opKey));
    seen = { nodes: {}, groups: {} };
    const ids = new Set([...T.walk(root)].map(n => n.id));
    for (const [id, v] of Object.entries(seenN)) if (ids.has(id)) seen.nodes[id] = v;
    for (const [id, v] of Object.entries(seenG)) if (ids.has(id)) seen.groups[id] = v;
    const okNodes = [];
    jobs.forEach((job, i) => {
      const r = results[i];
      const nodeIds = job.nodes.map(n => n.id);
      if (job.kind === 'claude') {
        if (r.error) res.failed.push({ ids: [CLAUDE_MD], group: false, claude: true, error: r.error });
        else { dups = planClaudeDups(root, r.out); res.notes.push(...dups); }
      } else if (r.error) {
        res.failed.push({ ids: nodeIds, group: job.kind === 'group', error: r.error });
        if (job.kind === 'check') nodeIds.forEach(id => { delete seen.nodes[id]; });
        else nodeIds.forEach(id => { delete seen.groups[id]; });
      } else if (job.kind === 'check') {
        const plan = planFixes(root, r.out, new Set(nodeIds));
        ops.push(...plan.ops.filter(o => !mine.has(opKey(o)) && mine.add(opKey(o))));
        res.ask.push(...plan.ask);
        okNodes.push(...nodeIds);
      } else {
        res.categorized.push(...Cats.save(dir, root, r.out && r.out.categories));
        job.nodes.forEach(n => { seen.groups[n.id] = groupFp(n); });
      }
    });
    const checks = jobs.filter(j => j.kind === 'check');
    const failedChecks = res.failed.filter(f => !f.group && !f.claude);
    if (checks.length && failedChecks.length === checks.length) res.error = failedChecks[0].error;
    seen.okNodes = okNodes;
    if (claudeMd && old.claudeFp === claudeFp && !full) { seen.claudeFp = claudeFp; seen.claudeDups = old.claudeDups; }
    else if (dups) seen.claudeDups = dups;
  }
  if (ops.length) {
    const why = new Map(ops.map(o => [opKey(o), o.why]));
    const done = await store.commitAsync(dir, ops.map(({ why: _, ...o }) => o), { source: lang === 'zh' ? '体检' : 'Checkup' });
    res.applied = done.map(o => ({ ...o, why: why.get(opKey(o)) || '' }));
    res.entry = done.entry;
  }
  // 记下这次看过的需求（改完之后的样子）：下次没变就不再问模型。没问成的块不记，下次重问
  if (seen && !res.skippedModel) {
    const after = store.readTree(dir);
    for (const id of seen.okNodes) { const n = T.findById(after, id); if (n) seen.nodes[id] = nodeFp(n); }
    delete seen.okNodes;
    if (dups) seen.claudeFp = md5(readClaudeMd(dir) + '\0' + treeRules(after)); // 改完之后的样子；没问成就不记，下次重问
    try { store.writeJson(store.metaFile(dir, SEEN), { ...seen, time: Date.now() }); } catch {}
  }
  res.report = report(res, t);
  try { store.atomicWrite(store.metaFile(dir, REPORT), res.report); } catch {}
  return res;
}

function report(res, t) {
  // 模型出错的话：有结构化的 t 就按报告的语言写，没有就用 message
  const errText = e => (e && e.t && e.t.k ? t(e.t.k, ...(e.t.a || [])) : e && e.message);
  const whyText = w => (w && typeof w === 'object' ? t(w.k, ...(w.a || [])) : w || '');
  const one = o => (o.op === 'replace_rule' ? t('ck.replaced', o.node, o.old, o.text) : t('ck.removed', o.node, o.text)) + (whyText(o.why) ? `（${whyText(o.why)}）` : '');
  const out = [`# ${t('ck.title')}`, '', new Date().toLocaleString(), '', t('ck.summary', res.applied.length, res.ask.length, res.notes.length), ''];
  if (res.error) out.push(t('ck.modelFail', errText(res.error)), '');
  else for (const f of res.failed) out.push(t('ck.partFail', f.ids.map(id => id + (f.group ? t('ck.groupTag') : '')).join('、'), errText(f.error)), '');
  if (res.skippedModel) out.push(t('ck.sameRules'), '');
  if (res.ask.length) out.push(`## ${t('ck.askHead')}`, '', ...res.ask.map(a => `- ${a.rules.map((r, i) => `${r}「${a.texts[i]}」`).join(' / ')}${a.why ? `：${a.why}` : ''}`), '');
  if (res.notes.length) out.push(`## ${t('ck.notesHead')}`, '', ...res.notes.map(n => `- ${noteText(n, t)}`), '');
  if (res.applied.length) out.push(`## ${t('ck.doneHead')}`, '', ...res.applied.map(o => `- ${one(o)}`), '', t('ck.undoTip'), '');
  if (res.categorized.length) out.push(t('ck.grouped', res.categorized.join('、')), '');
  if (!res.applied.length && !res.ask.length && !res.notes.length && !res.error && !res.failed.length) out.push(t('ck.none'), '');
  return out.join('\n');
}

module.exports = { planJobs, answerLookup, programChecks, noteText, duplicateOps, goneMentions, buildPrompt, buildGroupPrompt, batches, planFixes, runCheckup, ruleTimes, REPORT, MANY_RULES };
