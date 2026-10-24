'use strict';
// 体检：用户点「需求树：体检」或运行 reqtree check --fix 时做。
// 1. 确定的，直接改（不调用模型）：同一个需求里几乎一样的规则（Dice ≥ 0.7）、同一个需求里同键的规则，
//    留写在后面的那条（以最新为准），前面的删掉。记成一条改动，面板上可以撤销
// 2. 标着 🔨 很久没动的需求，变成问题（不调用模型）
// 3. 拿不准的：没写键、意思可能冲突的规则（上级和下级、或同一需求里说法不一样），调一次小模型，变成问题让用户选。
//    只在用户主动体检时调用；问题和记录员的问题放在一起（.reqtree/questions.jsonl），只是默认做法没有先写进树
// 4. 设置 reqtree.memoryMode 为 dedupe（默认，「分工」）时，Claude Code 自动记忆逐份按分工判断（同一次模型调用）：
//    分工：需求树和 CLAUDE.md 管这个项目应该是什么样、该怎么做；自动记忆只记和项目内容无关的事（用户本人、工具和环境、私人信息、外部资源）。
//    整份已经写在树或 CLAUDE.md 里的直接删（先备份，可撤销）；是项目规则、树里还没有的问要不要搬进树；
//    和树冲突的问以哪边为准；过时的进度问要不要删；该在记忆里的不动。不调用模型时退回按字面找重复（src/memory.js）
// 5. 不调用模型的提醒：有规则、却永远不会加载的需求（自己和上级都没有文件对应）；文件对应一个文件也匹配不到的需求变成问题
const fs = require('fs');
const path = require('path');
const store = require('./store');
const Q = require('./questions');
const Docs = require('./docs');
const { parse, walk, sameMeaning, findById, norm, globToRegExp } = require('./parser');

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
  }
  return ops;
}

// 记忆给模型看的样子：每份一段（文件名、类型、更新日期、正文）。每份最多 MEMORY_NOTE_CHARS 字，总长不超过 MEMORY_PROMPT_CHARS。
// 旧版本把所有记忆压成一行、总共 8000 字，排在后面的记忆根本到不了模型那里（Vibelearning 的 20 份约 1.5 万字）
const MEMORY_NOTE_CHARS = 1500;
const MEMORY_PROMPT_CHARS = 30000;
const CLAUDE_MD_CHARS = 8000;
const clipChars = (s, max) => { const a = [...s]; return a.length > max ? a.slice(0, max).join('') + '…（截断）' : s; };
// 返回 { text, shown 给模型看了的文件, clipped 被截断的文件 }：模型只能判断它看到的；没看全的不自动删
function memoryForPrompt(notes) {
  const out = [], shown = new Set(), clipped = new Set();
  let size = 0;
  for (const m of notes) {
    const full = [m.description, m.body].filter(Boolean).join('\n');
    const body = clipChars(full, MEMORY_NOTE_CHARS);
    const block = `### ${m.file}（${m.type ? `类型 ${m.type}，` : ''}更新于 ${m.modified}）\n${body}`;
    if (size + block.length > MEMORY_PROMPT_CHARS) break;
    out.push(block); size += block.length;
    shown.add(m.file);
    if (body !== full) clipped.add(m.file);
  }
  return { text: out.join('\n\n'), shown, clipped };
}

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
- conflict：和需求树里某条规则说的是同一件事，说法却不一样。node 是需求 ID，rule 是树里原文，text 是照记忆的说法写成的一条规则，newer 写 "memory" 或 "tree"（看记忆的更新日期和内容判断哪边是后来的决定，判断不了写 "tree"），whole 同上。
- stale：过时的进度，或已经做完、放弃的计划（比如树里那个需求已经 ✅ 或已经删了）。why 用一句话说为什么。
- doc：不是规则，是这个项目某门课、某块内容的经验、进度或背景（踩过的坑、做到哪了、为什么这么定）。这类该写进那个需求挂的背景文档（需求下的「> 文档：」），不该在记忆里。node 写需求 ID。
- keep：属于自动记忆该记的事，或者拿不准。
`;

// 文档：需求下「> 文档：」挂的，加上项目根的 CLAUDE.md、AGENTS.md（它们每次全文加载，最该精简）。
// 不管哪种项目，规则（以后都要照做的要求）只该在需求树里；文档放参考资料：架构、接口、进度、章节表、决策的来由、踩过的坑
const DOC_TASK = `另外逐份看文档。分工：规则（以后都要照做的要求）只该写在需求树里；文档只放参考资料（架构、接口、进度、章节表、某个决定的来由、经验）。CLAUDE.md、AGENTS.md 每次都全文加载，最好只留"东西在哪"这类说明。文档里每处写成规则的地方，在 docs 里写一项（只是参考资料的不写）：
- dup：需求树里已经有同一条（措辞不同也算）。doc 是文档名（照下面每段标题里的写），text 是文档里那句的原文（尽量短，能在文档里搜到），node 是树里那条所在的需求 ID。
- conflict：和需求树里某条说的是同一件事，说法不一样。doc、text 同上，node 是需求 ID，rule 是树里原文。
- move：需求树里还没有的长期规则。doc、text 同上，node 写该挂的需求 ID（管辖范围最小的那个；管全项目的写顶层需求），rule 是照文档意思写成的一条简短规则。
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
  const out = [], seen = new Set();
  const add = (name, node) => { const k = name.replace(/\\/g, '/'); if (!seen.has(k) && Docs.exists(projectDir, k)) { seen.add(k); out.push({ name: k, node }); } };
  for (const f of ['CLAUDE.md', '.claude/CLAUDE.md', 'AGENTS.md']) add(f, null);
  for (const n of walk(root)) for (const d of n.docs) add(d, n.id);
  return out;
}

