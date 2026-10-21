#!/usr/bin/env node
'use strict';
// 实验 A：把真实项目里散落在 CLAUDE.md、memory、各课「项目规则与经验.md」的规则搬进一棵需求树，
// 再用同一个体检脚本（同提示词、同模型）数重复/矛盾/过时，并用真实的 compile.js 比较上下文字数。
// 只读源项目；所有输出写进 --out（应放在临时 scratchpad 里）。报告只给统计数字。
//   node test/eval-migrate.js migrate --out=<目录> --issues=<体检 issues.json>    Sonnet 搬家：先 P，再各课并行
//   node test/eval-migrate.js split   --out=<目录>                               把树按节点拆开，写体检配置 audit-config.json
//   node test/eval-migrate.js context --out=<目录>                               编译到临时目录，比较做某门课一章要加载多少字
// 体检：node <audit-rules.js> <out>/audit --config=<out>/audit-config.json
const fs = require('fs');
const os = require('os');
const path = require('path');
const { call, looseJson, chars, readJson, writeJson, OUT } = require('./eval-replay');
const { compile } = require('../src/compile');
const { parse, walk } = require('../src/parser');

const args = process.argv.slice(2);
const STAGE = args[0];
const opt = (name, d = null) => { const a = args.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : d; };
const VL = opt('project', '');   // 必填：--project=<课程项目目录>
const MEM = opt('memory', '');  // 必填：--memory=<Claude Code 记忆目录>
if (!VL || !MEM) { console.error('用法：node test/eval-migrate.js <步骤> --project=<项目目录> --memory=<记忆目录> --out=<输出目录>'); process.exit(1); }
const mem = f => path.join(MEM, f);
const vl = f => path.join(VL, f);

// 全局：CLAUDE.md 和通用的记忆；各课：自己的文档和自己的记忆。现有需求树里的规则也一起搬
const GLOBAL = [vl('CLAUDE.md'), ...['MEMORY.md', 'docs-edit-in-place.md', 'ask-before-rewrite.md', 'course-learner-review.md', 'no-slogan-no-ppt-cards.md',
  'meaning-over-numbers.md', 'titles-lively-varied.md', 'less-second-person.md', 'plot-not-cringe.md', 'writing-classic-nonfiction.md',
  'no-vscode-extension-reinstall.md', 'reqtree-project.md'].map(mem)];
const COURSES = [
  { id: 'C1', title: 'AI 课', status: '🔨', glob: 'ai-course-pro/**', dir: 'ai-course-pro', files: [vl('ai-course-pro/项目规则与经验.md'), vl('ai-course-pro/_BRIEF.md'), mem('ai-course-progress.md'), mem('ai-one-agent-at-a-time.md')] },
  { id: 'C2', title: '数据科学课', status: '🔨', glob: 'DataScience/**', dir: 'DataScience', files: [vl('DataScience/项目规则与经验.md'), mem('datascience-course-plan.md'), mem('ds-english-edition-audience.md'), mem('ds-one-agent-at-a-time.md'), mem('feedback_ds_no_quotes_simple.md')] },
  { id: 'C3', title: '人类学课', status: '❓', glob: 'anthropology-course/**', dir: 'anthropology-course', files: [vl('anthropology-course/项目规则与经验.md'), mem('anthropology-course-progress.md')] },
  { id: 'C4', title: '十二门徒课', status: '🔨', glob: 'apostles-course/**', dir: 'apostles-course', files: [vl('apostles-course/项目规则与经验.md'), mem('apostles-course-plan.md')] },
  { id: 'C5', title: '英语课', status: '⏳', glob: null, dir: null, files: [mem('english-course-plan.md')] },
  { id: 'C6', title: '教育课', status: '⏳', glob: 'education-course/**', dir: 'education-course', files: [vl('education-course/项目规则与经验.md')] },
  { id: 'C7', title: '游戏设计课', status: '⏳', glob: 'game-design-course/**', dir: 'game-design-course', files: [vl('game-design-course/项目规则与经验.md')] },
];
const label = f => (f.startsWith(path.normalize(MEM)) || f.startsWith(MEM) ? 'memory/' + path.basename(f) : path.relative(VL, f).replace(/\\/g, '/'));
const mtime = f => fs.statSync(f).mtime.toISOString().slice(0, 16).replace('T', ' ');
const docText = files => files.map(f => `===== 文件：${label(f)}（最后修改 ${mtime(f)}）=====\n${fs.readFileSync(f, 'utf8')}`).join('\n\n');

