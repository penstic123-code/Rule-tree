'use strict';
// 体检：用户点「需求树：体检」或运行 reqtree check --fix 时做。设计见 docs/design-info-architecture.md 第六节。
// 照记录员的做法：都直接改（记成「体检」的一条改动，面板上可以撤销），拿不准的不动；问不问由 Q.decide 定（只有要改掉「决定：」才问）。
// 1. 确定的，直接改（不调用模型）：同一个需求里几乎一样的规则（Dice ≥ 0.7）、同一个需求里同键的规则，
//    留写在后面的那条（以最新为准），前面的删掉；下级重复了上级已有的规则，删下级那条
// 2. 标着 🔨 很久没动的需求，变成问题（不调用模型）
// 3. 要判断的交给模型（只在用户主动体检时调用）：规则冲突、几个需求都有的同一条该不该提到上级、规则多的需求怎么分组
//    。模型给出默认做法和有没有把握（sure）：有把握的直接做，没把握的不动；只有要改掉「决定：」才问（Q.decide）
// 4. 设置 reqtree.memoryMode 为 dedupe（默认，「分工」）时，Claude Code 自动记忆逐份按分工判断（同一次模型调用）：
//    分工：需求树和 CLAUDE.md 管这个项目应该是什么样、该怎么做；自动记忆只记和项目内容无关的事（用户本人、工具和环境、私人信息、外部资源）。
//    已经写在树里的删掉、是项目规则的搬进树、过时的删掉（删前备份，可撤销）；和树冲突的按后写的为准，判断不了按树
// 5. 文档（CLAUDE.md、AGENTS.md、需求挂的文档）：和树重复的规则从文档里删掉，该搬进树的搬进去再从文档里删掉（只删找得准的整行，
//    先备份，可撤销）；挂在某需求下、和它的规则冲突的，按树改文档
// 5½. 信息架构（src/structure.js，不调用模型）：没有需求的内容文件夹建需求、没挂文档的需求挂上说明文档、按章的子需求挂讲这一章的那一节
// 6. 不调用模型的提醒：有规则、却永远不会加载的需求（自己和上级都没有文件对应）；文件对应一个文件也匹配不到的需求改成待定
const fs = require('fs');
const path = require('path');
const store = require('./store');
const Q = require('./questions');
const Docs = require('./docs');
const RC = require('./rulecheck');
const { parse, walk, sameMeaning, findById, norm, globToRegExp } = require('./parser');
const { isRoot } = require('./common');

// 体检的问题里，选项只能做这几种改动
const CHECK_OPS = new Set(['add_rule', 'replace_rule', 'remove_rule', 'override_rule']);
const MAX_CHECK_QUESTIONS = 8;

// 同一个需求里的重复：从后往前看，前面的规则和后面某条是同一件事就删掉前面的。
// 同一件事：同一个键；或者意思一样（parser.sameMeaning：几乎一样，数字、否定词也一样）、键不冲突（都没键，或者前面那条没键）。
// 前面那条有键、后面那条没键的不动：删掉有键的那条，下级覆盖它的规则就对不上了，交给模型问
function duplicateOps(text) {
  const ops = [];
  for (const n of walk(parse(text))) {
    const kept = [];
    for (let i = n.rules.length - 1; i >= 0; i--) {
      const r = n.rules[i];
      const later = kept.find(k => (r.key && k.key === r.key) || (!r.key && sameMeaning(r.text, k.text)));
      if (later) ops.push({ op: 'remove_rule', node: n.id, text: r.text, why: later.text });
      else kept.push(r);
    }
    // 下级重复了上级已有的规则（都没键）：上级那条在下级的文件上本来就生效，删下级的。
    // 只在上级的范围确实罩住下级时删：上级是全局的，或者下级的每个 glob 都落在上级某个「文件夹/**」里
    if (!n.parent || !n.id) continue;
    for (const r of kept) {
      if (r.key || ops.some(o => o.node === n.id && o.text === r.text)) continue;
      for (let p = n.parent; p && p.parent; p = p.parent) {
        const hit = p.rules.find(x => !x.key && sameMeaning(x.text, r.text));
        if (hit && require('./compile').covers(p, n)) { ops.push({ op: 'remove_rule', node: n.id, text: r.text, why: `${p.id}：${hit.text}` }); break; }
      }
    }
  }
  return ops;
}

const CLAUDE_MD_CHARS = 8000;
const clipChars = (s, max) => { const a = [...s]; return a.length > max ? a.slice(0, max).join('') + '…（截断）' : s; };

// 自动删之前再核对一次：记忆里至少有一句和「已经有了」的那处（需求和它下面的规则，或 CLAUDE.md）字面上相近（Dice ≥ 0.5）。
// 模型说重复、字面上却对不上的，改成问用户，不直接删
const sentences = s => String(s).split(/[\n。；;！!？?]+/).map(t => t.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim()).filter(t => [...t].length >= 4);
function looksCovered(note, targets) {
  const { similarity } = require('./parser');
  return sentences(note.body).some(a => targets.some(b => similarity(a, b) >= 0.5));
}

const MEMORY_TASK = `另外逐份看自动记忆，每份在 memory 里写一项。分工：需求树和 CLAUDE.md 管这个项目应该是什么样、该怎么做（包括某门课、某块内容的规则和做法、开几个 agent）；自动记忆只该记和项目内容无关的事：用户本人的情况、工具和电脑环境、私人信息（服务器、账号）、外部资源在哪。kind 选一种：
- covered：整份说的事，需求树或 CLAUDE.md 里都已经有了（措辞不同也算）。where 写需求 ID，或 "CLAUDE.md"。
- move：里面有这个项目的规则，需求树和 CLAUDE.md 里都还没有。node 写该挂的需求 ID（管辖范围最小的那个），rules 是要加的规则（1–5 条，每条一句简短具体的中文，照记忆的意思，不扩写）；整份都是这类规则时 whole 为 true，还混着别的内容时为 false。
- 例外不算冲突：记忆说树里某条规则在某一类、某种情况下不适用（「云除外」「这一章例外」），写成 move，rules 写「例外：……」，加在那条规则所在的需求（或更窄的需求）下。
- conflict：和需求树里某条规则说的是同一件事，说法却不一样。node 是需求 ID，rule 是树里原文，text 是照记忆的说法写成的一条规则，newer 写 "memory" 或 "tree"（比记忆的更新日期和那条规则定下的日期、看哪边和正在做的需求一致，判断哪边是后来的决定；判断不了写 "tree"，按需求树处理），whole 同上。
- stale：过时的进度，或已经做完、放弃的计划（比如树里那个需求已经 ✅ 或已经删了）。why 用一句话说为什么。
- doc：不是规则，是这个项目某门课、某块内容的经验、进度或背景（踩过的坑、做到哪了、为什么这么定）。这类该写进那个需求挂的背景文档（需求下的「> 文档：」），不该在记忆里。node 写需求 ID。
- keep：属于自动记忆该记的事，或者拿不准。
先用记忆的更新日期、规则定下的日期和正在做的需求判断，真看不出来才加 sure：false（就先不动它）；不写就是有把握，会直接处理（删记忆前有备份，用户可以撤销）。
`;

// 文档：需求下「> 文档：」挂的，加上项目根的 CLAUDE.md、AGENTS.md（它们每次全文加载，最该精简）。
// 不管哪种项目，规则（以后都要照做的要求）只该在需求树里；文档放参考资料：架构、接口、进度、章节表、决策的来由、踩过的坑
const DOC_TASK = `另外逐份看文档。分工：规则（以后都要照做的要求）只该写在需求树里；文档只放参考资料（架构、接口、进度、章节表、某个决定的来由、经验）。CLAUDE.md、AGENTS.md 每次都全文加载，最好只留"东西在哪"这类说明。文档里每处写成规则的地方，在 docs 里写一项（只是参考资料的不写）：
- dup：需求树里已经有同一条（措辞不同也算）。doc 是文档名（照下面每段标题里的写），text 是文档里那一整行的原文（去掉列表符号，能在文档里原样搜到；只是表格里的一格、长句里的半句的不写），node 是树里那条所在的需求 ID。
- move：需求树里还没有的长期规则。doc、text 同上，node 写该挂的需求 ID（管辖范围最小的那个；挂在某个需求下的文档，只能挂在那个需求或它下面；项目根的 CLAUDE.md、AGENTS.md 里管全项目的写顶层需求），rule 是照文档意思写成的一条简短规则。
- stale：文档挂在某个需求下（下面每段标题里写着挂在哪），里面的说法和这个需求自己的规则冲突。需求树是最新的，文档要跟着改。text 是文档里要换掉的原文（几个字到一句，能在文档里原样搜到），new 是照规则改好的文字（只替换 text 这一段，格式和语言跟文档一致；text 里和这条规则无关的说法原样留在 new 里，例：原文「不说话，不加戏份」，规则说点击可以说话 → new「点击可以让它说话，不加戏份」），node 是需求 ID，rule 是树里那条原文。全项目的规范文档和某个需求说法不同，是那个需求的例外，不写。
- clash：这一批里的两份文档对同一件事说法互相矛盾（一份只是更具体、或者是有意的例外，不算）。doc、text 是一份的文档名和原文（几个字到一句，能原样搜到），other、otherText 是另一份的；new 是把 text 照 otherText 的说法改好的文字，otherNew 是把 otherText 照 text 的说法改好的文字（都只替换那一段，无关的说法原样留）。程序按两份文档谁后改的定以哪边为准。标着「这次没改过，只拿来和别的文档对比」的文档，只用来查 clash，不要为它写 dup、move、stale。
dup、move、stale 和 clash 会直接处理：规则进树，文档里那一行删掉、那一段改掉（用户可以撤销）。所以 text 要是文档里完整的一行（去掉列表符号；stale、clash 的可以是一段），只是参考资料、说明来由的句子不要写进来。
每段文档最多 15 项，拿不准的不写。
`;

