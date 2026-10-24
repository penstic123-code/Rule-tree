'use strict';
// 用 AI 初始化需求树。设计见 设计-信息架构.md 第七节。
// 读项目的文件夹、README、CLAUDE.md / AGENTS.md、最近的 git 提交，让模型一次给出：
//   需求：按「要做的事」分（登录、支付、第 1 章），不按文件夹分；每个带文件范围和状态
//   拆分：CLAUDE.md / AGENTS.md 里大段的参考资料（流程、技术约束、风格说明）搬成单独的文档，挂到对应需求上
// 程序照着做，直接生效：写需求树；那几节原样搬进新文档（一个字不改写），原处只留标题和一行「见某文档」。
// 整个初始化记成一条改动（来源「初始化」），面板上一键撤销：每个文件改之前整份备份到 .reqtree/doc-backup/，撤销时整份放回。
// 规则（以后都要照做的要求）不在这一步搬：初始化之后接着跑一次体检（只查文档和记忆），由体检原有的逻辑
// 把 CLAUDE.md 和挂上的文档里写成规则的句子搬进树。
// 模型调用失败、没装 Claude、模型给的东西一个都用不上：用 store.initialTree（按文件夹）
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const store = require('./store');
const Docs = require('./docs');
const { parse, walk, globToRegExp, STATUS_EMOJI, applyOps } = require('./parser');

const INIT_CMD = process.env.REQTREE_INIT_CMD
  || 'claude -p --model sonnet --strict-mcp-config --no-session-persistence --setting-sources user';
