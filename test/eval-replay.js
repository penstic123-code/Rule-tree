#!/usr/bin/env node
'use strict';
// 实验 B：用用户真实对话回放，比较「不装（CLAUDE.md + memory + 各课规则文档，多会话）」和「装了 reqtree」。
// 用户原话只存在 <out> 目录（应放在临时 scratchpad 里），本脚本和报告只输出统计数字。
// 阶段（按顺序运行，每步结果写进 <out>，可单独重跑）：
//   node test/eval-replay.js extract  --logs=<对话记录目录> --exclude=<会话ID> --out=<目录>
//   node test/eval-replay.js filter   --out=<目录> [--max=150]   Haiku 给会话标课程、挑出含要求/偏好/决定的消息
//   node test/eval-replay.js truth    --out=<目录>               Sonnet 读全部消息，给出「现在应该生效的规则」
//   node test/eval-replay.js play     --out=<目录> [--runs=2] [--arms=baseline,reqtree]
//   node test/eval-replay.js judge    --out=<目录>               审计（重复/矛盾/过时）+ 对照标准答案 + 上下文字数
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const STAGE = args[0];
const opt = (name, d = null) => { const a = args.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : d; };
const OUT = path.resolve(opt('out', path.join(os.tmpdir(), 'reqtree-eval-replay')));
fs.mkdirSync(OUT, { recursive: true });
const BASE = '--strict-mcp-config --no-session-persistence --setting-sources user --output-format json';
const MODEL = { haiku: `claude -p --model haiku ${BASE}`, sonnet: `claude -p --model sonnet ${BASE}` };
// --costfile= 让同时运行的几个进程各记各的费用（避免互相覆盖）
const COST_FILE = path.resolve(opt('costfile', path.join(OUT, 'cost.json')));
const chars = s => [...String(s || '')].length;
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));

// ---------- 调模型，累计费用到 cost.json ----------
const cost = readJson(COST_FILE, {});
function addCost(stage, usd) {
  cost[stage] = cost[stage] || { calls: 0, usd: 0 };
  cost[stage].calls++; cost[stage].usd += usd;
  writeJson(COST_FILE, cost);
}
function call(model, prompt, stage, tries = 2) {
  return new Promise(resolve => {
    const p = spawn(MODEL[model], { shell: true, cwd: os.tmpdir(), env: { ...process.env, REQTREE_RECORDER: '1' }, windowsHide: true });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('close', async () => {
      let j = null;
      try { j = JSON.parse(out); } catch {}
      if (j) addCost(stage, j.total_cost_usd || 0);
      if (j && !j.is_error && typeof j.result === 'string') return resolve(j.result);
      if (tries > 1) return resolve(await call(model, prompt, stage, tries - 1));
      resolve(null);
    });
    p.stdin.end(prompt);
  });
}
// 宽松地取 JSON：模型偶尔在字符串里写没转义的英文引号
function looseJson(t) {
  const m = t && t.match(/[[{][\s\S]*[\]}]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch {}
  try {
    return JSON.parse(m[0].replace(/(?<=[一-鿿「」，、])"(?=[一-鿿])/g, '＂').replace(/(?<=[一-鿿])"(?=[一-鿿」，、。])/g, '＂'));
  } catch { return null; }
}
async function pool(items, n, fn) {
  const res = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; res[k] = await fn(items[k], k); } }));
  return res;
}

