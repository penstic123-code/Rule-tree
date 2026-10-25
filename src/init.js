'use strict';
// 用 AI 初始化、重新整理需求树。设计见 docs/design-info-architecture.md 第七节。
// 读项目的文件夹、README、CLAUDE.md / AGENTS.md、最近的 git 提交、树里已有的规则，让模型一次给出：
//   需求：先定结构，再挂规则。按「要做的事」分（登录、支付、第 1 章），不按文件夹分；一件事由几块组成就往下拆，
//         深浅看内容（规则多、块多的拆得深，最多 MAX_DEPTH 层）；每个带文件范围和状态
//   规则：已有的每条（原文不改）挂到管它那些文件的最小需求上
//   拆分（只在初始化时）：CLAUDE.md / AGENTS.md 里大段的参考资料（流程、技术约束、风格说明）搬成单独的文档，挂到对应需求上
// 程序照着做，直接生效：写需求树；那几节原样搬进新文档（一个字不改写），原处只留标题和一行「见某文档」。
// 整个初始化记成一条改动（来源「初始化」/「整理」），面板上一键撤销：每个文件改之前整份备份到 .reqtree/doc-backup/，撤销时整份放回。
// 文档里写成规则的句子不在这一步搬：初始化之后接着跑一次体检（只查文档和记忆），由体检原有的逻辑搬进树。
// 重新整理（reorganize）：对已经初始化过的树做同样的事。树长歪了（一个需求挂几十条规则、只有一层、规则挂错地方）时用，
// 体检看到这些迹象也会自动做一次（同一棵树只做一次，见 needsReorganize）。
// 模型调用失败、没装 Claude、模型给的东西一个都用不上：初始化用 store.initialTree（按文件夹），整理什么都不动
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const store = require('./store');
const Docs = require('./docs');
const { parse, walk, findById, globToRegExp, STATUS_EMOJI, applyOps } = require('./parser');
const { isRoot } = require('./common');

// 换了记录员的模型命令（REQTREE_CLAUDE_CMD，测试里换成假的）又没单独给初始化的，初始化也用它
const INIT_CMD = process.env.REQTREE_INIT_CMD || process.env.REQTREE_CLAUDE_CMD
  || 'claude -p --model sonnet --strict-mcp-config --no-session-persistence --setting-sources user';
const INIT_TIMEOUT_MS = +process.env.REQTREE_INIT_TIMEOUT_MS || 300000;
const EDITING = '需求树在编辑器里有没保存的改动，这次没写；保存后在命令面板运行「需求树：体检」再试';
const ENTRY_DOCS = ['CLAUDE.md', 'AGENTS.md'];
const MAX_TOP = 15, MAX_CHILDREN = 10, MAX_NODES = 120;
// 需求最多几层：需求树是 Markdown 标题，项目名占 #，需求从 ## 到 ######
const MAX_DEPTH = 5;
// 一个需求的规则到这么多条，多半该往下拆（给模型的参考，也是体检自动整理的迹象之一）
const MANY_RULES = 12;
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
const OUTLINE_DOCS = 80, OUTLINE_HEADS = 8, OUTLINE_CHARS = 12000;

// 每份说明文档的用途和前几个一、二级标题：只给文件名的话，模型能看到的几乎只有文件夹结构，
// 分出来的需求还是贴着文件夹（2026-10-25 用户反馈）。总共不超过 OUTLINE_CHARS 字
function docOutline(dir, files) {
  const out = [];
  let total = 0;
  for (const f of files.filter(isDoc).slice(0, OUTLINE_DOCS)) {
    const text = read(path.join(dir, f));
    const heads = Docs.sections(text).filter(h => h.level <= 2).slice(0, OUTLINE_HEADS).map(h => h.title);
    const use = Docs.purpose(dir, f);
    const line = `- ${f}${use && !heads.includes(use) ? `：${use}` : ''}${heads.length ? `（${heads.join(' / ')}）` : ''}`;
    if (total + chars(line) > OUTLINE_CHARS) { out.push(`- …还有 ${files.filter(isDoc).length - out.length} 份没列`); break; }
    total += chars(line);
    out.push(line);
  }
  return out.join('\n');
}