// 本地检查（不调用模型）：挂的文档不存在；需求的文件夹里有 .md、这个需求却一份文档都没挂（只看「文件夹/**」这种范围的第一层）
const NOT_DOCS = /^(readme|changelog|license|licence|contributing|claude|agents)\b/i;
function docProblems(text, projectDir, treePath) {
  const root = parse(text);
  const linked = new Set(), docMissing = [], docUnlinked = [];
  for (const n of walk(root)) for (const d of n.docs) {
    linked.add(d.replace(/\\/g, '/'));
    if (!Docs.exists(projectDir, d)) docMissing.push({ node: n.id, doc: d });
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
        if (!linked.has(rel)) { linked.add(rel); docUnlinked.push({ node: n.id, title: n.title, doc: rel }); }
      }
    }
  }
  return { docMissing, docUnlinked };
}

// 模型对文档的判断 → { dup 文档里可以删的重复, questions 冲突和该搬进树的规则 }。文档、需求、规则对不上的丢掉。
// 文档不由插件改：重复的只提醒，冲突和该搬的问用户（改的是需求树）
const MAX_DOC_QUESTIONS = 15;
const oneLine = s => (typeof s === 'string' ? s.replace(/[\r\n]+/g, ' ').trim() : '');
function docPlan(items, { text, shown, asked, count = 0 }) {
  const root = parse(text);
  const dup = [], questions = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it !== 'object') continue;
    const doc = oneLine(it.doc).replace(/（第\s*\d+\s*\/\s*\d+\s*段）$/, '').trim(), said = oneLine(it.text);
    const node = typeof it.node === 'string' ? findById(root, it.node.trim()) : null;
    if (!shown.has(doc) || !said || !node) { log(`体检：模型说的文档项对不上，丢掉：${JSON.stringify(it)}`); continue; }
    if (it.kind === 'dup') { dup.push({ doc, text: said, node: node.id }); continue; }
    if (count + questions.length >= MAX_DOC_QUESTIONS) continue;
    const key = `doc|${doc}|${norm(said)}`;
    if (asked.has(key)) continue;
    const rule = oneLine(it.rule);
    let q = null;
    if (it.kind === 'conflict' && rule) {
      const hit = node.rules.find(r => r.text === rule) || node.rules.find(r => norm(r.text) === norm(rule));
      if (!hit) { log(`体检：模型说的文档冲突规则在树里找不到，丢掉：${JSON.stringify(it)}`); continue; }
      q = {
        text: `${doc} 写着「${said}」，需求树（${node.id}）说「${hit.text}」，以哪个为准？（文档里那句之后请改掉或删掉）`,
        t: { k: 'q.docConflict', a: [doc, said, node.id, hit.text] },
        options: [
          { label: '按需求树', t: { k: 'q.optUseTree', a: [] }, ops: [] },
          { label: '按文档改需求树', t: { k: 'q.optUseDoc', a: [] }, ops: [{ op: 'replace_rule', node: node.id, old: hit.text, text: said.length <= 200 ? said : rule }] },
        ],
        default: 0,
      };
    } else if (it.kind === 'move' && rule && rule.length <= 200) {
      q = {
        text: `${doc} 里有一条需求树还没有的规则：「${rule}」。搬进需求树（${node.id}）吗？（搬了以后文档里那句可以删掉）`,
        t: { k: 'q.docMove', a: [doc, rule, node.id] },
        options: [
          { label: `加进 ${node.id}`, t: { k: 'q.optAddTo', a: [node.id] }, ops: [{ op: 'add_rule', node: node.id, text: rule }] },
          { label: '留在文档', t: { k: 'q.optKeepDoc', a: [] }, ops: [] },
        ],
        default: 0,
      };
    }
    if (q) { asked.add(key); questions.push({ source: '体检', kind: 'doc', memKey: key, ...q, defaultApplied: false }); }
  }
  return { dup, questions };
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
const crypto = require('crypto');
const fingerprint = s => crypto.createHash('md5').update(s).digest('hex');
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
    if (seen[`mem:${m.file}`] === fingerprint(body)) continue;
    notes.push({ ...m, full: body });
  }
  const docs = [];
  if (parts.docs !== false) for (const d of docList(parse(text), projectDir)) {
    let body = '';
    try { body = docText(projectDir, d.name); } catch { continue; }
    if (!body.trim() || seen[`doc:${d.name}`] === fingerprint(body)) continue;
    docs.push({ ...d, text: body });
  }
  const segs = [];
  for (const m of notes) {
    const ps = pieces(m.full);
    ps.forEach((p, i) => segs.push({ kind: 'mem', name: m.file, note: m, part: ps.length > 1 ? [i + 1, ps.length] : null,
      block: `### ${m.file}${ps.length > 1 ? `（第 ${i + 1}/${ps.length} 段）` : ''}（${m.type ? `类型 ${m.type}，` : ''}更新于 ${m.modified}）\n${p}` }));
  }
  for (const d of docs) {
    const ps = pieces(d.text);
    ps.forEach((p, i) => segs.push({ kind: 'doc', name: d.name, part: ps.length > 1 ? [i + 1, ps.length] : null,
      block: `### ${d.name}${ps.length > 1 ? `（第 ${i + 1}/${ps.length} 段）` : ''}${d.node ? `（挂在 ${d.node}）` : '（项目根，每次全文加载）'}\n${p}` }));
  }
  const batches = [];
  let cur = [], size = 0;
  for (const s of segs) {
    if (cur.length && size + s.block.length > BATCH_CHARS) { batches.push(cur); cur = []; size = 0; }
    cur.push(s); size += s.block.length;
  }
  if (cur.length) batches.push(cur);
  if (!batches.length && parts.rules !== false) batches.push([]);
  return { notes, docs, batches, calls: batches.length, memDir, seen };
}