// 体检查出的问题里，和这批文件有关的（当线索给模型）
function issuesFor(files, chunkNames) {
  const all = readJson(opt('issues'), []);
  const names = files.map(label);
  const hit = loc => names.some(n => loc === n || loc.endsWith('/' + n) || n.endsWith('/' + loc) || path.basename(n) === loc);
  return all.filter(x => (x.chunk && chunkNames.includes(x.chunk)) || (!x.chunk && x.locs.some(l => hit(l.replace(/:.*$/, '')))))
    .map(x => `${x.type}｜${x.locs.join(' ; ')}｜${x.note}`);
}
// 现有需求树里某个节点（含子节点）的原文
function currentTreePart(id) {
  const text = fs.readFileSync(vl('需求树.md'), 'utf8');
  const lines = text.split(/\r?\n/);
  const root = parse(text);
  const node = [...walk(root)].find(n => n.id === id);
  if (!node) return '';
  if (id === 'P') return lines.slice(node.line, (node.children[0] ? node.children[0].line : lines.length)).join('\n');
  const sibs = node.parent.children;
  const next = sibs[sibs.indexOf(node) + 1];
  return lines.slice(node.line, next ? next.line : lines.length).join('\n');
}

const COMMON = `你在把一个课程项目里散落在多份文档的规则，搬进一棵「需求树」（Markdown）。需求树格式：标题是需求，开头是 ID；标题下 "- " 开头的是规则，可以带 [键]；子需求用同一个 [键] 在本范围内改写上级的规则；"> 文件：glob" 是这个需求对应的文件，AI 改到这些文件时才加载这个需求的规则。根节点 P 的规则每个会话都加载。

搬家要求：
1. 只搬规范性规则（要求 AI 以后怎么做、不怎么做）。理由、历史经过、踩坑故事只留结论；纯进度、状态、交接说明不搬。
2. 每条规则写成一句完整、具体的话，保留数字、条件、文件名、工具名和路径，不要压缩成标题式的短语；一条不超过约 80 字。
3. 重复的合并成一条。
4. 矛盾的按「用户最新的话为准」解决：看文件修改时间，或文中"改为、现在、后来、以最新为准"之类的措辞。每处解决都写进 resolutions；拿不准也要选一个，并在 basis 里写明不确定。
5. 过时的（已被取代、已废弃、已完成的一次性事项）删掉，也写进 resolutions（new 写"删除"）。
6. 课程 ID：C1 AI课(ai-course-pro)、C2 数据科学课(DataScience)、C3 人类学课(anthropology-course)、C4 十二门徒课(apostles-course)、C5 英语课、C6 教育课(education-course)、C7 游戏设计课(game-design-course)。`;

const OUTPUT = `输出格式（不要别的文字）：
<tree>
（需求树片段）
</tree>
<json>
{"forward":[{"course":"C2","rule":"...","source":"文件"}],"resolutions":[{"type":"矛盾","old":"旧说法（概括）","new":"新说法（概括）或 删除","basis":"依据：哪个文件、修改时间或哪句措辞","sources":["文件:位置"]}]}
</json>`;

function promptP(files, issues) {
  return `${COMMON}

这一步只做根节点 P：所有课程都适用的全局规则。
- 明显只属于某一门课的规则不放 P，放进 forward，交给那门课。
- P 下面不要建子需求（没有文件对应的子需求不会被加载），按主题排好顺序即可。
- 可能被某门课改写的规则（数量、篇幅、结构、字体、并行数之类）开头加一个短键，如 "- [练习题数] 每章 4–6 道练习…"。
- 树片段以 "# P Vibelearning 互动课程" 开头。

<现有需求树的 P 节点>
${currentTreePart('P')}
</现有需求树的 P 节点>

<体检查出的相关问题（线索，可能不全或有误）>
${issues.join('\n')}
</体检查出的相关问题>

<要搬的文档>
${docText(files)}
</要搬的文档>

${OUTPUT}`;
}