// 项目的语言：入口文档和 README 里汉字多就是中文
function projectLang(texts) {
  const t = texts.join('\n');
  const han = (t.match(/[一-鿿]/g) || []).length;
  const latin = (t.match(/[A-Za-z]+/g) || []).length;
  return han > latin ? 'zh' : 'en';
}

// 文件夹概览：每个文件夹（最多四层，往下拆子需求要看到更细的文件夹）有几个文件，按路径排，最多 MAX 行
function folderSummary(files, max = 250) {
  const count = new Map();
  for (const f of files) {
    const parts = f.split('/');
    for (let d = 1; d < Math.min(parts.length, 5); d++) {
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
// 树里已经有的规则（去掉模板自带的示例规则）：[{ key, text, node 现在挂在哪 }]
function existingRules(text) {
  if (!text) return [];
  return [...walk(parse(text))].flatMap(n => n.rules).filter(r => !TEMPLATE_RULES.has(r.text)).map(r => ({ key: r.key || null, text: r.text, node: r.owner.id }));
}

// 重新整理时给模型看的现有结构（不含规则，规则另列）：每个需求的编号、名字、状态、文件、文档
function treeOutline(text) {
  const out = [];
  for (const n of walk(parse(text))) {
    const pad = '  '.repeat(Math.max(0, n.level - 1));
    out.push(`${pad}- ${n.id} ${n.title}${n.status ? ' ' + STATUS_EMOJI[n.status] : ''}（${n.rules.length} 条规则）${n.files.length ? `，文件：${n.files.join(', ')}` : ''}${n.docs.length ? `，文档：${n.docs.join(', ')}` : ''}`);
  }
  return out.join('\n');
}

// 代码的用途和谁在用它（代码地图算出来的）：分代码类的需求最该看依赖关系，一组互相调用、为同一件事服务的文件就是一块。
// 只列被 3 个以上文件用的，按用的多少排；用的人散在很多文件夹的标「公共」（谁都用，不该划进某一块，2026-10-25 用户定）。
// 重新整理时再列出现在可能挂错的文件（几乎只被另一个需求的文件用，见 codemap.placement）
const CODE_LINES = 80, CODE_CHARS = 7000;
function codeOutline(dir, old) {
  const C = require('./codemap');
  let g;
  try { g = C.build(dir); } catch { return { text: '', misplaced: '' }; }
  const folder = f => f.split('/').slice(0, -1).slice(0, 3).join('/') || '（根目录）';
  // 测试、工具脚本只是辅助，不算「谁在用」（见 codemap.placement）
  const real = users => [...users].filter(u => !C.HELPER.test(u));
  // 公共：已有需求树时按需求算（被 3 个以上顶层需求用），没有时按文件夹算（用的人分散，最多的文件夹不到一半）
  const shared = old ? new Set(C.placement(g, old).filter(p => p.shared).map(p => p.file)) : null;
  const lines = [];
  let total = 0;
  const top = [...g.refs].filter(([f]) => !C.HELPER.test(f)).map(([f, u]) => [f, real(u)]).filter(([, u]) => u.length >= 3)
    .sort((a, b) => b[1].length - a[1].length).slice(0, CODE_LINES);
  for (const [file, users] of top) {
    const by = new Map();
    for (const u of users) by.set(folder(u), (by.get(folder(u)) || 0) + 1);
    const list = [...by].sort((a, b) => b[1] - a[1]);
    const common = shared ? shared.has(file) : list.length >= 3 && list[0][1] < users.length / 2;
    const info = g.files.get(file);
    const sum = info && info.summary ? `：${oneLine(info.summary.split(/[。；;]/)[0], 40)}` : '';
    const line = `- ${file}${sum}（被 ${users.length} 个文件用${common ? '，公共' : ''}：${list.slice(0, 3).map(([d, n]) => `${d} ${n}`).join('、')}）`;
    if (total + chars(line) > CODE_CHARS) break;
    total += chars(line);
    lines.push(line);
  }
  let misplaced = '';
  if (old) {
    const pl = C.placement(g, old).filter(p => p.misplaced).slice(0, 20);
    misplaced = pl.map(p => `- ${p.file} 现在${p.node ? `归 ${p.node}` : '不归任何需求'}，用它的文件里 ${p.by[0][1]} 个在 ${p.misplaced}`).join('\n');
  }
  return { text: lines.join('\n'), misplaced };
}

// 交给模型的材料。treeText：要（重新）分下去的树里的规则；reorganize：重新整理已有的树（模型看得到现有结构）
function gather(dir, treeText = '', { reorganize = false } = {}) {
  let files = [];
  try { files = require('./codemap').listFiles(dir, { any: true }); } catch {}
  // 备份、副本文件夹不给模型看：不会被分成需求，里面的文档也不会挂上（见 structure.isBackup）
  const { isBackup } = require('./structure');
  files = files.filter(f => !f.startsWith('.reqtree/') && !f.startsWith('.claude/') && !isBackup(f));
  const readme = ['README.md', 'readme.md', 'README.zh.md', 'README'].map(f => read(path.join(dir, f))).find(Boolean) || '';
  const entries = ENTRY_DOCS.map(f => ({ file: f, text: read(path.join(dir, f)) })).filter(e => e.text.trim());
  const rules = existingRules(treeText);
  // 程序运行时读的 .md 不算说明文档（见 docs.isProgramData）
  const cache = new Map();
  const data = new Set(files.filter(f => isDoc(f) && Docs.isProgramData(dir, f, cache)));
  const old = reorganize ? parse(treeText) : null;
  const code = codeOutline(dir, old);
  return { files, data, readme, entries, rules, reorganize, outline: reorganize ? treeOutline(treeText) : '', old, code: code.text, misplaced: code.misplaced,
    git: gitSummary(dir), docs: docOutline(dir, files.filter(f => !data.has(f))), lang: projectLang([...entries.map(e => e.text), readme, ...rules.map(r => r.text)]) };
}

function buildPrompt(g) {
  const lang = g.lang === 'zh' ? '中文' : 'English';
  const entryText = g.entries.map(e => {
    const secs = Docs.sections(e.text).filter(h => h.level >= 2)
      .map(h => `  ${h.title}（第 ${h.start}–${h.end} 行，约 ${chars(e.text.split(/\r?\n/).slice(h.start - 1, h.end).join('\n'))} 字）`).join('\n');
    return `### ${e.file}（共约 ${chars(e.text)} 字）\n各节：\n${secs || '  （没有小标题）'}\n\n全文：\n${clip(e.text, 30000)}`;
  }).join('\n\n');
  const split = !g.reorganize;
  return `你在帮一个用 AI 写代码的人${g.reorganize ? '重新整理他项目的' : '给他的项目建一棵'}「需求树」。需求树是一份 Markdown：每个标题是一件要做的事（需求），可以一层层往下分子需求；需求下面写它对应哪些文件和规则。之后 AI 改到某个文件时，范围覆盖这个文件的需求的规则和背景文档都会自动送到它手上，所以需求分得越贴切，AI 每次拿到的规则越准、越少。
${g.reorganize ? `
现在这棵树长歪了（一个需求挂了几十条规则、该分的没分、规则挂错了地方）。把它当成一个新项目重新分，现有的结构只作参考（见最后「现在的需求树」）；说的是同一件事的需求沿用原来的 id 和名字。
` : ''}
先定结构，再挂规则。按「要做的事」分需求，不按文件夹分：
1. 先从 README、文档的标题、最近的提交${g.rules.length ? '、已经记下的规则（它们说明用户关心哪些事）' : ''}里看出这个项目在做、在维护哪几件事（用户眼里的功能、内容、系统），这就是顶层需求。文件夹结构只是参考。
2. 一件事由几块组成（一门课的几章、一个游戏的几个系统、几类店铺、几种设施），就往下拆成子需求，子需求还能分就接着分。拆到多深看内容：一个需求预计有 ${MANY_RULES} 条以上规则，或者里面有几块各有各的做法，就往下拆；只剩几条规则、再拆也说不出不同做法的，就停。最多 ${MAX_DEPTH} 层，一般 2–4 层。每个需求最多 ${MAX_CHILDREN} 个子需求。
3. 再给每个需求挂上实现它的文件。几个文件夹合起来是一件事就写多条 files；同一个文件可以挂在几个需求下。子需求尽量写更窄的文件（这一块自己的文件夹、场景、数据文件），这样改这一块时只送这一块的规则；找不到更窄的文件就不写 files，沿用上级的。挂不上的文件不用硬塞。顶层需求之间的范围尽量不重叠（一个文件夹整个给了一个需求，就不要再把它的子文件夹给另一个顶层需求）。
${g.code ? `- 代码按依赖分：看下面「代码」里每个文件的用途和谁在用它，一组互相调用、为同一件事服务的文件归同一个需求。标「公共」的模块（被很多块共用）不属于其中哪一块：不要因为某一块用它多就划进那一块，也不用为它单独建需求。
` : ''}- 好的需求名：用户登录、支付、第 1 章、关卡编辑器、数据导入、公园与绿道。不好的：src、utils、test、assets、misc。
- 按文件类型来的通用做法（所有代码怎么写、所有文档怎么写、所有界面的样式），单独建需求，files 写按类型的 glob（如 **/*.gd、**/*.md）；代码和文档分开建。
- 测试、配置、构建脚本这类辅助文件，跟着它服务的那件事走，不单独建需求（除非项目本身就是在做它）。
- 顶层需求 3–12 个。
- id：顶层 R1、R2…，子需求在上级 id 后面加 .序号：R1.1、R1.1.2…${g.reorganize ? '（重新整理时，同一件事沿用现在的 id）' : ''}
- 只是把几块归在一起的上级需求可以不写 files，程序会用子需求的文件合起来。
- files 是 glob，相对项目根目录，例：src/auth/**、course/ch01-*.html。只写下面文件概览里真有的路径。子需求的 files 要落在上级的范围里。
- docs 是讲这件事的说明文档（设计文档、规范、章节表），从下面的「文档」里挑，写完整路径（可以带 #节名 只挂一节），每个需求最多 ${MAX_DOCS} 份，挑最主要的（总说明、规范、进度），分章的细稿不挂；AI 改到这个需求的文件时会先读它们。说明文档写进 docs，不写进 files。${g.reorganize ? '现在挂着的文档都要挂到新结构里对应的需求上。' : ''}
- status：最近的提交还在改的写 "doing"；文档里列为计划、还没开始的写 "todo"；明确做完、最近没动的写 "done"；看不出写 null。${g.reorganize ? '现有需求的状态没理由就不改。' : ''}
${split ? `
CLAUDE.md、AGENTS.md 每个会话都整份加载，越短越好。里面大段的参考资料（工作流程、技术约束、风格说明、目录结构详解这类，单节几百字以上），列进 split：
- 那一节原样搬进一份新文档 to（例：docs/workflow.md、规范/工作流.md，用文档的语言起名，放在合适的文件夹），原处只留标题和一行「见那份文档」。
- 不搬：项目简介、「东西在哪」这类入口说明、只有几行的节、全项目都要遵守的少数几条要求、和人沟通的偏好。
- section 写那一节标题的原文；只拆 ## 或更深的节，几节内容相关可以搬进同一份文档（各写一项，to 相同）。
- node 写这份文档挂到哪个需求的 id；全项目都要看的写 ""（挂到根上）。
- purpose 用一句话写这份文档的用途。
- 文档总共不到 ${SPLIT_MIN_DOC} 字就不拆，split 给 []。
` : ''}
${g.rules.length ? `树里已经记下了 ${g.rules.length} 条规则（见最后），结构定好以后，把每条挂到一个需求下，写进 rules：
- 想一想 AI 以后改哪些文件时要守这条：挂在文件范围正好覆盖这些文件的最小需求上。说的是哪一块的内容、哪一类文件，就挂那一块（比如讲店里摆设的挂店铺，讲盲道、红绿灯的挂街道设施），不看它现在挂在哪${g.reorganize ? '（现在挂的地方可能就是错的）' : ''}。
- 根上的规则改任何文件都会送到，所以 node 写 ""（留在根上）的只能是不管改什么文件都要守的：协作方式、派工、和人沟通、范围和优先级。
- 只管某一类文件的通用做法不留根上：代码怎么写（注释、命名、类型、架构约定、测试）挂到代码的那个按类型的需求，文档怎么写挂到文档的那个；没有这样的需求就在 nodes 里建（比如「代码规范」files ["**/*.gd"]、「文档写法」files ["**/*.md"]）。
- 只给编号，规则原文不改，每条只放一处。
` : ''}project 写项目名（几个字）。需求名、用途都用项目文档的语言（${lang}）。

只输出 JSON，不要别的：
{"project":"项目名","nodes":[{"id":"R1","title":"需求名","status":"doing","files":["src/auth/**"],"docs":["docs/auth.md"],"children":[{"id":"R1.1","title":"...","status":null,"files":["..."],"children":[]}]}]${split ? ',"split":[{"doc":"CLAUDE.md","section":"节标题原文","to":"docs/workflow.md","node":"R1","purpose":"一句话用途"}]' : ''}${g.rules.length ? ',"rules":[{"i":1,"node":"R2"},{"i":2,"node":""}]' : ''}}

## 文件概览（共 ${g.files.length} 个文件）
${folderSummary(g.files)}

${g.code ? `## 代码（用途，被几个文件用、主要来自哪些文件夹）
${g.code}
${g.misplaced ? `
现在可能挂错的代码文件（几乎只被另一个需求的文件用）：
${g.misplaced}
` : ''}
` : ''}## 文档（用途和主要标题）
${g.docs || g.files.filter(f => isDoc(f) && !(g.data && g.data.has(f))).slice(0, OUTLINE_DOCS).join('\n') || '（没有）'}

## README
${g.readme ? clip(g.readme, 4000) : '（没有）'}

## 最近的提交
${g.git || '（没有 git 记录）'}

## 入口文档
${entryText || '（没有 CLAUDE.md、AGENTS.md）'}
${g.outline ? `
## 现在的需求树（只作参考）
${g.outline}
` : ''}${g.rules.length ? `
## 已经记下的规则
${g.rules.map((r, i) => `${i + 1}. ${g.reorganize ? `（现在在 ${r.node}）` : ''}${r.text}`).join('\n')}
` : ''}`;
}

// 模型给的东西 → 能用的部分：需求（编号、文件范围只留真能匹配到文件、而且落在上级范围里的）和拆分（节要找得到、目标文件要合法且不存在）
function plan(dir, g, out) {
  const matched = new Map(); // glob → 匹配到的文件
  const filesOf = glob => { if (!matched.has(glob)) { const re = globToRegExp(glob); matched.set(glob, g.files.filter(f => re.test(f))); } return matched.get(glob); };
  const idMap = new Map();
  const used = new Set();
  let count = 0;
  // 编号：模型给的（重新整理时沿用原来的）合法、没被占、和上级对得上就用，否则按位置排
  const pickId = (want, parentId, k) => {
    const w = String(want || '').trim();
    const ok = /^[A-Z][A-Z0-9]*(\.\d+)*$/.test(w) && !used.has(w) && (parentId ? w.startsWith(parentId + '.') && !w.slice(parentId.length + 1).includes('.') : !w.includes('.'));
    if (ok) return w;
    for (let i = k; ; i++) { const id = parentId ? `${parentId}.${i}` : `R${i}`; if (!used.has(id)) return id; }
  };
  // scope：上级的文件（没有上级时 null）。子需求的 glob 匹配到上级范围外的文件就不要
  const cleanNode = (n, parentId, k, depth, scope) => {
    const title = oneLine(n && n.title);
    if (!title || count >= MAX_NODES) return null;
    const id = pickId(n.id, parentId, k);
    used.add(id); count++;
    if (n.id) idMap.set(String(n.id).trim(), id);
    const list = (Array.isArray(n.files) ? n.files : []).map(x => oneLine(x, 200)).filter(Boolean);
    // 说明文档挂成背景文档：模型写进 docs 的，和误写进 files 的单个 .md 文件；可以带 #节名
    const okDoc = d => { const f = Docs.splitRef(d).file; return isDoc(f) && g.files.includes(f) && !(g.data && g.data.has(f)); };
    const docs = [...new Set([...(Array.isArray(n.docs) ? n.docs : []).map(x => oneLine(x, 200)), ...list.filter(isDoc)])].filter(okDoc).slice(0, MAX_DOCS);
    const files = [...new Set(list.filter(x => !docs.includes(x)))]
      .filter(x => filesOf(x).length && (!scope || filesOf(x).every(f => scope.has(f))));
    const status = ['doing', 'todo', 'done'].includes(n.status) ? n.status : null;
    const mine = files.length ? new Set(files.flatMap(filesOf)) : scope;
    const kids = depth < MAX_DEPTH && Array.isArray(n.children) ? n.children : [];
    const children = [];
    for (const c of kids.slice(0, MAX_CHILDREN)) {
      const cn = cleanNode(c, id, children.length + 1, depth + 1, mine);
      if (cn) children.push(cn);
    }
    // 只是归类的上级没写文件：用子需求的文件合起来，否则挂在它上面的规则永远不会加载（compile.autoLoads）
    const own = files.length || scope ? files : [...new Set(children.flatMap(c => c.files))];
    return { id, title, status, files: own, children, docs, rules: [] };
  };
  const nodes = [];
  for (const n of (Array.isArray(out.nodes) ? out.nodes : []).slice(0, MAX_TOP)) {
    const cn = cleanNode(n, '', nodes.length + 1, 1, null);
    if (cn) nodes.push(cn);
  }
  const byId = new Map();
  const walkNodes = list => { for (const n of list) { byId.set(n.id, n); walkNodes(n.children); } };
  walkNodes(nodes);
  // 重新整理：模型没给状态的沿用原来同号需求的
  if (g.old) for (const [id, n] of byId) if (!n.status) { const o = findById(g.old, id); if (o && o.status) n.status = o.status; }

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
  // 已有的规则：按模型给的编号放到需求下（node 为 "" 是放在根上）；没分到的放回原来那个需求（新结构里还有同号的），
  // 否则留在根上，一条都不丢
  const rootRules = [];
  const placed = new Map();
  for (const x of Array.isArray(out.rules) ? out.rules : []) {
    const i = Number(x && x.i) - 1;
    if (!(i >= 0 && i < g.rules.length) || placed.has(i)) continue;
    const want = String((x && x.node) || '').trim();
    const target = want ? byId.get(idMap.get(want)) : 'root';
    if (target) placed.set(i, target);
  }
  const rootId = g.old && g.old.children[0] && g.old.children[0].id;
  g.rules.forEach((r, i) => {
    const t = placed.get(i) || (r.node !== rootId && byId.get(r.node)) || 'root';
    (t === 'root' ? rootRules : t.rules).push(r);
  });
  // 重新整理：原来挂着的文档，新结构里哪儿都没挂的，挂到接了原来那个需求最多规则的新需求上（挂满了就算了，报告里说）
  const lostDocs = [];
  if (g.old) {
    const linked = new Set([...rootDocs, ...[...byId.values()].flatMap(n => n.docs)].map(d => Docs.splitRef(d).file));
    for (const o of walk(g.old)) {
      for (const d of o.docs) {
        if (linked.has(Docs.splitRef(d).file)) continue;
        const votes = new Map();
        g.rules.forEach((r, i) => { const t = placed.get(i); if (r.node === o.id && t && t !== 'root') votes.set(t, (votes.get(t) || 0) + 1); });
        const best = [...votes].sort((a, b) => b[1] - a[1]).map(([n]) => n)[0] || byId.get(o.id);
        if (best && best.docs.length < MAX_DOCS && !isRoot(o)) { best.docs.push(d); linked.add(Docs.splitRef(d).file); }
        else if (isRoot(o)) { rootDocs.push(d); linked.add(Docs.splitRef(d).file); }
        else lostDocs.push(d);
      }
    }
  }
  // 重新整理：最顶上那个需求的标题和说明原样留着
  const top = g.old && g.old.children[0];
  const keep = top ? { rootHead: `${top.id} ${top.title}`, rootNotes: top.notes } : {};
  return { project: oneLine(out.project, 30) || path.basename(dir), nodes, rootDocs, rootRules, moves, lostDocs, ...keep };
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
  const lines = [`# ${p.rootHead || `P ${p.project}`}`, ...(p.rootNotes || [S.intro]), ...docsLine(p.rootDocs), ...ruleLines(p.rootRules), ''];
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
async function propose(dir, { ask, treeText = '', reorganize = false } = {}) {
  const g = gather(dir, treeText, { reorganize });
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
    if (!templateShaped(t)) return { treePath, skipped: 'exists' };
  } else {
    treePath = path.join(dir, treeName);
    fs.writeFileSync(treePath, store.initialTree(dir));
  }
  store.ensureTracking(treePath);
  return write(dir, treePath, { ask, reorganize: false });
}

// 问模型、把新树整份写进去（一条改动，可撤销）。初始化和重新整理共用
async function write(dir, treePath, { ask, reorganize }) {
  const before = read(treePath);
  let r;
  try { r = await propose(dir, { ask, treeText: before, reorganize }); } catch (error) {
    store.compileTree(treePath, { force: true });
    return { treePath, ai: false, error };
  }
  // 用户这期间在编辑器里改树、还没保存：整份写盘会和编辑器里的内容打架，这次不写（下次打开再试）
  if (store.isEditing(treePath)) return { treePath, ai: false, error: new Error(EDITING) };
  // 等模型的这几十秒里，别的会话的记录员可能往树里记了新规则：整棵写回前补进去，不丢
  // （原来那个需求在新树里还有就放回那里，否则放在根上）
  let treeText = r.tree;
  const seen = new Set(existingRules(before).map(x => x.text));
  const added = existingRules(read(treePath)).filter(x => !seen.has(x.text));
  if (added.length) {
    const fresh = parse(treeText);
    treeText = applyOps(treeText, added.map(x => ({ op: 'add_rule', node: (reorganize && findById(fresh, x.node) ? x.node : fresh.children[0].id), key: x.key, text: x.text, force: true }))).text;
  }
  const rel = path.relative(dir, treePath).replace(/\\/g, '/');
  const ops = [{ op: 'doc_write', file: rel, text: treeText }, ...[...r.writes].map(([file, text]) => ({ op: 'doc_write', file, text }))];
  const id = `${Date.now().toString(36)}${reorganize ? 'reorg' : 'init'}`;
  const applied = store.applyChange(treePath, ops, { source: reorganize ? '整理' : '初始化', id });
  store.compileTree(treePath, { force: true });
  // 需求全换了：旧地图挂着旧需求的名字和范围，马上按新树重建
  try { require('./codemap').refresh(treePath); } catch {}
  return { treePath, ai: true, nodes: r.plan.nodes, moves: r.plan.moves, lostDocs: r.plan.lostDocs, changeId: applied.length ? id : null, lang: r.g.lang };
}

// ---------- 重新整理已有的树 ----------
// 树长歪了的迹象：某个需求自己挂了 MANY_RULES 条以上规则（该往下拆）；有规则的需求自己和上级都没有文件（规则永远送不到）；
// 根上的规则太多（改任何文件都送，多半混着只管代码、只管文档的）；misplaced：几乎只被另一个需求用的代码文件有几个（codemap.placement）
const ROOT_MANY = MANY_RULES * 2, MISPLACED_MANY = 5;
function needsReorganize(text, { misplaced = 0 } = {}) {
  const { autoLoads } = require('./compile');
  const root = parse(text);
  const why = [];
  for (const n of walk(root)) {
    if (isRoot(n)) { if (n.rules.length >= ROOT_MANY) why.push({ node: n.id, rules: n.rules.length, k: 'root' }); continue; }
    if (n.rules.length >= MANY_RULES) why.push({ node: n.id, rules: n.rules.length, k: 'many' });
    else if (n.rules.length && !autoLoads(n)) why.push({ node: n.id, rules: n.rules.length, k: 'nofiles' });
  }
  if (misplaced >= MISPLACED_MANY) why.push({ node: null, files: misplaced, k: 'misplaced' });
  return why;
}
const REORG_FILE = 'reorganized.json';
// 体检自动整理过没有（自动只做一次：用户撤销了，说明不想要，之后只在用户运行「重新整理」时做）
const autoReorganized = treePath => !!store.readJson(store.metaFile(treePath, REORG_FILE), null);

// 重新整理：先定结构，再把现有规则一条不改地挂上去。auto：体检自动做的（记下来，以后不再自动做）
async function reorganize(treePath, { ask, auto = false } = {}) {
  const dir = path.dirname(treePath);
  const r = await write(dir, treePath, { ask, reorganize: true });
  if (auto && r.ai) try { store.writeJson(store.metaFile(treePath, REORG_FILE), { time: Date.now(), changeId: r.changeId || null, ai: r.ai }); } catch {}
  return r;
}

module.exports = { templateShaped, existingRules, gather, docOutline, buildPrompt, plan, renderTree, renderMoves, propose, initProject, reorganize, needsReorganize, autoReorganized, projectLang, folderSummary, MANY_RULES, MAX_DEPTH };