// conflicts：false 时不找规则冲突（分批体检的后几批、或用户没选「规则」）
function buildCheckPrompt(tree, memory = '', claudeMd = '', categoryTask = '', docs = '', conflicts = true) {
  return `你是需求树的体检员。下面是一个项目的需求树（Markdown）：标题是需求，开头是 ID；标题下 "- " 开头的是规则，可带 [键]；下级用和上级同一个 [键] 的规则，是有意在本范围内覆盖上级（不算冲突）。

<需求树>
${tree}
</需求树>
${memory ? `
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
${conflicts ? `找出说法互相冲突、要用户拍板的规则：上级和下级（或同一个需求里）对同一件事说得不一样，又没有用同一个 [键] 写成覆盖。例：P「每章互动不超过4个」，C1「每章互动不超过5个」。下级只是更具体、并不冲突的不算；拿不准是不是冲突的不算。
每处冲突写成一个问题：text 是一句简短的问题，说清两条各是什么；options 是 2–3 种处理（label 几个字，ops 是这种处理完整的改动）。常用的：
- 下级算例外：[{"op":"remove_rule","node":"下级ID","text":"下级原文"},{"op":"override_rule","node":"下级ID","from":"上级ID","text":"上级原文","new":"下级原文"}]
- 统一用上级的：[{"op":"remove_rule","node":"下级ID","text":"下级原文"}]
- 两条都留着：[]
同一个需求里的两条冲突：留后面那条（remove_rule 前面的）、留前面那条（remove_rule 后面的）、两条都留着。
default 是最可能的那个选项的序号（从 0 起）。最多 ${MAX_CHECK_QUESTIONS} 个问题。
` : `这次不用找规则冲突，questions 输出空数组。
`}${memory ? MEMORY_TASK : ''}${docs ? DOC_TASK : ''}${categoryTask}
只输出 JSON，不要任何别的文字；没有冲突就输出 {"questions":[]}：
{"questions":[{"text":"全局写每章互动不超过4个，C1 写不超过5个：","options":[{"label":"C1 用5（本课例外）","ops":[...]},{"label":"统一用4","ops":[...]},{"label":"两条都留着","ops":[]}],"default":0}]${memory ? ',"memory":[{"file":"a.md","kind":"covered","where":"P"},{"file":"b.md","kind":"move","node":"C1","rules":["规则"],"whole":true},{"file":"c.md","kind":"conflict","node":"C2","rule":"树里原文","text":"记忆的说法","newer":"memory","whole":true},{"file":"d.md","kind":"stale","why":"那门课已经删了"},{"file":"e.md","kind":"doc","node":"C1"},{"file":"f.md","kind":"keep"}]' : ''}${docs ? ',"docs":[{"doc":"A/_BRIEF.md","kind":"dup","text":"文档原句","node":"C1"},{"doc":"A/_BRIEF.md","kind":"conflict","text":"文档原句","node":"C1","rule":"树里原文"},{"doc":"A/_BRIEF.md","kind":"move","text":"文档原句","node":"C1","rule":"新规则"}]' : ''}${categoryTask ? ',"categories":[{"node":"P","groups":[{"name":"写作","rules":["树里原文"]}]}]' : ''}}`;
}

// 模型对每份记忆的判断 → { remove 直接删的改动, questions 要问的 }。文件、需求、规则对不上的丢掉。
// shown / clipped：给模型看了的、被截断的文件（memoryForPrompt）。没看到的不判断；没看全的不自动删，改成问。
// asked：问过的记忆（不管问的是哪一类、怎么答的）这份记忆没改过就不再碰——用户选了「留着」，下次体检也不会被自动删掉。
// 键是「文件|修改时间」，记忆改过了才再看
const MAX_MEMORY_QUESTIONS = 12;
const noteKey = note => `mem|${note.file}|${Math.round(note.mtime)}`;
// count：前几批已经问了几个（分批体检时总数也不超过 MAX_MEMORY_QUESTIONS）。
// 返回的 toDoc：模型说是某个需求的经验、进度或背景的记忆 [{ file, node }]，只提醒挪进那个需求的文档（插件不改文档）
function memoryPlan(items, { text, dir, projectDir, notes, asked, shown, clipped = new Set(), claudeMd = '', count = 0 }) {
  const root = parse(text);
  const byFile = new Map(notes.filter(n => !shown || shown.has(n.file)).map(n => [n.file, n]));
  const del = file => ({ op: 'memory_remove', dir, file, whole: true });
  const seen = new Set();
  const remove = [], questions = [], toDoc = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it !== 'object' || typeof it.file !== 'string') continue;
    if (it.kind === 'doc') {
      const n = typeof it.node === 'string' && findById(root, it.node.trim());
      if (n && byFile.has(it.file) && !toDoc.some(d => d.file === it.file)) toDoc.push({ file: it.file, node: n.id, docs: n.docs });
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
        default: 0,
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
      const fix = { op: 'replace_rule', node: node.id, old: rule.text, text: said };
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
        default: it.newer === 'memory' ? 0 : 1,
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
    if (q) { asked.add(key); questions.push({ source: '体检', kind: 'memory', memKey: key, ...q, defaultApplied: false }); }
  }
  return { remove, questions, toDoc };
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
    default: 1, defaultApplied: false,
  };
}

const log = msg => { try { require('../hooks/recorder').log(msg); } catch {} };

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
//        toDoc 该挪进文档的记忆 [{ file, node, docs }], checked { notes, docs, calls, failed } 这次看了几份、调用几次模型、几次出错, error 最后一次调用模型出错的说明 }
async function runCheckup(treePath, { read, write, model = true, ask, memory, parts = {}, full = false, progress } = {}) {
  const rec = require('../hooks/recorder');
  const mem = require('./memory');
  const readText = read || (p => fs.readFileSync(p, 'utf8'));
  const want = { rules: parts.rules !== false, memory: parts.memory !== false && memory !== false, docs: parts.docs !== false };
  const result = { merged: [], stale: [], memory: [], removed: [], scope: [], noFiles: [], missing: [], categorized: [], questions: [],
    docs: [], docDup: [], docMissing: [], docUnlinked: [], toDoc: [], checked: { notes: 0, docs: 0, calls: 0, failed: 0 }, error: null };
  const projectDir = path.dirname(treePath);
  const asked = new Set(Q.readQuestions(treePath).map(q => q.memKey).filter(Boolean));

  if (want.rules) {
    const dups = duplicateOps(readText(treePath));
    result.merged = dups.length ? await store.applyChange(treePath, dups.map(({ why, ...o }) => o), { source: '你', write }) : [];
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
        result.scope.push(Q.addQuestion(treePath, q));
      }
    } catch (e) { rec.log('查文件对应出错：' + e.stack); }
  }
  if (want.docs) try { Object.assign(result, docProblems(readText(treePath), projectDir, treePath)); } catch (e) { rec.log('查文档出错：' + e.stack); }

  let memDir = null;
  if (want.memory) try { memDir = typeof memory === 'string' ? memory : mem.memoryDir(projectDir); } catch (e) { rec.log('找不到自动记忆：' + e.message); }
  // 不调用模型时，记忆和需求树各有一份的只能按字面（Dice ≥ 0.7）找；调用模型时交给模型逐份按分工判断
  const literalMemory = () => {
    const askMemory = d => {
      const k = mem.memKey(d);
      if (asked.has(k)) return;
      asked.add(k);
      result.memory.push(Q.addQuestion(treePath, mem.memoryQuestion(d, memDir)));
    };
    try { mem.findDuplicates(readText(treePath), memDir).forEach(askMemory); } catch (e) { rec.log('查记忆重复出错：' + e.stack); }
  };
  if (memDir && !model) literalMemory();
  if (!model) return result;

  const plan = checkPlan(treePath, { read: readText, parts: want, full, memory: memDir || false });
  result.checked = { notes: plan.notes.length, docs: plan.docs.length, calls: plan.calls, failed: 0 };
  const seen = { ...readSeen(treePath) };
  const saveSeen = () => { try { store.writeJson(store.metaFile(treePath, SEEN_FILE), seen); } catch (e) { rec.log('体检记录没存上：' + e.message); } };
  let claudeMd = '';
  try { claudeMd = clipChars(fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8'), CLAUDE_MD_CHARS); } catch {}
  const Cat = require('./categories');
  const askModel = ask || (p => rec.askJson(p, { timeoutMs: CHECK_TIMEOUT_MS }));
  const failedNames = new Set();
  let rulesDone = !want.rules;
  for (let i = 0; i < plan.batches.length; i++) {
    const batch = plan.batches[i];
    // 冲突和分组只查一次：放在第一批，第一批出错就挪到下一批
    const first = !rulesDone;
    if (progress) try { progress(i + 1, plan.batches.length); } catch {}
    try {
      const text = readText(treePath);
      const memSegs = batch.filter(s => s.kind === 'mem'), docSegs = batch.filter(s => s.kind === 'doc');
      const prompt = buildCheckPrompt(text, memSegs.map(s => s.block).join('\n\n'), memSegs.length ? claudeMd : '',
        first ? Cat.promptTask(text, Cat.read(treePath)) : '', docSegs.map(s => s.block).join('\n\n'), first);
      const out = await askModel(prompt);
      if (first) {
        rulesDone = true;
        // 规则分类：只改面板的显示方式
        if (out && Array.isArray(out.categories)) try { result.categorized = Cat.save(treePath, text, out.categories); } catch (e) { rec.log('规则分类没存上：' + e.message); }
        const ctx = { root: parse(text), unmapped: [], user: '' };
        const picked = rec.pickQuestions(out && out.questions, { text, ops: [], ctx, allowed: CHECK_OPS, max: MAX_CHECK_QUESTIONS }).questions;
        // 同样的问题还开着就不再问一遍
        const open = new Set(Q.openQuestions(treePath).map(q => q.text));
        for (const q of picked) {
          if (open.has(q.text)) continue;
          result.questions.push(Q.addQuestion(treePath, { source: '体检', text: q.text, options: q.options, default: q.default, defaultApplied: false }));
        }
      }
      if (memSegs.length && out && Array.isArray(out.memory)) {
        const shown = new Set(memSegs.map(s => s.name));
        const clipped = new Set(memSegs.filter(s => s.part).map(s => s.name));
        const mp = memoryPlan(out.memory, { text, dir: memDir, projectDir, notes: plan.notes, asked, shown, clipped, claudeMd, count: result.memory.length });
        // 已经写在树或 CLAUDE.md 里的：一起删掉，记成一条改动（先备份，面板上可以撤销）
        if (mp.remove.length) result.removed.push(...await store.applyChange(treePath, mp.remove, { source: '体检', write }));
        for (const q of mp.questions) result.memory.push(Q.addQuestion(treePath, q));
        result.toDoc.push(...mp.toDoc);
      }
      if (docSegs.length && out && Array.isArray(out.docs)) {
        const dp = docPlan(out.docs, { text, shown: new Set(docSegs.map(s => s.name)), asked, count: result.docs.length });
        result.docDup.push(...dp.dup);
        for (const q of dp.questions) result.docs.push(Q.addQuestion(treePath, q));
      }
      // 这一批看完了：记下指纹，下次没改过就不再看（切成几段的，最后一段看完才记）
      for (const s of batch) {
        if (failedNames.has(s.name) || (s.part && s.part[0] !== s.part[1])) continue;
        if (s.kind === 'mem') seen[`mem:${s.name}`] = fingerprint(s.note.full);
        else { const d = plan.docs.find(x => x.name === s.name); if (d) seen[`doc:${s.name}`] = fingerprint(d.text); }
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
  if (memDir && plan.calls && result.checked.failed === plan.calls) literalMemory();
  rec.log(`体检：看了 ${plan.notes.length} 份记忆、${plan.docs.length} 份文档，调用模型 ${plan.calls} 次（出错 ${result.checked.failed} 次）；问用户 ${result.questions.length} 个冲突、${result.memory.length} 个记忆问题、${result.docs.length} 个文档问题；删掉 ${result.removed.length} 份已在树里的记忆`);
  return result;
}

module.exports = { duplicateOps, buildCheckPrompt, runCheckup, checkPlan, memoryPlan, docPlan, docProblems, scopeProblems, CHECK_OPS };