function promptCourse(c, pTree, forwarded, issues) {
  return `${COMMON}

这一步只做课程节点 ${c.id} ${c.title}。根节点 P 已经搬好（见下），P 里已有的规则这里不要重复；本课确实要改写 P 的某条规则时，写一条带同一个 [键] 的规则（P 那条没有键就直接写清"本课不同于全局：…"）。
- 树片段以 "## ${c.id} ${c.title} ${c.status}" 开头${c.glob ? `，下一行是 "> 文件：${c.glob}"` : '（这门课还没有文件夹，不写文件行）'}。
- 只管某一章、某一部分或某类文件的规则，可以建子需求（### ${c.id}.1 …），并写上它的文件 glob${c.dir ? `（如 ${c.dir}/ch07-*.html；文档里看得出文件命名才写，看不出就不建子需求，规则写在课程节点上并注明是哪一章）` : ''}。
- forward 留空即可（这一步不再转交）。

<根节点 P（已搬好）>
${pTree}
</根节点 P>

<现有需求树的 ${c.id} 节点>
${currentTreePart(c.id) || '（还没有）'}
</现有需求树的 ${c.id} 节点>

<从全局文档转来、属于本课的规则>
${forwarded.map(f => `- ${f.rule}（来自 ${f.source}）`).join('\n') || '（无）'}
</从全局文档转来、属于本课的规则>

<体检查出的相关问题（线索，可能不全或有误）>
${issues.join('\n') || '（无）'}
</体检查出的相关问题>

<要搬的文档>
${docText(c.files)}
</要搬的文档>

${OUTPUT}`;
}

function parseOut(t) {
  const tree = t && t.match(/<tree>\s*([\s\S]*?)\s*<\/tree>/);
  const js = t && t.match(/<json>\s*([\s\S]*?)\s*<\/json>/);
  return { tree: tree ? tree[1].trim() : null, json: (js && looseJson(js[1])) || { forward: [], resolutions: [] } };
}

const CHUNK_OF = { C1: ['ai-pro'], C2: ['small'], C3: ['anthro'], C4: ['small'], C5: [], C6: ['edu'], C7: ['small'] };

async function migrate() {
  const dir = path.join(OUT, 'migrate');
  fs.mkdirSync(dir, { recursive: true });
  // 估算（按 1 字 ≈ 1 token，Sonnet 输入 $3/M、输出 $15/M，每次调用固定开销约 $0.06）
  const pPrompt = promptP(GLOBAL, issuesFor(GLOBAL, ['claude', 'memory']));
  const est = chars(pPrompt) + COURSES.reduce((s, c) => s + chars(docText(c.files)) + 12000, 0);
  console.log(`估算：输入约 ${est} 字 ≈ $${(est * 3e-6 + 8 * 10000 * 15e-6 + 8 * 0.06).toFixed(2)}（输出按每次 1 万 token 估）`);
  if (args.includes('--estimate')) return;

  let p = readJson(path.join(dir, 'P.json'), null);
  if (!p) {
    const t = await call('sonnet', pPrompt, 'A-migrate');
    fs.writeFileSync(path.join(dir, 'P.raw.txt'), t || '');
    p = parseOut(t);
    if (!p.tree) throw new Error('P 搬家失败，见 P.raw.txt');
    writeJson(path.join(dir, 'P.json'), p);
  }
  console.log(`P：${p.tree.split('\n').filter(l => /^\s*-\s/.test(l)).length} 条规则，转交 ${p.json.forward.length} 条，解决 ${p.json.resolutions.length} 处`);
  await Promise.all(COURSES.map(async c => {
    const f = path.join(dir, `${c.id}.json`);
    if (fs.existsSync(f)) return;
    const fw = (p.json.forward || []).filter(x => x.course === c.id);
    const t = await call('sonnet', promptCourse(c, p.tree, fw, issuesFor(c.files, CHUNK_OF[c.id])), 'A-migrate');
    fs.writeFileSync(path.join(dir, `${c.id}.raw.txt`), t || '');
    const r = parseOut(t);
    if (r.tree) writeJson(f, r);
    console.log(`${c.id}：${r.tree ? r.tree.split('\n').filter(l => /^\s*-\s/.test(l)).length + ' 条规则，解决 ' + r.json.resolutions.length + ' 处' : '失败'}`);
  }));
  const parts = [p, ...COURSES.map(c => readJson(path.join(dir, `${c.id}.json`), null))];
  if (parts.some(x => !x)) throw new Error('有课程搬家失败，重跑 migrate 会只补失败的');
  const tree = parts.map(x => x.tree).join('\n\n') + '\n';
  fs.writeFileSync(path.join(OUT, 'migrated-tree.md'), tree);
  const res = parts.flatMap((x, i) => (x.json.resolutions || []).map(r => ({ node: i ? COURSES[i - 1].id : 'P', ...r })));
  writeJson(path.join(OUT, 'resolutions.json'), res);
  const root = parse(tree);
  const n = [...walk(root)];
  console.log(`树：${n.length} 个需求，${n.reduce((s, x) => s + x.rules.length, 0)} 条规则，${chars(tree)} 字；解决记录 ${res.length} 条（矛盾 ${res.filter(r => r.type === '矛盾').length}，过时 ${res.filter(r => r.type === '过时').length}）`);
}