const INIT_TIMEOUT_MS = +process.env.REQTREE_INIT_TIMEOUT_MS || 300000;
const EDITING = '需求树在编辑器里有没保存的改动，这次没写；保存后在命令面板运行「需求树：体检」再试';
const ENTRY_DOCS = ['CLAUDE.md', 'AGENTS.md'];
const MAX_TOP = 15, MAX_CHILDREN = 10;
const SPLIT_MIN_DOC = 3000;   // 入口文档不到这么多字不拆
const SPLIT_MIN_SECTION = 400; // 一节不到这么多字不值得单独成文档
const clip = (s, max) => { const a = [...s]; return a.length > max ? a.slice(0, max).join('') + '\n…（后面截断）' : s; };
const chars = s => [...s].length;
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const oneLine = (s, max = 40) => [...String(s || '').replace(/[\r\n#]+/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('');

// 说明文档：Markdown，不算 README、入口文档、需求树本身，也不算测试样例、依赖里的
const isDoc = f => /\.md$/i.test(f) && !/(^|\/)(README[^/]*|CHANGELOG[^/]*|LICENSE[^/]*|需求树\.md|[^/]*\.tree\.md)$/i.test(f) && !ENTRY_DOCS.includes(f)
  && !/(^|\/)(tests?|fixtures|__tests__|node_modules|vendor|addons)\//i.test(f);
const MAX_DOCS = 4; // 每个需求最多挂几份文档（每份都会写进「动手前先读」）

// 项目的语言：入口文档和 README 里汉字多就是中文
function projectLang(texts) {
  const t = texts.join('\n');
  const han = (t.match(/[一-鿿]/g) || []).length;
  const latin = (t.match(/[A-Za-z]+/g) || []).length;
  return han > latin ? 'zh' : 'en';
}

// 文件夹概览：每个文件夹（最多三层）有几个文件，按文件数排，最多 MAX 行
function folderSummary(files, max = 150) {
  const count = new Map();
  for (const f of files) {
    const parts = f.split('/');
    for (let d = 1; d < Math.min(parts.length, 4); d++) {
      const k = parts.slice(0, d).join('/') + '/';
      count.set(k, (count.get(k) || 0) + 1);
    }
  }
  const root = files.filter(f => !f.includes('/'));
  const dirs = [...count].sort((a, b) => a[0].localeCompare(b[0])).slice(0, max).map(([d, n]) => `${d}（${n} 个文件）`);
  return [...dirs, ...(root.length ? [`根目录文件：${root.slice(0, 40).join('、')}`] : [])].join('\n');
}

// 最近的提交：标题和改到的文件夹（判断哪些需求在进行中）
function gitSummary(dir) {
  const r = spawnSync('git', ['log', '-n', '40', '--since=90.days', '--name-only', '--format=@@%cs %s'], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 32 << 20 });
  if (r.status !== 0 || !r.stdout) return '';
  const out = [];
  for (const block of r.stdout.split('@@').filter(Boolean)) {
    const [head, ...files] = block.split('\n').filter(Boolean);
    const dirs = [...new Set(files.map(f => f.split('/').slice(0, 2).join('/')))].slice(0, 6);
    out.push(`- ${oneLine(head, 90)}${dirs.length ? `（${dirs.join('、')}）` : ''}`);
  }
  return out.join('\n');
}

// 还没真正初始化过的树：模板里的标题（项目名、第一个需求）都还在，或者还是按文件夹生成的（开头那句说明还在），
// 只是记录员往里记了规则。这种树可以（重新）初始化：已经记下的规则不丢，交给模型分到新的需求下面（原文不改）
const TEMPLATE_RULES = new Set([...walk(parse(store.TEMPLATE))].flatMap(n => n.rules.map(r => r.text)));
function templateShaped(text) {
  const t = String(text || '');
  return (/^# P 项目名\s*$/m.test(t) && /^## R1 第一个需求/m.test(t)) || t.includes(store.FOLDER_INTRO);
}
// 树里已经有的规则（去掉模板自带的示例规则）：[{ key, text }]
function existingRules(text) {
  if (!text) return [];
  return [...walk(parse(text))].flatMap(n => n.rules).filter(r => !TEMPLATE_RULES.has(r.text)).map(r => ({ key: r.key || null, text: r.text }));
}

// 交给模型的材料。treeText：要重新初始化的模板样子的树（里面的规则要分下去）
function gather(dir, treeText = '') {
  let files = [];
  try { files = require('./codemap').listFiles(dir, { any: true }); } catch {}
  files = files.filter(f => !f.startsWith('.reqtree/') && !f.startsWith('.claude/'));
  const readme = ['README.md', 'readme.md', 'README.zh.md', 'README'].map(f => read(path.join(dir, f))).find(Boolean) || '';
  const entries = ENTRY_DOCS.map(f => ({ file: f, text: read(path.join(dir, f)) })).filter(e => e.text.trim());
  const rules = existingRules(treeText);
  return { files, readme, entries, rules, git: gitSummary(dir), lang: projectLang([...entries.map(e => e.text), readme, ...rules.map(r => r.text)]) };
}

function buildPrompt(g) {
  const lang = g.lang === 'zh' ? '中文' : 'English';
  const entryText = g.entries.map(e => {
    const secs = Docs.sections(e.text).filter(h => h.level >= 2)
      .map(h => `  ${h.title}（第 ${h.start}–${h.end} 行，约 ${chars(e.text.split(/\r?\n/).slice(h.start - 1, h.end).join('\n'))} 字）`).join('\n');
    return `### ${e.file}（共约 ${chars(e.text)} 字）\n各节：\n${secs || '  （没有小标题）'}\n\n全文：\n${clip(e.text, 30000)}`;
  }).join('\n\n');
  return `你在帮一个用 AI 写代码的人给他的项目建一棵「需求树」。需求树是一份 Markdown：每个标题是一件要做的事（需求），可以有子需求；需求下面写它对应哪些文件。之后 AI 改到这些文件时，会自动读到这个需求的规则和背景文档。

按「要做的事」分需求，不按文件夹分：
- 好的需求名：用户登录、支付、第 1 章、关卡编辑器、数据导入。不好的：src、utils、test、assets、misc。
- 一个文件夹里有几件事就拆几个需求；几个文件夹合起来是一件事就合成一个，files 写多条。
- 测试、配置、构建脚本这类辅助文件，跟着它服务的那件事走，不单独建需求（除非项目本身就是在做它）。
- 顶层需求 3–12 个。某件事明显由几块组成（一门课的几章、一个游戏的几个系统）时才建子需求，每个最多 ${MAX_CHILDREN} 个。最多两层。
- id：顶层 R1、R2…，子需求 R1.1、R1.2…
- files 是 glob，相对项目根目录，例：src/auth/**、course/ch01-*.html。只写下面文件概览里真有的路径。子需求的 files 要落在上级的范围里。
- docs 是讲这件事的说明文档（设计文档、规范、章节表），从下面的「文档」里挑，写完整路径，每个需求最多 ${MAX_DOCS} 份，挑最主要的（总说明、规范、进度），分章的细稿不挂；AI 改到这个需求的文件时会先读它们。说明文档写进 docs，不写进 files。
- status：最近的提交还在改的写 "doing"；文档里列为计划、还没开始的写 "todo"；明确做完、最近没动的写 "done"；看不出写 null。

CLAUDE.md、AGENTS.md 每个会话都整份加载，越短越好。里面大段的参考资料（工作流程、技术约束、风格说明、目录结构详解这类，单节几百字以上），列进 split：
- 那一节原样搬进一份新文档 to（例：docs/workflow.md、规范/工作流.md，用文档的语言起名，放在合适的文件夹），原处只留标题和一行「见那份文档」。
- 不搬：项目简介、「东西在哪」这类入口说明、只有几行的节、全项目都要遵守的少数几条要求、和人沟通的偏好。
- section 写那一节标题的原文；只拆 ## 或更深的节，几节内容相关可以搬进同一份文档（各写一项，to 相同）。
- node 写这份文档挂到哪个需求的 id；全项目都要看的写 ""（挂到根上）。
- purpose 用一句话写这份文档的用途。
- 文档总共不到 ${SPLIT_MIN_DOC} 字就不拆，split 给 []。

${g.rules.length ? `树里已经记下了 ${g.rules.length} 条规则（见最后），把每条分到一个需求下，写进 rules：只管某件事的放到那个需求或子需求；全项目都要遵守的（协作方式、和人沟通、通用的代码和文档规范）node 写 ""，留在根上。只给编号，规则原文不改，每条只放一处。
` : ''}project 写项目名（几个字）。需求名、用途都用项目文档的语言（${lang}）。

只输出 JSON，不要别的：
{"project":"项目名","nodes":[{"id":"R1","title":"需求名","status":"doing","files":["src/auth/**"],"docs":["docs/auth.md"],"children":[{"id":"R1.1","title":"...","status":null,"files":["..."]}]}],"split":[{"doc":"CLAUDE.md","section":"节标题原文","to":"docs/workflow.md","node":"R1","purpose":"一句话用途"}]${g.rules.length ? ',"rules":[{"i":1,"node":"R2"},{"i":2,"node":""}]' : ''}}

## 文件概览（共 ${g.files.length} 个文件）
${folderSummary(g.files)}

## 文档
${g.files.filter(isDoc).slice(0, 80).join('\n') || '（没有）'}

## README
${g.readme ? clip(g.readme, 4000) : '（没有）'}

## 最近的提交
${g.git || '（没有 git 记录）'}

## 入口文档
${entryText || '（没有 CLAUDE.md、AGENTS.md）'}
${g.rules.length ? `
## 已经记下的规则
${g.rules.map((r, i) => `${i + 1}. ${r.text}`).join('\n')}
` : ''}`;
}

// 模型给的东西 → 能用的部分：需求（重新编号、文件范围只留真能匹配到文件的）和拆分（节要找得到、目标文件要合法且不存在）
function plan(dir, g, out) {
  const matchesAny = glob => { const re = globToRegExp(glob); return g.files.some(f => re.test(f)); };
  const idMap = new Map();
  const cleanNode = (n, id, depth) => {
    const title = oneLine(n && n.title);
    if (!title) return null;
    if (n.id) idMap.set(String(n.id).trim(), id);
    const list = (Array.isArray(n.files) ? n.files : []).map(x => oneLine(x, 200)).filter(Boolean);
    // 说明文档挂成背景文档：模型写进 docs 的，和误写进 files 的单个 .md 文件
    const docs = [...new Set([...(Array.isArray(n.docs) ? n.docs : []).map(x => oneLine(x, 200)), ...list.filter(isDoc)])].filter(d => isDoc(d) && g.files.includes(d)).slice(0, MAX_DOCS);
    const files = [...new Set(list.filter(x => !docs.includes(x)))].filter(matchesAny);
    const status = ['doing', 'todo', 'done'].includes(n.status) ? n.status : null;
    const kids = depth < 2 && Array.isArray(n.children) ? n.children : [];
    const children = [];
    for (const c of kids.slice(0, MAX_CHILDREN)) {
      const cn = cleanNode(c, `${id}.${children.length + 1}`, depth + 1);
      if (cn) children.push(cn);
    }
    return { id, title, status, files, children, docs, rules: [] };
  };
  const nodes = [];
  for (const n of (Array.isArray(out.nodes) ? out.nodes : []).slice(0, MAX_TOP)) {
    const cn = cleanNode(n, `R${nodes.length + 1}`, 1);
    if (cn) nodes.push(cn);
  }
  const byId = new Map();
  const walkNodes = list => { for (const n of list) { byId.set(n.id, n); walkNodes(n.children); } };
  walkNodes(nodes);

  // 拆分：同一份入口文档里，节不能重叠
  const rootDocs = [];
  const moves = []; // { doc, title, start, end, to, purpose }
  const taken = new Set();
  for (const s of Array.isArray(out.split) ? out.split : []) {
    if (!s || typeof s !== 'object') continue;
    const entry = g.entries.find(e => e.file === String(s.doc || '').trim());
    if (!entry || chars(entry.text) < SPLIT_MIN_DOC) continue;
    const h = Docs.findSection(entry.text, String(s.section || ''));
    if (!h || h.level < 2) continue;
    const body = entry.text.split(/\r?\n/).slice(h.start - 1, h.end).join('\n');
    if (chars(body) < SPLIT_MIN_SECTION) continue;
    if (moves.some(m => m.doc === entry.file && h.start <= m.end && m.start <= h.end)) continue;
    const to = String(s.to || '').trim().replace(/\\/g, '/');
    if (!/\.md$/i.test(to) || /^\.|\/\./.test(to) || ENTRY_DOCS.includes(to) || !Docs.resolve(dir, to)) continue;
    if (fs.existsSync(path.join(dir, to)) && !taken.has(to)) continue;
    taken.add(to);
    moves.push({ doc: entry.file, title: h.title, start: h.start, end: h.end, to, purpose: oneLine(s.purpose, 80) });
    // 挂到需求上（每个最多 MAX_DOCS 份）；挂满了的只靠 CLAUDE.md 原处那一行指路
    const target = byId.get(idMap.get(String(s.node || '').trim()));
    const list = target ? target.docs : rootDocs;
    if (!list.includes(to) && list.length < MAX_DOCS) list.push(to);
  }
  // 已有的规则：按模型给的编号放到需求下；没分到、分错的留在根上，一条都不丢
  const rootRules = [];
  const placed = new Map();
  for (const x of Array.isArray(out.rules) ? out.rules : []) {
    const i = Number(x && x.i) - 1;
    if (!(i >= 0 && i < g.rules.length) || placed.has(i)) continue;
    const target = byId.get(idMap.get(String(x.node || '').trim()));
    if (target) placed.set(i, target);
  }
  g.rules.forEach((r, i) => (placed.has(i) ? placed.get(i).rules : rootRules).push(r));
  return { project: oneLine(out.project, 30) || path.basename(dir), nodes, rootDocs, rootRules, moves };
}

const STRINGS = {
  zh: {
    intro: '这棵树由 AI 读项目后生成，每个标题是一件要做的事。改名、合并、删掉都行；你和 AI 聊天时提的长期要求，会自动记到对应的需求下面。',
    see: to => `见 \`${to}\`（改到相关文件时，需求树会提醒先读）。`,
    purpose: p => `用途：${p}`,
  },
  en: {
    intro: 'This tree was generated by AI from the project. Each heading is one thing the project does. Rename, merge or delete freely; long-term requests you make while chatting with the AI are recorded under the matching requirement.',
    see: to => `See \`${to}\` (the requirement tree reminds the AI to read it when working on related files).`,
    purpose: p => `Purpose: ${p}`,
  },
};

function renderTree(p, lang) {
  const S = STRINGS[lang];
  const docsLine = list => (list.length ? [`> ${lang === 'zh' ? '文档' : 'docs'}：${list.join(', ')}`] : []);
  const filesLine = list => (list.length ? [`> ${lang === 'zh' ? '文件' : 'files'}：${list.join(', ')}`] : []);
  const ruleLines = list => (list || []).map(r => `- ${r.key ? `[${r.key}] ` : ''}${r.text}`);
  const lines = [`# P ${p.project}`, S.intro, ...docsLine(p.rootDocs), ...ruleLines(p.rootRules), ''];
  const put = (n, level) => {
    lines.push(`${'#'.repeat(level)} ${n.id} ${n.title}${n.status ? ' ' + STATUS_EMOJI[n.status] : ''}`, ...filesLine(n.files), ...docsLine(n.docs), ...ruleLines(n.rules), '');
    for (const c of n.children) put(c, level + 1);
  };
  for (const n of p.nodes) put(n, 2);
  return lines.join('\n');
}

// 拆分后的入口文档和新文档的内容
function renderMoves(g, p, lang) {
  const S = STRINGS[lang];
  const writes = new Map(); // 相对路径 → 内容
  for (const e of g.entries) {
    const mine = p.moves.filter(m => m.doc === e.file).sort((a, b) => b.start - a.start);
    if (!mine.length) continue;
    const nl = /\r\n/.test(e.text) ? '\r\n' : '\n';
    const lines = e.text.split(/\r?\n/);
    // 从后往前换，前面的行号不受影响
    for (const m of mine) lines.splice(m.start, m.end - m.start, '', S.see(m.to), '');
    writes.set(e.file, lines.join(nl));
  }
  const parts = new Map();
  for (const m of p.moves) {
    const e = g.entries.find(x => x.file === m.doc);
    const body = e.text.split(/\r?\n/).slice(m.start - 1, m.end).join('\n').trim();
    if (!parts.has(m.to)) parts.set(m.to, { purpose: m.purpose, bodies: [] });
    parts.get(m.to).bodies.push(body);
  }
  for (const [to, v] of parts) writes.set(to, `${v.purpose ? S.purpose(v.purpose) + '\n\n' : ''}${v.bodies.join('\n\n')}\n`);
  return writes;
}

// 只算出要写什么，不动文件（测试和预览用）。ask：调用模型的函数（测试里换成假的）
async function propose(dir, { ask, treeText = '' } = {}) {
  const g = gather(dir, treeText);
  const askJson = ask || (prompt => require('../hooks/recorder').askJson(prompt, { timeoutMs: INIT_TIMEOUT_MS, cmd: INIT_CMD }));
  const out = await askJson(buildPrompt(g));
  const p = plan(dir, g, out || {});
  if (!p.nodes.length) throw new Error('模型没有给出能用的需求');
  return { g, plan: p, tree: renderTree(p, g.lang), writes: renderMoves(g, p, g.lang) };
}

// 初始化。树已经存在、而且不是没动过的模板时不做（返回 { skipped: 'exists' }）。
// 先保证有一棵按文件夹生成的树（撤销初始化就回到它），再把 AI 的结果作为一条改动写进去。
// 返回 { treePath, ai: true/false, nodes, moves, changeId, error }
async function initProject(dir, { ask, treeName = '需求树.md' } = {}) {
  let treePath = store.findTree(dir);
  if (treePath) {
    const t = read(treePath).replace(/\r\n/g, '\n');
    if (t !== store.TEMPLATE && !templateShaped(t)) return { treePath, skipped: 'exists' };
  } else {
    treePath = path.join(dir, treeName);
    fs.writeFileSync(treePath, store.initialTree(dir));
  }
  store.ensureTracking(treePath);
  const before = read(treePath);
  let r;
  try { r = await propose(dir, { ask, treeText: before }); } catch (error) {
    store.compileTree(treePath, { force: true });
    return { treePath, ai: false, error };
  }
  // 用户这期间在编辑器里改树、还没保存：整份写盘会和编辑器里的内容打架，这次不写（下次打开再试）
  if (store.isEditing(treePath)) return { treePath, ai: false, error: new Error(EDITING) };
  // 等模型的这几十秒里，别的会话的记录员可能往树里记了新规则：整棵写回前把它们放到新树的根上，不丢
  let treeText = r.tree;
  const seen = new Set(existingRules(before).map(x => x.text));
  const added = existingRules(read(treePath)).filter(x => !seen.has(x.text));
  if (added.length) treeText = applyOps(treeText, added.map(x => ({ op: 'add_rule', node: parse(treeText).children[0].id, text: x.text, force: true }))).text;
  const rel = path.relative(dir, treePath).replace(/\\/g, '/');
  const ops = [{ op: 'doc_write', file: rel, text: treeText }, ...[...r.writes].map(([file, text]) => ({ op: 'doc_write', file, text }))];
  const id = `${Date.now().toString(36)}init`;
  const applied = store.applyChange(treePath, ops, { source: '初始化', id });
  store.compileTree(treePath, { force: true });
  return { treePath, ai: true, nodes: r.plan.nodes, moves: r.plan.moves, changeId: applied.length ? id : null, lang: r.g.lang };
}

module.exports = { templateShaped, existingRules, gather, buildPrompt, plan, renderTree, renderMoves, propose, initProject, projectLang, folderSummary };