// 一份文档的正文。AGENTS.md 里需求树自己生成的那段去掉（不然全是「重复」）
function docText(projectDir, rel) {
  let s = fs.readFileSync(Docs.resolve(projectDir, rel), 'utf8');
  if (/^agents(\.override)?\.md$/i.test(path.basename(rel))) try { s = require('./targets/codex').removeBlock(s); } catch {}
  return s;
}

// 要查的文档：[{ name, node }]。挂了的文档 + 项目根的 CLAUDE.md、AGENTS.md
function docList(root, projectDir) {
  const out = [], seen = new Set(), cache = new Map();
  // 程序运行时读的 .md、备份文件夹里的旧文档，就算挂上了也不看、不改、不从里面搬规则（见 docs.isProgramData、structure.isBackup）
  const { isBackup } = require('./structure');
  const add = (name, node) => { const k = name.replace(/\\/g, '/'); if (!seen.has(k) && !isBackup(k) && Docs.exists(projectDir, k) && !Docs.isProgramData(projectDir, k, cache)) { seen.add(k); out.push({ name: k, node }); } };
  for (const f of ['CLAUDE.md', '.claude/CLAUDE.md', 'AGENTS.md']) add(f, null);
  // 只挂了一节的，体检照样看整份（重复、该搬的规则可能在别的节里）
  for (const n of walk(root)) for (const d of n.docs) add(Docs.splitRef(d).file, n.id);
  return out;
}

// 本地检查（不调用模型）：挂的文档不存在；需求的文件夹里有 .md、这个需求却一份文档都没挂（只看「文件夹/**」这种范围的第一层）
const NOT_DOCS = /^(readme|changelog|license|licence|contributing|claude|agents)\b/i;
function docProblems(text, projectDir, treePath) {
  const root = parse(text);
  const linked = new Set(), docMissing = [], docUnlinked = [], docNoToc = [], dataCache = new Map();
  for (const n of walk(root)) for (const d of n.docs) {
    const { file, section } = Docs.splitRef(d);
    linked.add(file.replace(/\\/g, '/'));
    if (!Docs.exists(projectDir, d)) { docMissing.push({ node: n.id, doc: d }); continue; }
    // 很长却没有分节标题：没法按节读，AI 每次都整份读。加几个 ## 标题就行（不替你拆、不改写）
    if (!section && !linked.has('toc:' + file)) {
      linked.add('toc:' + file);
      let t = '';
      try { t = fs.readFileSync(Docs.resolve(projectDir, d), 'utf8'); } catch {}
      if ([...t].length > Docs.LONG_CHARS * 2 && !Docs.toc(t)) docNoToc.push({ node: n.id, doc: file, chars: [...t].length });
    }
    // 只挂一节，节名在文档里找不到了（标题改过名）：AI 会退回读整份，提醒改节名
    if (section) {
      let t = '';
      try { t = fs.readFileSync(Docs.resolve(projectDir, d), 'utf8'); } catch {}
      if (!Docs.findSection(t, section)) docMissing.push({ node: n.id, doc: d });
    }
  }
  const treeName = treePath ? path.basename(treePath) : '';
  // 已经挂了文档的需求不再提醒其余的 .md（那是有意只挂入口文档，比如子任务简报、样例不用 AI 每次先读）
  for (const n of walk(root)) {
    if (!n.id || n.docs.length) continue;
    for (const g of n.files) {
      const m = g.match(/^([^*?{}[\]]+)\/\*\*$/);
      if (!m) continue;
      let ents = [];
      try { ents = fs.readdirSync(path.join(projectDir, m[1]), { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (!e.isFile() || !/\.md$/i.test(e.name) || NOT_DOCS.test(e.name) || e.name === treeName) continue;
        const rel = `${m[1]}/${e.name}`;
        if (!linked.has(rel) && !Docs.isProgramData(projectDir, rel, dataCache)) { linked.add(rel); docUnlinked.push({ node: n.id, title: n.title, doc: rel }); }
      }
    }
  }
  return { docMissing, docUnlinked, docNoToc };
}

// 模型对文档的判断 → { dup 文档里和树重复的（ops 是从文档删掉那一行）, questions 该搬进树的（问不问由 Q.decide 定，一般直接搬）,
//   stale 挂在某需求下、和它的规则冲突的（按树改文档）, conflicts 留给调用方放「改不成的」 }。
// 文档、需求、规则对不上的丢掉。删文档的一行先备份，可撤销；找不准那一行就不删（见 docs.removeDocText），只在报告里提醒
const MAX_DOC_QUESTIONS = 15;
const oneLine = s => (typeof s === 'string' ? s.replace(/[\r\n]+/g, ' ').trim() : '');
// refs：只拿来对比的旧文档（这次没改过），只认它和别的文档的矛盾（clash），不从里面找规则
function docPlan(items, { text, shown, refs = new Set(), asked, count = 0 }) {
  const root = parse(text);
  const dup = [], questions = [], conflicts = [], stale = [], clash = [];
  const docName = s => oneLine(s).replace(/(（第\s*\d+\s*\/\s*\d+\s*段）|（挂在[^）]*）|（项目根[^）]*）)+$/, '').trim();
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it !== 'object') continue;
    const doc = docName(it.doc), said = oneLine(it.text);
    // 两份文档说法矛盾：两边的原文和照对方改好的文字都要有，两份都给模型看过；按谁后改的定（调用方做）
    if (it.kind === 'clash') {
      const other = docName(it.other), otherSaid = oneLine(it.otherText), a = oneLine(it.new), b = oneLine(it.otherNew);
      const seenBy = f => shown.has(f) || refs.has(f);
      if (seenBy(doc) && seenBy(other) && (shown.has(doc) || shown.has(other)) && doc !== other && said && otherSaid && a && b && a !== said && b !== otherSaid) clash.push({ doc, text: said, new: a, other, otherText: otherSaid, otherNew: b });
      else log(`体检：模型说的文档矛盾对不上，丢掉：${JSON.stringify(it)}`);
      continue;
    }
    let node = typeof it.node === 'string' ? findById(root, it.node.trim()) : null;
    // 挂在某个需求下的文档，只在改这个需求的文件时才送到 AI 手上：里面的规则搬进树，只能挂在这个需求或它下面，
    // 往上挂（尤其挂到最顶上）等于把它变成全局规则（2026-10-25 副本上从课程文档搬了 67 条，有的挂到了根上）
    const holders = [...walk(root)].filter(n => n.id && n.docs.some(d => Docs.splitRef(d).file.replace(/\\/g, '/') === doc));
    if (node && it.kind === 'move' && holders.length && !holders.some(h => h === node || require('./parser').pathOf(node).includes(h))) node = holders[holders.length - 1];
    if (!shown.has(doc) || !said || !node) { log(`体检：模型说的文档项对不上，丢掉：${JSON.stringify(it)}`); continue; }
    const del = { op: 'doc_remove', file: doc, text: said };
    if (it.kind === 'dup') { dup.push({ doc, text: said, node: node.id, ops: [del] }); continue; }
    // 文档挂在这个需求下、说法和这个需求自己的规则冲突：按树改文档那几个字。只认挂在同一个需求下的文档、树里真有那条规则
    // （全项目的规范文档和某门课说法不同，是那门课的例外，不改）。2026-10-25：C7 规则改成中英双语，挂的 course-rules.md 还写着 English only
    if (it.kind === 'stale') {
      const rule = oneLine(it.rule), now = typeof it.new === 'string' ? it.new.replace(/[\r\n]+/g, ' ').trim() : '';
      const own = node.docs.map(d => Docs.splitRef(d).file.replace(/\\/g, '/')).includes(doc);
      const hit = rule && (node.rules.find(r => r.text === rule) || node.rules.find(r => norm(r.text) === norm(rule)));
      if (own && hit && now && now !== said) stale.push({ doc, text: said, new: now, node: node.id, rule: hit.text, ops: [{ op: 'doc_replace', file: doc, text: said, new: now }] });
      else log(`体检：模型说的文档过时项对不上，丢掉：${JSON.stringify(it)}`);
      continue;
    }
    if (count + questions.length >= MAX_DOC_QUESTIONS) continue;
    const key = `doc|${doc}|${norm(said)}`;
    if (asked.has(key)) continue;
    const rule = oneLine(it.rule);
    let q = null;
    if (it.kind === 'move' && rule && rule.length <= 200) {
      q = {
        text: `${doc} 里有一条需求树还没有的规则：「${rule}」。搬进需求树（${node.id}），再从文档里删掉吗？`,
        t: { k: 'q.docMove', a: [doc, rule, node.id] },
        options: [
          { label: `搬进 ${node.id}`, t: { k: 'q.optAddTo', a: [node.id] }, ops: [{ op: 'add_rule', node: node.id, text: rule }, del] },
          { label: '留在文档', t: { k: 'q.optKeepDoc', a: [] }, ops: [] },
        ],
        default: 0,
      };
    }
    if (q) { asked.add(key); questions.push({ source: '体检', kind: 'doc', memKey: key, doc, docText: said, node: node.id, ...q }); }
  }
  return { dup, questions, conflicts, stale, clash };
}