// ---------- extract：只取用户亲手打的字 ----------
// AI 回复只留最后这么多字（通常是结论或给用户的选项）
const AI_TAIL = 400;
const NOISE = /^(<command-name>|<command-message>|<local-command-|<task-notification>|<bash-|Caveat:|\[Request interrupted)/;
function cleanText(s) {
  return String(s)
    .replace(/<(system-reminder|ide_[a-z_]+|command-[a-z-]+|local-command-[a-z-]+|task-notification|user-prompt-submit-hook)>[\s\S]*?<\/\1>/g, '')
    .trim();
}
async function extract() {
  const dir = opt('logs');
  const exclude = (opt('exclude') || '').split(',').filter(Boolean);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') && !exclude.some(x => f.startsWith(x)));
  const seen = new Set();
  const sessions = [];
  for (const f of files) {
    const msgs = [];
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, f), 'utf8'), crlfDelay: Infinity });
    let last = null; // 最近一条用户消息：后面 AI 的正文回复记到它的 ai 上（只留末尾，给记录员当上下文）
    for await (const line of rl) {
      const isUser = line.includes('"type":"user"');
      if (!isUser && !line.includes('"type":"assistant"')) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.isSidechain) continue;
      if (e.type === 'assistant' && last && Array.isArray(e.message && e.message.content)) {
        const t = e.message.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
        if (t) last.ai = (last.ai + ' ' + t).slice(-AI_TAIL);
        continue;
      }
      if (e.type !== 'user' || e.isMeta || e.isCompactSummary || e.toolUseResult) continue;
      const c = e.message && e.message.content;
      const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : (Array.isArray(c) ? c : []);
      if (blocks.some(b => b.type === 'tool_result')) continue;
      const raw = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
      if (NOISE.test(raw.trim())) continue;
      const text = cleanText(raw);
      if (!text || NOISE.test(text)) continue;
      // 续接的会话会把以前的消息再写一遍：按 uuid 和（时间+内容）去重
      const key = `${e.timestamp}|${text.slice(0, 200)}`;
      if (seen.has(e.uuid) || seen.has(key)) continue;
      seen.add(e.uuid); seen.add(key);
      last = { t: e.timestamp, text, ai: '' };
      msgs.push(last);
    }
    if (msgs.length) sessions.push({ id: f.slice(0, 8), start: msgs[0].t, msgs });
  }
  sessions.sort((a, b) => a.start.localeCompare(b.start));
  for (const s of sessions) s.msgs.sort((a, b) => a.t.localeCompare(b.t));
  writeJson(path.join(OUT, 'messages.json'), sessions);
  const n = sessions.reduce((k, s) => k + s.msgs.length, 0);
  const c = sessions.reduce((k, s) => k + s.msgs.reduce((x, m) => x + chars(m.text), 0), 0);
  console.log(`会话 ${sessions.length} 个，用户消息 ${n} 条，共 ${c} 字`);
  for (const s of sessions) console.log(`  ${s.id} ${s.start.slice(0, 16)} ${s.msgs.length} 条 ${s.msgs.reduce((x, m) => x + chars(m.text), 0)} 字`);
}

// ---------- 课程表（两组共用） ----------
const COURSES = [
  ['C1', 'AI 课', 'ai-course-pro'], ['C2', '数据科学课', 'DataScience'], ['C3', '人类学课', 'anthropology-course'],
  ['C4', '十二门徒课', 'apostles-course'], ['C5', '英语课', 'English'], ['C6', '教育课', 'education-course'],
  ['C7', '游戏设计课', 'game-design-course'], ['C8', 'UI/UX 课', 'UIUX设计'], ['C9', '写作课', '写作与小说'],
].map(([id, name, dir]) => ({ id, name, dir }));
const courseById = id => COURSES.find(c => c.id === id) || null;
const COURSE_LIST = `G 通用（所有课程或整个项目）、${COURSES.map(c => `${c.id} ${c.name}（${c.dir}）`).join('、')}、X 与课程无关`;
const clip = (s, n) => { const a = [...String(s || '')]; return a.length > n ? a.slice(0, n).join('') + '…' : a.join(''); };
const tail = (s, n) => { const a = [...String(s || '')]; return a.length > n ? '…' + a.slice(-n).join('') : a.join(''); };
const USER_MAX = 1500; // 用户消息截断长度（三处一致：标准答案、对照组、实验组）