// 把树按顶层节点拆成文件，分块方式和搬家前的体检对应：P｜C1｜C3｜C6｜其余几门小课
function split() {
  const tree = fs.readFileSync(path.join(OUT, 'migrated-tree.md'), 'utf8');
  const lines = tree.split(/\r?\n/);
  const root = parse(tree);
  const top = [root.children[0], ...root.children[0].children];
  const sd = path.join(OUT, 'tree-split');
  fs.mkdirSync(sd, { recursive: true });
  const fileOf = {};
  top.forEach((node, i) => {
    const end = i === 0 ? (top[1] ? top[1].line : lines.length) : (top[i + 1] ? top[i + 1].line : lines.length);
    const f = path.join(sd, `需求树-${node.id}.md`);
    fs.writeFileSync(f, lines.slice(node.line, end).join('\n').trim() + '\n');
    fileOf[node.id] = f;
  });
  const pick = ids => ids.map(id => fileOf[id]).filter(Boolean);
  const cfg = {
    base: sd,
    context: '背景：这是一位课程作者（用 Claude Code 做互动学习网页课程）给 AI 写的规则，已经整理成一棵需求树（需求树.md），这里按节点拆成几个文件。P 是全局规则，每个会话都会加载；C1、C2… 是各门课的规则，只在改那门课的文件时加载；更深的节点只管某一章或某一部分。子节点为本范围明确写出的、覆盖上级的例外（带同一个 [键] 或写明"本课不同于全局"），不算矛盾。',
    chunks: [['P', pick(['P'])], ['C1', pick(['C1'])], ['C3', pick(['C3'])], ['C6', pick(['C6'])], ['small', pick(['C2', 'C4', 'C5', 'C7'])]].filter(c => c[1].length),
  };
  writeJson(path.join(OUT, 'audit-config.json'), cfg);
  console.log(`拆成 ${Object.keys(fileOf).length} 个文件，体检配置写在 audit-config.json`);
}