// ---------- 分批 ----------
// 记忆和文档可能有十几万字，一次塞不下：切成段，装成几批，每批调用一次模型（需求树每批都带）。
// 每份都会被看到；单份太长就切成几段，每段单独看（被切开的记忆不自动删，改成问）。
// 只查上次体检之后改过的（.reqtree/checkup-seen.json 记着每份的指纹），选「全部重查」时不管这个
const BATCH_CHARS = 30000;
const PIECE_CHARS = 12000;
const SEEN_FILE = 'checkup-seen.json';
// 体检一批内容多，每次调用等得比记录员久
const CHECK_TIMEOUT_MS = +process.env.REQTREE_CHECK_TIMEOUT_MS || 300000;
// 同时问模型的批数：大项目十几批一批批等要半小时以上
const CHECK_PARALLEL = 3;
const crypto = require('crypto');
const fingerprint = s => crypto.createHash('md5').update(s).digest('hex');
// 指纹记的可能是一个，也可能是几个（文档改前改后）
const wasSeen = (seen, k, body) => [].concat(seen[k] || []).includes(fingerprint(body));
const readSeen = treePath => { try { return JSON.parse(fs.readFileSync(store.metaFile(treePath, SEEN_FILE), 'utf8')) || {}; } catch { return {}; } };

function pieces(s) {
  const a = [...s], out = [];
  for (let i = 0; i < a.length; i += PIECE_CHARS) out.push(a.slice(i, i + PIECE_CHARS).join(''));
  return out.length ? out : [''];
}

// 这次要查什么、分几批。parts：{ rules, memory, docs }；full：全部重查
// 返回 { notes 要查的记忆, docs 要查的文档 [{ name, node, text }], batches [[段]], calls 调用几次模型, memDir }
function checkPlan(treePath, { read, parts = {}, full = false, memory } = {}) {
  const mem = require('./memory');
  const readText = read || (p => fs.readFileSync(p, 'utf8'));
  const projectDir = path.dirname(treePath);
  const text = readText(treePath);
  const seen = full ? {} : readSeen(treePath);
  let memDir = null;
  if (parts.memory !== false && memory !== false) try { memDir = typeof memory === 'string' ? memory : mem.memoryDir(projectDir); } catch {}
  const notes = [];
  if (memDir) for (const m of mem.readNotes(memDir)) {
    const body = [m.description, m.body].filter(Boolean).join('\n');
    if (wasSeen(seen, `mem:${m.file}`, body)) continue;
    notes.push({ ...m, full: body });
  }
  const root = parse(text);
  const docs = [], unchanged = [];
  if (parts.docs !== false) for (const d of docList(root, projectDir)) {
    let body = '';
    try { body = docText(projectDir, d.name); } catch { continue; }
    if (!body.trim()) continue;
    (wasSeen(seen, `doc:${d.name}`, body) ? unchanged : docs).push({ ...d, text: body });
  }
  const segs = [];
  for (const m of notes) {
    const ps = pieces(m.full);
    ps.forEach((p, i) => segs.push({ kind: 'mem', name: m.file, note: m, part: ps.length > 1 ? [i + 1, ps.length] : null,
      block: `### ${m.file}${ps.length > 1 ? `（第 ${i + 1}/${ps.length} 段）` : ''}（${m.type ? `类型 ${m.type}，` : ''}更新于 ${m.modified}）\n${p}` }));
  }
  // 文档之间说法矛盾，模型只比得到同一批里的（2026-10-25 猪猪进城记 45 份文档分 11–17 批，埋的一对矛盾 3 遍都没查出）：
  // ①按「同一块」（文档挂的需求所在的顶层需求；根上的、CLAUDE.md 算一块）分组，同一组尽量装进同一批；
  // ②改过的文档带上同一条上下级链上挂的、这次本来跳过的旧文档（每份最多 REFS 份、只取第一段），只拿来对比，不从里面找规则
  const REFS = 3;
  const nodeOf = id => (id ? findById(root, id) : null);
  const chain = id => { const n = nodeOf(id); return n ? require('./parser').pathOf(n).filter(x => !isRoot(x)).map(x => x.id) : []; };
  const blockOf = id => chain(id)[0] || '';
  const groups = new Map();
  const put = (key, seg) => { if (!groups.has(key)) groups.set(key, []); groups.get(key).push(seg); };
  for (const d of docs) {
    const ps = pieces(d.text);
    ps.forEach((p, i) => put(blockOf(d.node), { kind: 'doc', name: d.name, part: ps.length > 1 ? [i + 1, ps.length] : null,
      block: `### ${d.name}${ps.length > 1 ? `（第 ${i + 1}/${ps.length} 段）` : ''}${d.node ? `（挂在 ${d.node}）` : '（项目根，每次全文加载）'}\n${p}` }));
    if (!d.node) continue;
    const mine = chain(d.node);
    const refs = unchanged.filter(u => u.node && (mine.includes(u.node) || chain(u.node).includes(d.node))).slice(0, REFS);
    for (const u of refs) {
      const g = groups.get(blockOf(d.node));
      if (g.some(s => s.name === u.name)) continue;
      put(blockOf(d.node), { kind: 'ref', name: u.name, block: `### ${u.name}（挂在 ${u.node}；这次没改过，只拿来和别的文档对比）\n${pieces(u.text)[0]}` });
    }
  }
  const batches = [];
  let cur = [], size = 0;
  const flush = () => { if (cur.some(s => s.kind !== 'ref')) batches.push(cur); cur = []; size = 0; };
  for (const group of [segs, ...groups.values()]) {
    const total = group.reduce((n, s) => n + s.block.length, 0);
    // 一组整个装得下一批、当前这批又装不下它：另起一批，让同一块的文档待在一起
    if (cur.length && total <= BATCH_CHARS && size + total > BATCH_CHARS) flush();
    for (const s of group) {
      if (cur.length && size + s.block.length > BATCH_CHARS) flush();
      cur.push(s); size += s.block.length;
    }
  }
  if (cur.length) flush();
  // 规则：上次体检之后一条都没变就不查（不调用模型）；变了只查变了的（见 src/rulecheck.js）
  const changed = RC.changedRules(text, seen.rules);
  const rulesDue = parts.rules !== false && changed.length > 0;
  // 冲突和分组：只有一批时和它一起查（少调用一次）；不止一批时单独一次，免得第一批比别的都重、先超时
  if (rulesDue && batches.length !== 1) batches.unshift([]);
  return { notes, docs, batches, calls: batches.length, memDir, seen, rulesDue, changed };
}