// ---------- filter：Haiku 给会话标课程，挑出含长期要求/偏好/决定的消息 ----------
async function filter() {
  // --sessions=a,b 只重做这几个会话，结果并进已有的 kept.json
  const only = (opt('sessions') || '').split(',').filter(Boolean);
  const sessions = readJson(path.join(OUT, 'messages.json'), []).filter(s => !only.length || only.includes(s.id));
  const batches = [];
  for (const s of sessions) for (let i = 0; i < s.msgs.length; i += 40) batches.push({ s, from: i, msgs: s.msgs.slice(i, i + 40) });
  const est = batches.reduce((k, b) => k + b.msgs.reduce((x, m) => x + chars(clip(m.text, 600)) + 200, 0) + 1500, 0);
  console.log(`filter：${batches.length} 次 Haiku 调用，输入约 ${est} 字，估 $${(batches.length * 0.006 + est * 1e-6 + batches.length * 800 * 5e-6).toFixed(2)}`);
  if (args.includes('--estimate')) return;
  const res = await pool(batches, 6, async b => {
    const list = b.msgs.map((m, k) => `[${b.from + k}] ${m.t.slice(0, 16)}\n（AI 上一轮结尾：${tail(k ? b.msgs[k - 1].ai : '', 150)}）\n用户：${clip(m.text, 600)}`).join('\n\n');
    const prompt = `下面是一位课程作者在 Claude Code 里做互动学习网页课程时，在同一个会话里对 AI 说的话（按时间顺序，编号是会话内的序号）。
课程：${COURSE_LIST}

请做两件事：
1. 判断这个会话主要在做哪门课（session_course）。
2. 挑出含有**长期要求、偏好或决定**的消息：以后做事要遵守的规则；对课程、某一章、某个部分的内容/结构/风格/流程做的决定；修改或推翻以前的要求。一次性的操作指令（"把这段改短""继续""跑一下测试"）、纯提问、进度询问、闲聊不要。拿不准的留下。每条给出它主要涉及的课程（不确定就用会话的课程）。

只输出 JSON：{"session_course":"C1","keep":[{"i":3,"course":"C1"}]}

${list}`;
    const t = await call('haiku', prompt, 'B-filter');
    fs.mkdirSync(path.join(OUT, 'filter-raw'), { recursive: true });
    fs.writeFileSync(path.join(OUT, 'filter-raw', `${b.s.id}-${b.from}.txt`), t || '');
    return { b, j: looseJson(t) };
  });
  const out = [];
  const label = {};
  for (const { b, j } of res) {
    if (!j) { console.log(`✗ ${b.s.id} 从 ${b.from}：没返回 JSON，这一批全部保留`); }
    label[b.s.id] = label[b.s.id] || {};
    const sc = (j && j.session_course) || 'G';
    label[b.s.id][sc] = (label[b.s.id][sc] || 0) + b.msgs.length;
    const keep = j ? (j.keep || []) : b.msgs.map((m, k) => ({ i: b.from + k, course: sc }));
    for (const k of keep) {
      const m = b.s.msgs[k.i];
      if (!m) continue;
      out.push({ session: b.s.id, i: k.i, t: m.t, course: k.course || sc });
    }
  }
  let sessionCourse = Object.fromEntries(Object.entries(label).map(([id, v]) => [id, Object.entries(v).sort((a, b) => b[1] - a[1])[0][0]]));
  if (only.length) {
    const old = readJson(path.join(OUT, 'kept.json'), { sessionCourse: {}, kept: [] });
    out.push(...old.kept.filter(k => !only.includes(k.session)));
    sessionCourse = { ...old.sessionCourse, ...sessionCourse };
  }
  out.sort((a, b) => a.t.localeCompare(b.t));
  writeJson(path.join(OUT, 'kept.json'), { sessionCourse, kept: out });
  console.log(`保留 ${out.length} 条；会话课程：${JSON.stringify(sessionCourse)}`);
}