// 搬家结果里偶尔有没写 ID 的分组小标题，自动 ID 会和写了 ID 的兄弟撞名（编译时互相覆盖）。
// 编译前给它们补上不重复的 ID（只改标题行的编号，不改内容），写成 context-tree.md
function normalizeIds(text) {
  const lines = text.split(/\r?\n/);
  const root = parse(text);
  const taken = new Set([...walk(root)].filter(n => !n.autoId).map(n => n.id));
  for (const n of walk(root)) {
    if (!n.autoId || !n.parent || !n.parent.parent) continue;
    let i = n.parent.children.length + 1, id;
    do id = `${n.parent.id}.${i++}`; while (taken.has(id));
    taken.add(id);
    lines[n.line] = lines[n.line].replace(/^(#{1,6})\s+/, `$1 ${id} `);
  }
  return lines.join('\n');
}

// glob → 正则：** 跨目录，* 不跨，? 一个字，{a,b} 任选，[..] 原样
function globRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*' && g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; }
    else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else if (ch === '{' && g.indexOf('}', i) > i) { const j = g.indexOf('}', i); re += '(' + g.slice(i + 1, j).split(',').map(x => x.replace(/[.+^$()|\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')'; i = j; }
    else if (ch === '[' && g.indexOf(']', i) > i) { const j = g.indexOf(']', i); re += g.slice(i, j + 1); i = j; }
    else re += ch.replace(/[.+^$()|\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

// 上下文字数：做某门课的一章，AI 要加载多少字。
// 搬家前：CLAUDE.md + MEMORY.md（常驻）+ 本课「项目规则与经验.md」（brief 要求整份读；AI 课另算上 _BRIEF.md）。
// 搬家后：用真实的 compile.js 编译到临时目录；常驻的是 _index.md + P.md，改某个文件时再加载 paths 匹配它的规则文件。
// 「一章」取这门课真实存在的每个章节文件，分别算加载量，报平均和最大。
function context() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reqtree-ctx-'));
  const treePath = path.join(tmp, '需求树.md');
  const norm = normalizeIds(fs.readFileSync(path.join(OUT, 'migrated-tree.md'), 'utf8'));
  fs.writeFileSync(path.join(OUT, 'context-tree.md'), norm);
  fs.writeFileSync(treePath, norm);
  compile(treePath, { targets: { claude: true, codex: false } });
  const rd = path.join(tmp, '.claude', 'rules', 'reqtree');
  const compiled = fs.readdirSync(rd).map(f => {
    const text = fs.readFileSync(path.join(rd, f), 'utf8');
    const fm = text.match(/^---\npaths:\n([\s\S]*?)\n---/);
    const globs = fm ? fm[1].split('\n').map(l => JSON.parse(l.replace(/^\s*-\s*/, ''))) : null;
    return { f, size: chars(text), globs };
  });
  const always = compiled.filter(c => !c.globs).reduce((s, c) => s + c.size, 0);
  const loadFor = rel => always + compiled.filter(c => c.globs && c.globs.some(g => globRe(g).test(rel))).reduce((s, c) => s + c.size, 0);
  const before = chars(fs.readFileSync(vl('CLAUDE.md'), 'utf8')) + chars(fs.readFileSync(mem('MEMORY.md'), 'utf8'));
  const rows = [];
  for (const c of COURSES) {
    const own = c.files.filter(f => /项目规则与经验/.test(f)).reduce((s, f) => s + chars(fs.readFileSync(f, 'utf8')), 0);
    const brief = c.files.filter(f => /_BRIEF/.test(f)).reduce((s, f) => s + chars(fs.readFileSync(f, 'utf8')), 0);
    let chapters = [];
    if (c.dir && fs.existsSync(vl(c.dir))) chapters = fs.readdirSync(vl(c.dir)).filter(f => /^(ch\d+|level)-.*\.html$/.test(f)).map(f => `${c.dir}/${f}`);
    const loads = chapters.map(loadFor);
    const avg = loads.length ? Math.round(loads.reduce((s, x) => s + x, 0) / loads.length) : always;
    rows.push({ course: `${c.id} ${c.title}`, chapters: chapters.length, before: before + own, beforeWithBrief: before + own + brief, afterAvg: avg, afterMax: loads.length ? Math.max(...loads) : always });
  }
  const out = { beforeAlways: before, afterAlways: always, compiled: compiled.map(({ f, size, globs }) => ({ f, size, globs })), rows };
  writeJson(path.join(OUT, 'context.json'), out);
  console.log(`常驻：搬家前 CLAUDE.md + MEMORY.md ${before} 字；搬家后 _index.md + P.md ${always} 字；编译出 ${compiled.length} 个规则文件`);
  console.log('| 课程 | 章节文件数 | 搬家前 | 搬家前含 _BRIEF | 搬家后平均 | 搬家后最大 |');
  for (const r of rows) console.log(`| ${r.course} | ${r.chapters} | ${r.before} | ${r.beforeWithBrief} | ${r.afterAvg} | ${r.afterMax} |`);
}

(async () => {
  const stages = { migrate, split, context };
  if (!stages[STAGE]) { console.log('阶段：' + Object.keys(stages).join(' / ')); process.exit(1); }
  await stages[STAGE]();
})();