// conflicts：false 时不找规则冲突（分批体检的后几批、或用户没选「规则」）
// 判断时的参考：正在做的需求、最近 AI 在改哪些需求的文件、用户最近亲口定下的规则（带日期）。
// 用户要的是「除非真的拿不准，都自己定；时间和正在进行的任务是很好的参考」（2026-10-25）
const RECENT_DAYS = 14, RECENT_RULES = 40;
function contextBlock(treePath, text) {
  const day = t => new Date(t).toISOString().slice(0, 10);
  const lines = [];
  const root = parse(text);
  const doing = [...walk(root)].filter(n => n.id && n.status === 'doing').map(n => `${n.id} ${n.title}`);
  if (doing.length) lines.push('标着进行中的需求：' + doing.join('、'));
  let act = [];
  try { act = store.readActivity(treePath, RECENT_DAYS * 864e5); } catch {}
  // 按文件对照现在的树算属于哪个需求（记下的编号可能是重新初始化之前的），取范围最窄的那个
  const { nodesForFile } = require('./parser');
  const owner = new Map();
  const nodeOf = f => { if (!owner.has(f)) owner.set(f, (nodesForFile(root, f).filter(n => n.id).pop() || {}).id || null); return owner.get(f); };
  const last = new Map();
  for (const a of act) { const id = a.file ? nodeOf(a.file) : null; if (id) last.set(id, Math.max(last.get(id) || 0, a.time || 0)); }
  const hot = [...last].sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (hot.length) lines.push(`最近 ${RECENT_DAYS} 天 AI 改过文件的需求（新的在前）：` + hot.map(([id, t]) => `${id}（${day(t)}）`).join('、'));
  const said = [];
  for (const e of store.readChanges(treePath, 500)) {
    if (e.undone || !['记录员', '你'].includes(e.source)) continue;
    for (const o of e.ops) {
      const t = o.op === 'override_rule' ? o.new : (o.op === 'add_rule' || o.op === 'replace_rule') ? o.text : null;
      if (t && said.length < RECENT_RULES) said.push(`- ${day(e.time)} ${o.node}「${clipChars(t, 40)}」`);
    }
  }
  if (said.length) lines.push('用户最近亲口定下的规则（新的在前；没列出的是更早的，或体检、初始化搬进来的）：\n' + said.join('\n'));
  return lines.join('\n');
}

// ruleTask：一起送到的规则、过时的规则、这次只查哪些（src/rulecheck.js 的 promptTask），只在查冲突的那一批带
function buildCheckPrompt(tree, memory = '', claudeMd = '', categoryTask = '', docs = '', conflicts = true, context = '', ruleTask = '') {
  return `你是需求树的体检员。下面是一个项目的需求树（Markdown）：标题是需求，开头是 ID；标题下 "- " 开头的是规则，可带 [键]；下级用和上级同一个 [键] 的规则，是有意在本范围内覆盖上级（不算冲突）。

<需求树>
${tree}
</需求树>
${context ? `
<时间和正在做的事（判断哪边是现在的说法时参考）>
${context}
</时间和正在做的事>
` : ''}${memory ? `
<自动记忆（AI 自己记下的笔记，每份一段）>
${memory}
</自动记忆>
${claudeMd ? `
<CLAUDE.md（项目说明）>
${claudeMd}
</CLAUDE.md>
` : ''}` : ''}${docs ? `
<文档（需求下「> 文档：」挂的，和项目根的 CLAUDE.md、AGENTS.md；每份一段，太长的切成几段）>
${docs}
</文档>
` : ''}
${conflicts ? `找出说法互相冲突、要用户拍板的规则：上级和下级（或同一个需求里）对同一件事说得不一样，又没有用同一个 [键] 写成覆盖。例：P「每章互动不超过4个」，C1「每章互动不超过5个」。
这些都不算冲突，不要报：
- 下级只是更具体、补充了细节；
- 两条话题相近但管的不是一件事（「组件里不带公式」和「推导收进抽屉」：一个说组件，一个说正文）；
- 不在同一条上下级链上的两个需求说法不同（比如按文件类型分的「写作」需求和某门课）：范围窄的本来就为准，是有意的例外；
- 参考了时间和正在做的事，还是拿不准是不是冲突的。
宁可少报，不要误报。override_rule 的 from 只能是 node 的上级（标题层级更高、而且是它的祖先）。
每处冲突写成一个问题：text 是一句简短的问题，说清两条各是什么；options 是 2–3 种处理（label 几个字，ops 是这种处理完整的改动）。常用的：
- 下级算例外：[{"op":"remove_rule","node":"下级ID","text":"下级原文"},{"op":"override_rule","node":"下级ID","from":"上级ID","text":"上级原文","new":"下级原文"}]
- 统一用上级的：[{"op":"remove_rule","node":"下级ID","text":"下级原文"}]
- 两条都留着：[]
同一个需求里的两条冲突：留后面那条（remove_rule 前面的）、留前面那条（remove_rule 后面的）、两条都留着。写在后面的那条是后来记的（记录员总是往后加），所以默认留后面那条，sure 写 true。
另外找几个兄弟需求里都有的同一条规则（措辞不同也算），写成同样格式的问题：提到它们共同的上级（每处 remove_rule，再在上级 add_rule），或者不动。上级是最顶上的需求时，只有这条对整个项目都成立才提。
以「决定：」开头的规则是用户拍板定下的：不要提议删掉或改掉它，除非另一条更新的「决定：」推翻了它。
default 是最可能的那个选项的序号（从 0 起）。sure 默认写 true，会直接按 default 处理（用户可以撤销），不问用户：同一需求里后写的为准，上下级之间下级算例外，提到上级要明显成立才提。判断时参考「时间和正在做的事」：后定下的为准；和正在进行、最近在改的需求有关的那条是现在在用的说法。只有这些都看不出哪边对、也看不出是不是真冲突时才写 false（那就什么都不改）。最多 ${MAX_CHECK_QUESTIONS} 个问题。
${ruleTask}` : `这次不用找规则冲突，questions 输出空数组。
`}${memory ? MEMORY_TASK : ''}${docs ? DOC_TASK : ''}${categoryTask}
只输出 JSON，不要任何别的文字；没有冲突就输出 {"questions":[]}：
{"questions":[{"text":"全局写每章互动不超过4个，C1 写不超过5个：","options":[{"label":"C1 用5（本课例外）","ops":[...]},{"label":"统一用4","ops":[...]},{"label":"两条都留着","ops":[]}],"default":0,"sure":false}]${conflicts && ruleTask ? RC.OUTPUT_HINT : ''}${memory ? ',"memory":[{"file":"a.md","kind":"covered","where":"P"},{"file":"b.md","kind":"move","node":"C1","rules":["规则"],"whole":true},{"file":"c.md","kind":"conflict","node":"C2","rule":"树里原文","text":"记忆的说法","newer":"memory","whole":true},{"file":"d.md","kind":"stale","why":"那门课已经删了"},{"file":"e.md","kind":"doc","node":"C1"},{"file":"f.md","kind":"keep"}]' : ''}${docs ? ',"docs":[{"doc":"A/_BRIEF.md","kind":"dup","text":"文档原句","node":"C1"},{"doc":"A/_BRIEF.md","kind":"move","text":"文档原句","node":"C1","rule":"新规则"},{"doc":"A/_BRIEF.md","kind":"clash","text":"每章 3 道题","new":"每章 5 道题","other":"docs/style.md","otherText":"每章 5 道题","otherNew":"每章 3 道题"}]' : ''}${categoryTask ? ',"categories":[{"node":"P","groups":[{"name":"写作","rules":[1,3]}]}]' : ''}}`;
}

const MAX_MEMORY_QUESTIONS = 12;
// 处理过的记忆按内容算：用户撤销了体检删记忆的改动，记忆原样放回，下次体检也不会再删它
const noteKey = note => `mem|${note.file}|${fingerprint([note.description, note.body].filter(Boolean).join('\n'))}`;
// 树里每条规则最后一次由用户的话定下的时间：记录员（从对话里记的）或用户在面板上改的。体检、初始化搬进来的不算
// （那只是搬家的时间，不是做决定的时间）。返回 (nodeId, text) => 毫秒 | 0
function ruleTimes(treePath) {
  const times = new Map();
  for (const e of store.readChanges(treePath, 500).slice().reverse()) {
    if (e.undone || !['记录员', '你'].includes(e.source)) continue;
    for (const o of e.ops) {
      const t = o.op === 'override_rule' ? o.new : (o.op === 'add_rule' || o.op === 'replace_rule') ? o.text : null;
      if (t) times.set(`${o.node}|${norm(t)}`, e.time);
    }
  }
  return (node, text) => times.get(`${node}|${norm(text)}`) || 0;
}

// 记忆说的是一条例外（某一类除外），或者比树里那条短得多：按记忆「改」树会把整条规则换成一句例外，丢掉原来的内容。
// 这种只在旁边加一条，不替换（2026-10-25 实测：「光照只有一条规则……」被换成了「云保留预设色，作为例外」）
const EXCEPTION_RE = /例外|除外|除了|不包括|不算|except|exception/i;
const addsOnly = (said, rule) => EXCEPTION_RE.test(said) || [...said].length < [...rule].length * 0.5;