// 保留的消息，带上下文（同一会话里紧挨着的上一条，不管有没有被保留）
function keptMessages() {
  const sessions = Object.fromEntries(readJson(path.join(OUT, 'messages.json'), []).map(s => [s.id, s]));
  const { sessionCourse, kept } = readJson(path.join(OUT, 'kept.json'), {});
  const max = Number(opt('max')) || Infinity;
  const list = kept.slice(0, max).map((k, n) => {
    const s = sessions[k.session];
    const m = s.msgs[k.i], prev = s.msgs[k.i - 1];
    let course = k.course;
    if (!courseById(course)) course = courseById(sessionCourse[k.session]) ? sessionCourse[k.session] : null;
    return { n: n + 1, session: k.session, t: k.t, course, user: clip(m.text, USER_MAX), ai: tail(m.ai, 400), prev: prev ? { user: clip(prev.text, 400), ai: tail(prev.ai, 400) } : null };
  });
  return { list, sessionCourse };
}

// ---------- truth：Sonnet 读全部保留消息，给出现在应该生效的规则 ----------
async function truth() {
  const { list } = keptMessages();
  const body = list.map(m => `[${m.n}] ${m.t.slice(0, 16)} 会话${m.session} 课程${m.course || 'G'}\n（AI 上一轮结尾：${tail(m.prev ? m.prev.ai : '', 200)}）\n用户：${m.user}`).join('\n\n');
  console.log(`truth：1 次 Sonnet，输入约 ${chars(body)} 字`);
  if (args.includes('--estimate')) return;
  const prompt = `下面是一位课程作者在几天里、多个 Claude Code 会话中对 AI 说过的、含有要求或决定的话，按时间顺序排列（编号是全局序号；同一时间段可能有几个会话在并行做不同的课）。
课程：${COURSE_LIST}

请整理出**到最后一条消息为止，应该生效的全部长期规则**：
- 规则是以后做事要遵守的要求、偏好或决定（包括对某门课、某一章的内容/结构/风格/流程的决定）。一次性的操作、提问不算。
- 用户后来改了主意的，只保留最新的版本；被明确推翻、取消的不保留。
- 同一个意思只写一条。范围写最小的适用范围：G（全局）、某门课（C1…）、或某门课的某一章/某部分（如"C1 第7章"）。
- 每条一句具体的中文，保留关键数字和条件；from 写依据的消息编号（含被它取代的旧消息）。
- 另外单独列出被取代或推翻的旧规则（superseded），方便评审识别"过时"。

只输出 JSON：{"rules":[{"id":"T1","scope":"G","rule":"...","from":[3,57]}],"superseded":[{"rule":"旧规则","by":"T5","from":[3]}]}

${body}`;
  const t = await call('sonnet', prompt, 'B-truth');
  fs.writeFileSync(path.join(OUT, 'truth.raw.txt'), t || '');
  const j = looseJson(t);
  if (!j) throw new Error('标准答案没返回 JSON，见 truth.raw.txt');
  writeJson(path.join(OUT, 'truth.json'), j);
  console.log(`标准答案：${j.rules.length} 条现行规则，${(j.superseded || []).length} 条已被取代`);
}

// ---------- play：两组回放 ----------
const { applyOps, parse, walk, outline } = require('../src/parser');
const recorder = require('../hooks/recorder');
const ALLOWED_OPS = new Set(['add_rule', 'replace_rule', 'remove_rule', 'add_node', 'set_status', 'add_files']);
const INIT_TREE = `# P Vibelearning 互动课程\n\n${COURSES.map(c => `## ${c.id} ${c.name}\n> 文件：${c.dir}/**`).join('\n\n')}\n`;
const docOf = c => `${c.dir}/项目规则.md`;