// 模型对每份记忆的判断 → { remove 直接删的改动, questions 要处理的判断（问不问由 Q.decide 定）, toDoc }。文件、需求、规则对不上的丢掉。
// shown / clipped：给模型看了的、被切成几段的文件。没看到的不判断；没看全的不整份删。
// asked：处理过的记忆（noteKey），这份记忆没改过就不再碰。count：前几批已经有几个（总数不超过 MAX_MEMORY_QUESTIONS）。
// toDoc：模型说是某个需求的经验、进度或背景的记忆 [{ file, node, docs }]，由 toDocJudgment 搬进那个需求挂的文档
function memoryPlan(items, { text, dir, projectDir, notes, asked, shown, clipped = new Set(), claudeMd = '', count = 0, ruleTime = () => 0 }) {
  const root = parse(text);
  const byFile = new Map(notes.filter(n => !shown || shown.has(n.file)).map(n => [n.file, n]));
  const del = file => ({ op: 'memory_remove', dir, file, whole: true });
  const seen = new Set();
  const remove = [], questions = [], toDoc = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it !== 'object' || typeof it.file !== 'string') continue;
    if (it.kind === 'doc') {
      const n = typeof it.node === 'string' && findById(root, it.node.trim());
      // 这个需求自己没挂文档就往上找（「新文风重写」没挂，它的上级 AI 课挂了规则与经验）
      let holder = n;
      while (holder && holder.id && !holder.docs.length) holder = holder.parent;
      if (n && byFile.has(it.file) && !toDoc.some(d => d.file === it.file)) toDoc.push({ file: it.file, node: n.id, docs: holder && holder.id ? holder.docs : [] });
      continue;
    }
    const note = byFile.get(it.file);
    if (!note || seen.has(it.file)) { if (!note) log(`体检：模型说的记忆文件不存在或没给它看，丢掉：${JSON.stringify(it)}`); continue; }
    seen.add(it.file);
    const key = noteKey(note);
    if (asked.has(key)) continue;
    const node = typeof it.node === 'string' ? findById(root, it.node.trim()) : null;
    // 没看全的记忆不能整份删：选项里只往树里加，不删记忆
    const whole = it.whole !== false && !clipped.has(it.file);
    let q = null;
    if (it.kind === 'covered') {
      // 用户本人、外部资源这两类本来就该留在记忆里，模型说重复也不动
      if (note.type === 'user' || note.type === 'reference') continue;
      const where = String(it.where || '').trim();
      const isMd = /^CLAUDE\.md$/i.test(where);
      const target = isMd ? null : (where && findById(root, where));
      if (isMd ? !claudeMd : !target) { log(`体检：模型说记忆已有但对不上需求，丢掉：${JSON.stringify(it)}`); continue; }
      const targets = isMd ? sentences(claudeMd) : [target, ...walk(target)].flatMap(n => n.rules.map(r => r.text));
      if (!clipped.has(it.file) && looksCovered(note, targets)) { remove.push(del(it.file)); continue; }
      if (count + questions.length >= MAX_MEMORY_QUESTIONS) continue;
      const shownWhere = isMd ? 'CLAUDE.md' : target.id;
      q = {
        text: `记忆 ${it.file} 说的事，${isMd ? 'CLAUDE.md' : `需求树（${target.id}）`}里已经有了，删掉这份记忆吗？`,
        t: { k: 'q.memCovered', a: [it.file, shownWhere] },
        options: [
          { label: '删掉这份记忆', t: { k: 'q.optDelNote', a: [] }, ops: [del(it.file)] },
          { label: '留在记忆', t: { k: 'q.optKeepNote', a: [] }, ops: [] },
        ],
        // 模型看全了、说已经有了（只是措辞不同，字面对不上）：直接删，有备份、可撤销。
        // 记忆太长被切成几段、模型没看全的：留着（partial，见 Q.decide）
        default: 0, partial: clipped.has(it.file),
      };
    } else if (count + questions.length >= MAX_MEMORY_QUESTIONS) {
      continue;
    } else if (it.kind === 'move' && node) {
      const rules = (Array.isArray(it.rules) ? it.rules : []).filter(r => typeof r === 'string' && r.trim() && r.length <= 200).slice(0, 5).map(r => r.replace(/[\r\n]+/g, ' ').trim());
      if (!rules.length) continue;
      const add = rules.map(r => ({ op: 'add_rule', node: node.id, text: r }));
      const more = rules.length > 1 ? `等 ${rules.length} 条` : '';
      q = {
        text: `记忆 ${it.file} 里有需求树还没有的规则：「${rules[0]}」${more}。搬进需求树（${node.id}）吗？`,
        t: { k: 'q.memMove', a: [it.file, rules[0], rules.length, node.id] },
        options: [
          whole
            ? { label: `搬进 ${node.id}，删掉这份记忆`, t: { k: 'q.optMoveDel', a: [node.id] }, ops: [...add, del(it.file)] }
            : { label: `加进 ${node.id}，记忆留着`, t: { k: 'q.optMoveKeep', a: [node.id] }, ops: add },
          { label: '删掉这份记忆', t: { k: 'q.optDelNote', a: [] }, ops: [del(it.file)] },
          { label: '留在记忆', t: { k: 'q.optKeepNote', a: [] }, ops: [] },
        ],
        default: 0,
      };
    } else if (it.kind === 'conflict' && node && typeof it.rule === 'string' && typeof it.text === 'string' && it.text.trim()) {
      const rule = node.rules.find(r => r.text === it.rule.trim()) || node.rules.find(r => norm(r.text) === norm(it.rule));
      if (!rule) { log(`体检：模型说的冲突规则在树里找不到，丢掉：${JSON.stringify(it)}`); continue; }
      const said = it.text.replace(/[\r\n]+/g, ' ').trim();
      const fix = addsOnly(said, rule.text)
        ? { op: 'add_rule', node: node.id, text: said, force: true }
        : { op: 'replace_rule', node: node.id, old: rule.text, text: said };
      // 哪边新：树里这条是用户的话定下的、有时间，就和记忆的修改时间比，不用模型猜，也不问
      const decided = ruleTime(node.id, rule.text);
      // 模型也拿不准的按需求树；要改掉一条「决定：」的问（Q.decide 看出来）
      const newer = decided ? (note.mtime > decided ? 'memory' : 'tree') : it.sure === false ? 'tree' : it.newer;
      q = {
        text: `记忆 ${it.file} 说「${said}」，需求树（${node.id}）说「${rule.text}」，以哪个为准？`,
        t: { k: 'q.memConflict', a: [it.file, said, node.id, rule.text] },
        options: whole ? [
          { label: '按记忆改需求树', t: { k: 'q.optUseMemory', a: [] }, ops: [fix, del(it.file)] },
          { label: '按需求树，删掉记忆', t: { k: 'q.optUseTreeDel', a: [] }, ops: [del(it.file)] },
          { label: '都留', t: { k: 'q.optKeepBoth', a: [] }, ops: [] },
        ] : [
          { label: '按记忆改需求树', t: { k: 'q.optUseMemory', a: [] }, ops: [fix] },
          { label: '按需求树', t: { k: 'q.optUseTree', a: [] }, ops: [] },
        ],
        // 判断不了哪边新的，也按需求树（树是准绳，记录员一直按最新的话改它）
        default: newer === 'memory' ? 0 : 1,
      };
    } else if (it.kind === 'stale') {
      const why = typeof it.why === 'string' ? it.why.replace(/[\r\n]+/g, ' ').trim().slice(0, 120) : '';
      q = {
        text: `记忆 ${it.file} 看起来是过时的进度或计划${why ? `（${why}）` : ''}，删掉吗？`,
        t: { k: 'q.memStale', a: [it.file, why] },
        options: [
          { label: '删掉这份记忆', t: { k: 'q.optDelNote', a: [] }, ops: [del(it.file)] },
          { label: '留在记忆', t: { k: 'q.optKeepNote', a: [] }, ops: [] },
        ],
        default: 0,
      };
    }
    // 搬进树、删过时的：模型说没把握的留着不动（冲突的没把握已经在上面按树处理）
    if (q) { asked.add(key); questions.push({ source: '体检', kind: 'memory', memKey: key, unsure: ['move', 'stale'].includes(it.kind) && it.sure === false, ...q }); }
  }
  return { remove, questions, toDoc };
}

// 记忆搬进文档：挑这个需求挂的整份文档（进度类优先，其次规则和经验类），原文接在末尾，标明从哪份记忆来
const docPick = f => (/progress|进度/i.test(f) ? 0 : /经验|规则|rules|notes|笔记/i.test(f) ? 1 : 2);
function toDocJudgment(d, note, memDir, projectDir) {
  // 用户本人、外部资源两类本来就该留在记忆里
  if (!note || !note.body || !note.body.trim() || note.type === 'user' || note.type === 'reference') return null;
  const docs = (d.docs || []).filter(ref => !Docs.splitRef(ref).section && Docs.exists(projectDir, ref)).sort((a, b) => docPick(a) - docPick(b));
  if (!docs.length) return null;
  const target = docs[0];
  let old = '';
  try { old = fs.readFileSync(Docs.resolve(projectDir, target), 'utf8'); } catch { return null; }
  const nl = /\r\n/.test(old) ? '\r\n' : '\n';
  const head = `## 从自动记忆搬来：${note.description || note.file}${note.modified ? `（${note.modified}）` : ''}`;
  const text = `${old.replace(/\s*$/, '')}${nl}${nl}${head}${nl}${nl}${note.body.trim().replace(/\r?\n/g, nl)}${nl}`;
  return {
    source: '体检', kind: 'memory', memKey: noteKey(note), node: d.node,
    text: `记忆 ${d.file} 是 ${d.node} 的经验或进度：原文搬到 ${target} 末尾，删掉这份记忆`,
    t: { k: 'q.memToDoc', a: [d.file, d.node, target] },
    options: [
      { label: '搬进文档', t: { k: 'q.optToDoc', a: [] }, ops: [{ op: 'doc_write', file: target, text }, { op: 'memory_remove', dir: memDir, file: d.file, whole: true }] },
      { label: '留在记忆', t: { k: 'q.optKeepNote', a: [] }, ops: [] },
    ],
    default: 0,
  };
}

// ---------- 范围：规则到不到得了 AI 手上 ----------
// 项目里的文件（相对路径，/ 分隔）。跳过依赖、构建产物、缓存这类又大又不会被需求对应的文件夹；
// 超过 MAX_FILES 个就不判断「匹配不到」（数不全会误报）
const MAX_FILES = 50000;
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.next', 'dist', 'target', 'Library', '.godot', '.gradle']);
function projectFiles(dir) {
  const out = [], stack = [''];
  while (stack.length && out.length < MAX_FILES) {
    const rel = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(r); }
      else out.push(r);
    }
  }
  return out;
}
// noFiles：有规则、自己和上级都没有文件对应的需求（规则不会自动加载）；
// empty：文件对应一个文件也匹配不到的需求。刚计划、还没建文件的需求很常见，所以分开：
//   AI 改过它的文件（touched 里有）、现在一个都找不到 → 文件多半被删了，问要不要这个需求；
//   没记录、但标着 🔨 → 只提醒（missing）；✅（做完了，文件可能是有意删的）⏳ ❓ 和没状态的不管
function scopeProblems(text, projectDir, touched = {}) {
  const { autoLoads } = require('./compile');
  const noFiles = [], empty = [], missing = [];
  let files = null;
  for (const n of walk(parse(text))) {
    if (!n.id) continue;
    if (n.rules.length && !autoLoads(n)) noFiles.push(n.id);
    if (!n.files.length) continue;
    const wasTouched = !!touched[n.id];
    if (!wasTouched && n.status !== 'doing') continue;
    files = files || projectFiles(projectDir);
    if (files.length >= MAX_FILES) continue;
    if (!n.files.every(g => { const re = globToRegExp(g); return !files.some(f => re.test(f)); })) continue;
    (wasTouched ? empty : missing).push({ node: n.id, title: n.title, globs: n.files });
  }
  return { noFiles, empty, missing };
}
function emptyScopeQuestion(e) {
  const globs = e.globs.join('、');
  return {
    source: '体检', kind: 'scope', memKey: `scope|${e.node}|${e.globs.join(',')}`, node: e.node,
    text: `「${e.title}」对应的文件（${globs}）一个也找不到了，这个需求还要吗？`,
    t: { k: 'q.noMatch', a: [e.title, globs] },
    options: [
      { label: '删掉这个需求', t: { k: 'q.optDelNode', a: [] }, ops: [{ op: 'delete_node', node: e.node }] },
      { label: '暂停（待定）', t: { k: 'q.optPause', a: [] }, ops: [{ op: 'set_status', node: e.node, status: 'question' }] },
      { label: '先不管', t: { k: 'q.optLeave', a: [] }, ops: [] },
    ],
    // 多半是文件被删了或挪了：先标成待定，不问（可以撤销）
    default: 1,
  };
}

const log = msg => { try { require('../hooks/recorder').log(msg); } catch {} };

// 处理一个判断：问不问、默认选哪个由 Q.decide 定；默认做法直接写进去（记成「体检」的一条改动，可以撤销），再把它记进问题列表。
// 不问的记成「已自动处理」，下次体检也不会重复提；问的开着（回答别的选项会先撤销默认做法）。
// 「做成一半」只看需求树本身的改动：树的改动有的做成、有的没做成（加了新规则、旧的那条却找不到）就整个撤掉。
// 删文档行、删记忆这类收尾删不掉（在表格里、找不准），不影响树的改动，调用方在报告里提醒。
// 一点都没做成（规则早就在树里或早被改掉了）时不问（没事可做），记成关掉，下次不再提；要改「决定：」的照样开着问。
// 返回 { question 开着的问题, auto 自动处理的问题（没做成时为 null）, applied }
async function settle(treePath, q0, { write, read }) {
  const d = Q.decide(q0, (read || (p => fs.readFileSync(p, 'utf8')))(treePath), { askUnsure: store.readConfig(treePath).askUnsure });
  const q = { ...q0, default: d.default };
  const opt = q.options[q.default] || { ops: [] };
  let changeId = null, applied = [];
  if (opt.ops.length) {
    changeId = store.newChangeId();
    applied = await store.applyChange(treePath, opt.ops, { source: '体检', write, id: changeId });
    const treeOp = o => !require('./memory').isMemoryOp(o) && !Docs.isDocOp(o);
    if (applied.some(treeOp) && (applied.skipped || []).some(s => s.op && treeOp(s.op) && !['duplicate', 'same'].includes(s.reason))) {
      await store.undoChange(treePath, changeId, { write });
      applied = [];
    }
    if (!applied.length) changeId = null;
  }
  const done = !opt.ops.length || applied.length > 0;
  const rec = Q.addQuestion(treePath, { ...q, defaultApplied: done, changeId });
  if (!d.ask && done && Q.acceptDefault(treePath, rec.id)) return { question: null, auto: { ...rec, status: 'answered', auto: true }, applied };
  if (!d.ask) { Q.dismissQuestion(treePath, rec.id); return { question: null, auto: null, applied }; }
  return { question: rec, auto: null, applied };
}