function baselinePrompt(files, m, sessionCourse) {
  const c = courseById(m.course) || courseById(sessionCourse);
  const vis = [['CLAUDE.md', files['CLAUDE.md'] || ''], ['memory/MEMORY.md', files['memory/MEMORY.md'] || '']];
  if (c) vis.push([docOf(c), files[docOf(c)] || '']);
  return `你是 Claude Code，正在用户的互动学习网页课程项目里工作${c ? `（这个会话在做 ${c.name}，课程文件夹 ${c.dir}/）` : ''}。下面是会话开始时自动加载的文件${c ? '，以及你打开的本课规则文档' : ''}（空的表示文件还没有内容）：
${vis.map(([f, t]) => `<${f}>\n${t}\n</${f}>`).join('\n')}
memory/MEMORY.md 是记忆索引，每条记忆的正文在 memory/ 下单独的文件里，你现在看不到正文。

你的习惯：用户提出以后都要遵守的要求、偏好或决定时，把它记下来，以后的会话才能照做。所有课程通用的写进 CLAUDE.md；只属于某门课的写进那门课的 项目规则.md（如 ${docOf(COURSES[1])}）；也可以用记忆：在 memory/ 下新建一个记忆文件（写清规则、为什么、怎么用），并在 memory/MEMORY.md 加一行索引。一次性的指令、提问、闲聊不用记。

${m.prev ? `上一轮：\n用户：${m.prev.user}\n你（回复结尾）：${m.prev.ai}\n\n` : ''}这一轮：
用户：${m.user}
你（回复结尾）：${m.ai}

现在只决定要不要改这些文件。只输出 JSON，不要别的文字：
{"edits":[{"file":"CLAUDE.md","old":"要替换的原文（新增时留空）","new":"新内容"},{"file":"memory/xxx.md","write":"整个文件的内容"}]}
没有要改的就输出 {"edits":[]}`;
}

function applyEdits(files, edits, log) {
  for (const e of edits || []) {
    if (!e || typeof e.file !== 'string') continue;
    const f = e.file.replace(/\\/g, '/').replace(/^\.?\//, '');
    if (!(f === 'CLAUDE.md' || /^memory\/[^/]+\.md$/.test(f) || /^[^/]+\/项目规则\.md$/.test(f))) { log.push({ skip: f }); continue; }
    if (typeof e.write === 'string') { files[f] = e.write.trim() + '\n'; continue; }
    if (typeof e.new !== 'string') continue;
    const cur = files[f] || '';
    if (e.old && cur.includes(e.old)) files[f] = cur.replace(e.old, e.new);
    else {
      // 原文没找到时，真实的 AI 会重试，通常会改成追加：这里直接追加
      if (e.old) log.push({ notFound: f });
      files[f] = (cur.trim() ? cur.trimEnd() + '\n' : '') + e.new.trim() + '\n';
    }
  }
}

async function playRun(arm, run) {
  const { list, sessionCourse } = keptMessages();
  const dir = path.join(OUT, `${arm}-${run}`);
  fs.mkdirSync(dir, { recursive: true });
  const log = [];
  let tree = INIT_TREE;
  const files = {};
  const cap = Number(opt('cap')) || Infinity; // 回放花费上限（美元），超了就停，结果标为不完整
  for (const m of list) {
    const spent = Object.entries(cost).filter(([k]) => k.startsWith('B-play')).reduce((x, [, v]) => x + v.usd, 0);
    if (spent > cap) { log.push({ stoppedAt: m.n, spent }); console.log(`
${arm}-${run} 超过上限 $${cap}，停在第 ${m.n} 条`); break; }
    const entry = { n: m.n };
    if (arm === 'reqtree') {
      const turns = [...(m.prev ? [m.prev] : []), { user: m.user, ai: m.ai }];
      if (recorder.isTrivial(m.user)) entry.skipped = true;
      else {
        const c = courseById(m.course) || courseById(sessionCourse[m.session]);
        const touched = c ? [c.id] : [];
        const view = tree.split('\n').length > 200 ? outline(tree, touched) : tree;
        const t = await call('haiku', recorder.buildPrompt(view, turns, touched, []), `B-play-${arm}`);
        const j = looseJson(t);
        if (!j || !Array.isArray(j.ops)) entry.fail = true;
        else {
          let ops = j.ops.filter(o => o && ALLOWED_OPS.has(o.op));
          ops = recorder.filterAddFiles(ops, { root: parse(tree), unmapped: [], user: m.user });
          const r = applyOps(tree, ops);
          tree = r.text;
          entry.ops = r.applied.map(a => { const { undo, ...x } = a; return x; });
        }
      }
    } else {
      const t = await call('haiku', baselinePrompt(files, m, sessionCourse[m.session]), `B-play-${arm}`);
      const j = looseJson(t);
      if (!j || !Array.isArray(j.edits)) entry.fail = true;
      else { entry.edits = j.edits.length; const l = []; applyEdits(files, j.edits, l); if (l.length) entry.issues = l; }
    }
    log.push(entry);
    if (m.n % 10 === 0) process.stdout.write(`${arm}-${run}:${m.n} `);
  }
  writeJson(path.join(dir, 'log.json'), log);
  if (arm === 'reqtree') fs.writeFileSync(path.join(dir, '需求树.md'), tree);
  else for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, 'files', f)), { recursive: true }); fs.writeFileSync(path.join(dir, 'files', f), t); }
  console.log(`\n${arm}-${run} 完成：失败 ${log.filter(e => e.fail).length} 次`);
}

async function play() {
  const runs = Number(opt('runs')) || 2;
  const arms = (opt('arms') || 'baseline,reqtree').split(',');
  const { list } = keptMessages();
  console.log(`play：${arms.join('、')} 各 ${runs} 遍，每遍 ${list.length} 条消息；估 $${(arms.length * runs * list.length * 0.012).toFixed(2)}（每次 Haiku 约 $0.012）`);
  if (args.includes('--estimate')) return;
  const first = Number(opt('first')) || 1; // 第几遍开始编号（另开进程补跑时用）
  await Promise.all(arms.flatMap(a => Array.from({ length: runs }, (_, i) => playRun(a, first + i))));
}

// ---------- judge：审计 + 对照标准答案 + 上下文字数 ----------
const AUDIT_CONTEXT = {
  baseline: '背景：这是一位课程作者（用 Claude Code 做互动学习网页课程）的 AI 在多个会话里自己记下的规则文档。CLAUDE.md 是全局规范，每个会话都会加载；memory/ 是 AI 自动记的记忆（MEMORY.md 是索引，每个会话加载）；各课程文件夹下的「项目规则.md」是课程专属规则。课程文档为本课明确写出的、覆盖全局规范的例外，不算矛盾。',
  reqtree: '背景：这是一位课程作者（用 Claude Code 做互动学习网页课程）的规则，由后台记录员在多个会话里记进一棵需求树（需求树.md），这里按节点拆成几个文件。P 是全局规则，每个会话都会加载；C1、C2… 是各门课的规则，只在改那门课的文件时加载；更深的节点只管某一章或某一部分。子节点为本范围明确写出的、覆盖上级的例外（带同一个 [键]），不算矛盾。',
};
const listFiles = d => (fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).map(f => path.join(d, f)).filter(f => f.endsWith('.md') && fs.statSync(f).isFile()) : []);