// 做一次体检。read：读树的当前内容（插件传编辑器里的内容）；write：插件的 writeTree；
// model：false 时不调用模型；ask：调用模型的函数（测试可以换）；
// memory：自动记忆文件夹，不传就按项目找（src/memory.js），false 不查记忆（设置 reqtree.memoryMode 为 treeOnly 时）。
// parts：查哪几样 { rules 规则（合并重复、冲突、久未动、加载不到、分组）, memory 自动记忆, docs 文档和 CLAUDE.md/AGENTS.md }，不给就全查；
// full：true 时不管上次查过没有，全部重查。progress(i, n)：开始第 i 批（共 n 批）时调用，插件拿来显示进度。
// 某一批出错（多半是超时）不影响其他批；出错那批的内容不记指纹，下次体检再看。
// 返回 { merged 删掉的重复规则, stale 新加的久未动问题, memory 新加的记忆问题, removed 直接删掉的记忆（已在树或 CLAUDE.md 里）,
//        scope 新加的「文件找不到」问题, noFiles 规则不会加载的需求 ID, missing 标着 🔨 却找不到文件的需求 [{ node, title, globs }],
//        categorized 规则分了组的需求 ID（只改面板显示）, questions 新加的冲突问题,
//        docs 新加的文档问题, docDup 文档里和树重复、可以删的 [{ doc, text, node }], docMissing 挂了却不存在的文档, docUnlinked 没挂的文档,
//        docConflicts 文档和树说法不同的 [{ doc, text, node, rule }]（以树为准，不问，只在报告里列）, toDoc 该挪进文档的记忆 [{ file, node, docs }], auto 有把握、直接处理了的（问题记录或 { text, t }，都可以在「最近改动」里撤销）,
//        checked { notes, docs, calls, failed } 这次看了几份、调用几次模型、几次出错, error 最后一次调用模型出错的说明 }
async function runCheckup(treePath, { read, write, model = true, ask, reorgAsk, memory, parts = {}, full = false, progress } = {}) {
  const rec = require('../hooks/recorder');
  const mem = require('./memory');
  const readText = read || (p => fs.readFileSync(p, 'utf8'));
  const want = { rules: parts.rules !== false, memory: parts.memory !== false && memory !== false, docs: parts.docs !== false };
  const result = { merged: [], stale: [], memory: [], removed: [], scope: [], structure: [], noFiles: [], missing: [], categorized: [], questions: [],
    docs: [], docDup: [], docConflicts: [], docMissing: [], docUnlinked: [], docNoToc: [], toDoc: [], auto: [], reorganized: null, health: null, checks: null, docClash: [], checked: { notes: 0, docs: 0, calls: 0, failed: 0 }, error: null };
  const projectDir = path.dirname(treePath);
  const asked = new Set(Q.readQuestions(treePath).map(q => q.memKey).filter(Boolean));
  // 代码地图的图（谁用谁、代码里有哪些名字）：查挂错的代码文件、规则里提到的名字还在不在、信息架构评分。没有代码的项目是空的
  let graph;
  const getGraph = () => (graph !== undefined ? graph : (graph = (() => { try { return require('./codemap').build(projectDir, { allWords: true }); } catch (e) { rec.log('代码地图没建成：' + e.message); return null; } })()));
  const misplacedCount = () => { const g = getGraph(); try { return g ? require('./codemap').placement(g, parse(readText(treePath))).filter(p => p.misplaced).length : 0; } catch { return 0; } };

  // 树长歪了（某个需求挂了一大堆规则、根上规则太多、规则挂在永远送不到的需求上、代码挂错）：先重新整理结构，再接着查（自动只做一次，见 src/init.js）
  const Init = require('./init');
  if (model && want.rules && !Init.autoReorganized(treePath) && Init.needsReorganize(readText(treePath), { misplaced: misplacedCount() }).length) {
    try {
      const r = await Init.reorganize(treePath, { ask: reorgAsk || ask, auto: true });
      if (r.ai) result.reorganized = r;
      else rec.log('体检：重新整理没做成：' + (r.error ? r.error.message : '未知原因'));
    } catch (e) { rec.log('体检：重新整理出错：' + e.stack); }
  }

  if (want.rules) {
    const dups = duplicateOps(readText(treePath));
    result.merged = dups.length ? await store.applyChange(treePath, dups.map(({ why, ...o }) => o), { source: '体检', write }) : [];
    if (result.merged.length) rec.log(`体检：合并重复规则 ${JSON.stringify(result.merged.map(o => [o.node, o.text]))}`);
    try { result.stale = Q.staleQuestions(treePath); } catch (e) { rec.log('久未动的问题没生成：' + e.message); }
    // 规则到不到得了 AI 手上（不调用模型）
    try {
      const sp = scopeProblems(readText(treePath), projectDir, store.readState(treePath).touched || {});
      result.noFiles = sp.noFiles;
      result.missing = sp.missing;
      for (const e of sp.empty) {
        const q = emptyScopeQuestion(e);
        if (asked.has(q.memKey)) continue;
        asked.add(q.memKey);
        const st = await settle(treePath, q, { write, read: readText });
        if (st.question) result.scope.push(st.question); else if (st.auto) result.auto.push(st.auto);
      }
    } catch (e) { rec.log('查文件对应出错：' + e.stack); }
  }
  if (want.docs) {
    // 先理结构（建需求、挂文档），再查文档问题：刚挂上的就不再报「没挂」
    try {
      const files = require('./codemap').listFiles(projectDir, { any: true });
      for (const q of require('./structure').plan(readText(treePath), projectDir, files, path.basename(treePath))) {
        if (asked.has(q.memKey)) continue;
        asked.add(q.memKey);
        const st = await settle(treePath, q, { write, read: readText });
        if (st.question) result.structure.push(st.question); else if (st.auto) result.auto.push(st.auto);
      }
    } catch (e) { rec.log('整理信息架构出错：' + e.stack); }
    try { Object.assign(result, docProblems(readText(treePath), projectDir, treePath)); } catch (e) { rec.log('查文档出错：' + e.stack); }
  }

  let memDir = null;
  if (want.memory) try { memDir = typeof memory === 'string' ? memory : mem.memoryDir(projectDir); } catch (e) { rec.log('找不到自动记忆：' + e.message); }
  // 不调用模型时，记忆和需求树各有一份的只能按字面（Dice ≥ 0.7）找；调用模型时交给模型逐份按分工判断
  const literalMemory = async () => {
    let dups = [];
    try { dups = mem.findDuplicates(readText(treePath), memDir); } catch (e) { rec.log('查记忆重复出错：' + e.stack); }
    for (const d of dups) {
      const q = mem.memoryQuestion(d, memDir);
      if (asked.has(q.memKey)) continue;
      asked.add(q.memKey);
      const st = await settle(treePath, q, { write, read: readText });
      if (st.question) result.memory.push(st.question); else if (st.auto) result.auto.push(st.auto);
    }
  };
  if (memDir && !model) await literalMemory();
  // 信息架构评分（不调用模型，src/health.js）：体检做完的样子，写进报告
  const withHealth = () => {
    try { result.health = require('./health').measure(treePath, { text: readText(treePath), graph: getGraph() }); } catch (e) { rec.log('信息架构评分没算成：' + e.stack); }
    return result;
  };
  if (!model) return withHealth();

  const plan = checkPlan(treePath, { read: readText, parts: want, full, memory: memDir || false });
  result.checked = { notes: plan.notes.length, docs: plan.docs.length, calls: plan.calls, failed: 0 };
  const seen = { ...readSeen(treePath) };
  const saveSeen = () => { try { store.writeJson(store.metaFile(treePath, SEEN_FILE), seen); } catch (e) { rec.log('体检记录没存上：' + e.message); } };
  let claudeMd = '';
  try { claudeMd = clipChars(fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8'), CLAUDE_MD_CHARS); } catch {}
  const Cat = require('./categories');
  let context = '';
  try { context = contextBlock(treePath, readText(treePath)); } catch (e) { rec.log('体检参考没生成：' + e.message); }
  const askModel = ask || (p => rec.askJson(p, { timeoutMs: CHECK_TIMEOUT_MS }));
  const failedNames = new Set();
  // 几批同时问模型（最多 CHECK_PARALLEL 个），回来的结果按批的顺序一批批处理：写树、写文档不会互相打架，每处改动照样单独记、单独撤销。
  // 冲突和分组只查一次：交给最先开始的一批；它出错了，之后才开始的批接着查
  // 规则一条都没变：不查（plan.rulesDue）
  let rulesTaken = !want.rules || !plan.rulesDue;
  let files = null;
  const projectFiles = () => files || (files = (() => { try { return require('./codemap').listFiles(projectDir, { any: true }); } catch { return []; } })());
  const calls = [];
  const start = i => {
    const batch = plan.batches[i];
    const first = !rulesTaken;
    rulesTaken = true;
    const call = Promise.resolve().then(() => {
      const text = readText(treePath);
      const memSegs = batch.filter(s => s.kind === 'mem'), docSegs = batch.filter(s => s.kind === 'doc');
      // 查规则的那一批：上次查过的就只看新加、改过的（第一次、全部重查时看全部）
      let rules = null;
      if (first) {
        const focus = plan.seen.rules ? RC.changedRules(text, plan.seen.rules) : null;
        const only = focus && new Set(focus.map(c => RC.ruleKey(c.node.id, c.rule.text)));
        const g = getGraph();
        rules = { focus, pairList: RC.pairs(text, projectFiles(), only), staleList: RC.staleEvidence(text, projectFiles(), only, g && g.files.size ? g.words : null) };
        rules.cats = Cat.promptTask(text, Cat.read(treePath), focus && new Set(focus.map(c => c.node.id)));
      }
      const prompt = buildCheckPrompt(text, memSegs.map(s => s.block).join('\n\n'), memSegs.length ? claudeMd : '',
        first ? rules.cats : '', batch.filter(s => s.kind === 'doc' || s.kind === 'ref').map(s => s.block).join('\n\n'), first, context, first ? RC.promptTask(rules) : '');
      return Promise.resolve(askModel(prompt)).then(out => ({ out, text, first, rules }));
    }).catch(e => { if (first) rulesTaken = false; throw e; });
    // 这一批回来了（不管成没成）就开下一批，保持同时跑的个数
    call.then(() => {}, () => {}).then(() => { const n = calls.length; if (n < plan.batches.length) calls[n] = start(n); });
    return call;
  };
  while (calls.length < Math.min(CHECK_PARALLEL, plan.batches.length)) calls[calls.length] = start(calls.length);
  for (let i = 0; i < plan.batches.length; i++) {
    const batch = plan.batches[i];
    if (progress) try { progress(i + 1, plan.batches.length); } catch {}
    try {
      const r = await (calls[i] || (calls[i] = start(i)));
      const { out, first } = r;
      // 分组和冲突针对模型看到的那份树；其余按现在的树处理（前面几批可能已经改过它）
      const text = first ? r.text : readText(treePath);
      const memSegs = batch.filter(s => s.kind === 'mem'), docSegs = batch.filter(s => s.kind === 'doc');
      if (first) {
        // 规则分类：只改面板的显示方式
        if (out && Array.isArray(out.categories)) try { result.categorized = Cat.save(treePath, text, out.categories); } catch (e) { rec.log('规则分类没存上：' + e.message); }
        const ctx = { root: parse(text), unmapped: [], user: '' };
        const picked = rec.pickQuestions(out && out.questions, { text, ops: [], ctx, allowed: CHECK_OPS, max: MAX_CHECK_QUESTIONS }).questions;
        // 同样的问题还开着、或者以前直接处理过（用户可能撤销了），就不再提
        const open = new Set(Q.readQuestions(treePath).filter(q => q.status === 'open' || q.auto).map(q => q.text));
        for (const q of picked) {
          if (open.has(q.text)) continue;
          // 模型没把握的什么都不改（选「都留着」，见 Q.decide）：实测 Haiku 偶尔误报冲突（docs/test-log.md 第十一节），先改上去误报就成了误改
          const st = await settle(treePath, { source: '体检', text: q.text, options: q.options, default: q.default, unsure: !!q.unsure }, { write, read: readText });
          if (st.question) result.questions.push(st.question); else if (st.auto) result.auto.push(st.auto);
        }
        // 一起送到的两条重复、打架的；确认过时的（程序先找了证据）
        const more = [...RC.pairJudgments(out && out.pairs, r.rules.pairList), ...RC.staleJudgments(out && out.stale, r.rules.staleList, { text, projectDir })];
        for (const q of more) {
          if (asked.has(q.memKey)) continue;
          asked.add(q.memKey);
          const st = await settle(treePath, q, { write, read: readText });
          if (st.question) result.questions.push(st.question); else if (st.auto) result.auto.push(st.auto);
        }
        // 能写成检查的规则：核对后存下，AI 改完文件时 hook 查（src/checks.js）。这次只看了变了的规则时，只换掉这些规则的检查
        try {
          const focus = r.rules.focus;
          result.checks = require('./checks').save(treePath, readText(treePath), out && out.checks, { files: projectFiles(), considered: focus ? new Set(focus.map(c => RC.ruleKey(c.node.id, c.rule.text))) : null });
          if (result.checks.dropped.length) rec.log(`体检：没采用的检查 ${JSON.stringify(result.checks.dropped)}`);
        } catch (e) { rec.log('检查没存上：' + e.stack); }
        // 查过的规则记下来（含刚改过的样子），下次没变就不再查
        seen.rules = RC.ruleKeys(readText(treePath));
      }
      if (memSegs.length && out && Array.isArray(out.memory)) {
        const shown = new Set(memSegs.map(s => s.name));
        const clipped = new Set(memSegs.filter(s => s.part).map(s => s.name));
        const mp = memoryPlan(out.memory, { text, dir: memDir, projectDir, notes: plan.notes, asked, shown, clipped, claudeMd, count: result.memory.length, ruleTime: ruleTimes(treePath) });
        // 已经写在树或 CLAUDE.md 里的：一起删掉，记成一条改动（先备份，面板上可以撤销）
        if (mp.remove.length) result.removed.push(...await store.applyChange(treePath, mp.remove, { source: '体检', write }));
        for (const q of mp.questions) {
          const st = await settle(treePath, q, { write, read: readText });
          if (st.question) result.memory.push(st.question); else if (st.auto) result.auto.push(st.auto);
        }
        // 某个需求的经验、进度、背景的记忆：原文搬到那个需求挂的文档末尾，删掉记忆（都先备份，一起撤销）。需求没挂文档的只提醒
        for (const d of mp.toDoc) {
          const q = toDocJudgment(d, plan.notes.find(n => n.file === d.file), memDir, projectDir);
          if (!q) { result.toDoc.push(d); continue; }
          if (asked.has(q.memKey)) continue;
          asked.add(q.memKey);
          const st = await settle(treePath, q, { write, read: readText });
          if (st.question) result.memory.push(st.question); else if (st.auto) result.auto.push(st.auto);
        }
      }
      if (docSegs.length && out && Array.isArray(out.docs)) {
        const dp = docPlan(out.docs, { text, shown: new Set(docSegs.map(s => s.name)), refs: new Set(batch.filter(s => s.kind === 'ref').map(s => s.name)), asked, count: result.docs.length });
        result.docConflicts.push(...dp.conflicts);
        // 文档跟着需求树改：改不成（原文找不到或不止一处）的留在报告里提醒
        for (const d of dp.stale) {
          const done = await store.applyChange(treePath, d.ops, { source: '体检', write });
          if (done.length) result.auto.push({ text: `${d.doc} 里的「${d.text}」和需求树（${d.node}）不一致，已按需求树改成「${d.new}」`, t: { k: 'q.autoDocStale', a: [d.doc, d.text, d.node, d.new] } });
          else result.docConflicts.push({ doc: d.doc, text: d.text, node: d.node, rule: d.rule });
        }
        // 两份文档说法矛盾：按后改的那份改先改的那份（总目录的「按后写的为准」）；分不出先后（一小时以内）或改不成的留在报告里
        for (const c of dp.clash) {
          const ta = Docs.docTime(projectDir, c.doc), tb = Docs.docTime(projectDir, c.other);
          const fix = Math.abs(ta - tb) < 3600e3 ? null : ta > tb
            ? { doc: c.other, text: c.otherText, new: c.otherNew, by: c.doc }
            : { doc: c.doc, text: c.text, new: c.new, by: c.other };
          const done = fix ? await store.applyChange(treePath, [{ op: 'doc_replace', file: fix.doc, text: fix.text, new: fix.new }], { source: '体检', write }) : [];
          if (done.length) result.auto.push({ text: `${fix.doc} 里的「${fix.text}」和后改的 ${fix.by} 说法不同，已改成「${fix.new}」`, t: { k: 'q.autoDocClash', a: [fix.doc, fix.text, fix.by, fix.new] } });
          else result.docClash.push(c);
        }
        // 和树重复的：从文档里删掉那一行；找不准、删不了的留在报告里提醒
        for (const d of dp.dup) {
          const done = await store.applyChange(treePath, d.ops, { source: '体检', write });
          if (done.length) result.auto.push({ text: `从 ${d.doc} 里删掉和需求树（${d.node}）重复的「${d.text}」`, t: { k: 'q.autoDocDup', a: [d.doc, d.text, d.node] } });
          else result.docDup.push({ doc: d.doc, text: d.text, node: d.node });
        }
        for (const q of dp.questions) {
          const st = await settle(treePath, q, { write, read: readText });
          if (st.question) { result.docs.push(st.question); continue; }
          if (st.auto) result.auto.push(st.auto);
          // 规则搬进了树，文档里那一行却没删成：提醒用户自己删
          if (q.options[q.default].ops.some(o => o.op === 'doc_remove') && !st.applied.some(o => o.op === 'doc_remove')) result.docDup.push({ doc: q.doc, text: q.docText, node: q.node });
        }
      }
      // 这一批看完了：记下指纹，下次没改过就不再看（切成几段的，最后一段看完才记）
      for (const s of batch) {
        if (s.kind === 'ref' || failedNames.has(s.name) || (s.part && s.part[0] !== s.part[1])) continue;
        if (s.kind === 'mem') seen[`mem:${s.name}`] = fingerprint(s.note.full);
        else {
          // 文档可能刚被体检删掉几行：改之前和改之后的都算看过（用户撤销后变回改之前的样子，也不再看）
          const d = plan.docs.find(x => x.name === s.name);
          let now = null;
          try { now = fingerprint(docText(projectDir, s.name)); } catch {}
          if (d) seen[`doc:${s.name}`] = [...new Set([fingerprint(d.text), now].filter(Boolean))];
        }
      }
      saveSeen();
    } catch (e) {
      result.error = e;
      result.checked.failed++;
      for (const s of batch) failedNames.add(s.name);
      rec.log(`体检第 ${i + 1}/${plan.batches.length} 批出错：` + e.stack);
    }
  }
  // 一批都没调用成功：记忆至少按字面查一遍重复
  if (memDir && plan.calls && result.checked.failed === plan.calls) await literalMemory();
  withHealth();
  rec.log(`体检：看了 ${plan.notes.length} 份记忆、${plan.docs.length} 份文档，调用模型 ${plan.calls} 次（出错 ${result.checked.failed} 次）；直接处理 ${result.auto.length} 项；问用户 ${result.questions.length} 个冲突、${result.memory.length} 个记忆问题、${result.docs.length} 个文档问题；删掉 ${result.removed.length} 份已在树里的记忆`);
  return result;
}

module.exports = { duplicateOps, buildCheckPrompt, contextBlock, runCheckup, checkPlan, memoryPlan, docPlan, docProblems, scopeProblems, settle, CHECK_OPS };