// 把一组的最终状态拆成审计用的文件和配置；返回 { cfg, text（给评审看的全文）, always, perCourse }
function endState(arm, dir) {
  const ad = path.join(dir, 'audit-in');
  fs.mkdirSync(ad, { recursive: true });
  if (arm === 'baseline') {
    const base = path.join(dir, 'files');
    const all = listFiles(base);
    const rel = f => path.relative(base, f).replace(/\\/g, '/');
    const claude = all.filter(f => rel(f) === 'CLAUDE.md');
    const memory = all.filter(f => rel(f).startsWith('memory/'));
    const courses = all.filter(f => !claude.includes(f) && !memory.includes(f));
    const text = all.map(f => `===== ${rel(f)} =====\n${fs.readFileSync(f, 'utf8')}`).join('\n\n');
    const read = f => { try { return fs.readFileSync(path.join(base, f), 'utf8'); } catch { return ''; } };
    const always = chars(read('CLAUDE.md')) + chars(read('memory/MEMORY.md'));
    const perCourse = Object.fromEntries(COURSES.map(c => [c.id, always + chars(read(docOf(c)))]));
    return { cfg: { base, context: AUDIT_CONTEXT.baseline, chunks: [['claude', claude], ['memory', memory], ['courses', courses]].filter(c => c[1].length) }, text, always, perCourse, totalChars: chars(text) };
  }
  // reqtree：按顶层节点拆开；上下文用真实的 compile.js 编译到临时目录
  const tree = fs.readFileSync(path.join(dir, '需求树.md'), 'utf8');
  const lines = tree.split(/\r?\n/);
  const root = parse(tree);
  const top = [root.children[0], ...root.children[0].children];
  const files = top.map((n, i) => {
    const end = i === 0 ? (top[1] ? top[1].line : lines.length) : (top[i + 1] ? top[i + 1].line : lines.length);
    const f = path.join(ad, `需求树-${n.id}.md`);
    fs.writeFileSync(f, lines.slice(n.line, end).join('\n').trim() + '\n');
    return f;
  });
  const half = Math.ceil((files.length - 1) / 2);
  const { compile } = require('../src/compile');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reqtree-ctx-'));
  fs.writeFileSync(path.join(tmp, '需求树.md'), tree);
  compile(path.join(tmp, '需求树.md'), { targets: { claude: true, codex: false } });
  const rd = path.join(tmp, '.claude', 'rules', 'reqtree');
  const size = f => { try { return chars(fs.readFileSync(path.join(rd, f), 'utf8')); } catch { return 0; } };
  const always = size('_index.md') + size('P.md');
  // 做某门课：加载这门课节点和它下面所有子节点里 paths 能匹配到的——按最坏情况算整门课的节点都加载
  const perCourse = Object.fromEntries(COURSES.map(c => {
    const node = [...walk(root)].find(n => n.id === c.id);
    return [c.id, always + (node ? [...walk(node)].reduce((s, k) => s + size(`${k.id}.md`), size(`${c.id}.md`)) : 0)];
  }));
  return { cfg: { base: ad, context: AUDIT_CONTEXT.reqtree, chunks: [['P', files.slice(0, 1)], ['A', files.slice(1, 1 + half)], ['B', files.slice(1 + half)]].filter(c => c[1].length) }, text: tree, always, perCourse, totalChars: chars(tree) };
}

function runAudit(dir, cfg) {
  const cfgPath = path.join(dir, 'audit-config.json');
  writeJson(cfgPath, cfg);
  const out = path.join(dir, 'audit');
  return new Promise(resolve => {
    const p = spawn(process.execPath, [opt('audit'), out, `--config=${cfgPath}`], { windowsHide: true });
    p.on('close', () => {
      const s = readJson(path.join(out, 'summary.json'), null);
      if (s) { cost['B-audit'] = cost['B-audit'] || { calls: 0, usd: 0 }; cost['B-audit'].calls += s.stats.calls; cost['B-audit'].usd += s.stats.cost; writeJson(COST_FILE, cost); }
      resolve(s);
    });
  });
}

async function compareTruth(arm, state, dir) {
  const t = readJson(path.join(OUT, 'truth.json'), null);
  const prompt = `你是评审。一位课程作者在多个会话里提出过许多要求；下面是根据全部对话整理出的「现在应该生效的规则」（标准答案）和「已被取代的旧规则」。另一份是某个系统在回放这些对话后最终记下的规则库。请逐条对照。

<标准答案：现行规则>
${t.rules.map(r => `${r.id}｜范围 ${r.scope}｜${r.rule}`).join('\n')}
</标准答案>
<已被取代的旧规则>
${(t.superseded || []).map(r => `- ${r.rule}（被 ${r.by} 取代）`).join('\n')}
</已被取代的旧规则>

<最终规则库>
${state}
</最终规则库>

请判断：
1. 每条标准答案在规则库里的情况：覆盖（有一条意思对、范围大致对的规则）/ 错误（记了，但内容记错或范围错，如某门课的规则写成全局、某一章的写成整门课）/ 遗漏（没有）。
2. 规则库里还留着的过时规则：内容是已被取代的旧版本，或和标准答案里更新的版本冲突。
3. 规则库里不在标准答案里、也不是过时的规则，数一下条数即可（extra），不用逐条列。
每条给一句理由。只输出 JSON：
{"truth":[{"id":"T1","status":"覆盖","where":"文件或节点","reason":"..."}],"outdated":[{"where":"...","text":"规则原文（概括）","by":"T5","reason":"..."}],"extra":0}`;
  const r = await call('sonnet', prompt, 'B-compare');
  fs.writeFileSync(path.join(dir, 'compare.raw.txt'), r || '');
  return looseJson(r);
}

async function judge() {
  const dirs = fs.readdirSync(OUT).filter(d => /^(baseline|reqtree)-\d+$/.test(d) && fs.existsSync(path.join(OUT, d, 'log.json')));
  const rows = [];
  await Promise.all(dirs.map(async d => {
    const arm = d.split('-')[0];
    const dir = path.join(OUT, d);
    const st = endState(arm, dir);
    console.log(`${d}：最终规则库 ${st.totalChars} 字，开始审计和对照`);
    // --audit-only=1：只审计第 1 遍（省钱）；对照标准答案每遍都做
    const doAudit = !opt('audit-only') || d.endsWith('-' + opt('audit-only'));
    const [audit, cmp] = await Promise.all([doAudit ? runAudit(dir, st.cfg) : null, compareTruth(arm, st.text, dir)]);
    if (cmp) writeJson(path.join(dir, 'compare.json'), cmp);
    const tally = (audit && audit.tally) || {};
    const sum = type => Object.entries(tally).filter(([k]) => k.endsWith(type)).reduce((s, [, v]) => s + v.共, 0);
    const ts = (cmp && cmp.truth) || [];
    const log = readJson(path.join(dir, 'log.json'), []);
    rows.push({
      run: d, arm, chars: st.totalChars, rulesExtracted: audit ? audit.rules : null,
      重复: audit ? sum('重复') : '-', 矛盾: audit ? sum('矛盾') : '-', 过时_审计: audit ? sum('过时') : '-',
      覆盖: ts.filter(x => x.status === '覆盖').length, 错误: ts.filter(x => x.status === '错误').length, 遗漏: ts.filter(x => x.status === '遗漏').length,
      过时仍在: cmp ? (cmp.outdated || []).length : null, 多出: cmp ? cmp.extra : null,
      常驻字数: st.always, 做某门课: st.perCourse, 调用失败: log.filter(e => e.fail).length, 完整: !log.some(e => e.stoppedAt),
    });
  }));
  rows.sort((a, b) => a.run.localeCompare(b.run));
  writeJson(path.join(OUT, 'judge-summary.json'), { rows, cost });
  console.log('| 组 | 规则库字数 | 重复 | 矛盾 | 过时(审计) | 覆盖 | 错误 | 遗漏 | 过时仍在 | 多出 | 常驻字数 |');
  for (const r of rows) console.log(`| ${r.run} | ${r.chars} | ${r.重复} | ${r.矛盾} | ${r.过时_审计} | ${r.覆盖} | ${r.错误} | ${r.遗漏} | ${r.过时仍在} | ${r.多出} | ${r.常驻字数} |`);
  console.log('费用：' + JSON.stringify(cost));
}

module.exports = { call, looseJson, pool, chars, readJson, writeJson, cost, OUT, COURSES, keptMessages, clip, tail };
if (require.main === module) {
  const stages = { extract, filter, truth, play, judge };
  (async () => {
    if (!stages[STAGE]) { console.log('阶段：' + Object.keys(stages).join(' / ')); process.exit(1); }
    await stages[STAGE]();
  })();
}
