#!/usr/bin/env node
'use strict';
// 记录员：每轮回复结束后由 hook 在后台启动。
// 1. 这一轮 AI 改过的需求，没状态 / 待做 / 待定 的标成 🔨（确定的事，不用模型）
// 2. 用户这一轮说了实质内容时，让小模型判断有没有新要求、哪些需求做完了、新文件该归哪个需求
//    有把握的直接改；拿不准的（管全项目还是只管这一块、新说法是取代还是补充、做完没有）先按最可能的改，
//    同时记一个问题（src/questions.js），插件弹出选项让用户改选
// 3. 标着 🔨 很久没动的需求，变成同一种问题（不调用模型）
// 改动直接生效（面板上可撤销）。结果写进 .reqtree/state.json 的 recorder，面板会显示；出错也写在那里。
// 用法：node recorder.js <job.json>
//   job = { treePath, turns[{ user, ai, start }], transcriptPath, touched[], unmapped[], sweep?[], sweepOnly? }
//   turns 是 hook 用公开字段攒下的最近两轮；transcriptPath 只在 turns 为空时兜底读（未公开格式）
//   sweep 是要补漏检查的最近几句用户原话（每 sweepEvery 轮和压缩前才有）；sweepOnly 表示只补漏（压缩前，没有这一轮）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { parse, findById, outline, nodeForFile, applyOps, oneLine, SKIP_REASON } = require('../src/parser');
const store = require('../src/store');
const Q = require('../src/questions');

const { tmpDir } = require('../src/common');
const LOG = path.join(tmpDir(), 'recorder.log');
const log = msg => {
  try {
    // 日志超过 1 MB 就从头开始
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 1024 * 1024) fs.renameSync(LOG, LOG + '.old');
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
};
// 不加载 MCP 和项目配置（冷启动从约 10 秒降到约 6 秒），不保存会话（免得塞满用户的 /resume 列表）
const CLAUDE = process.env.REQTREE_CLAUDE_CMD
  || 'claude -p --model haiku --strict-mcp-config --no-session-persistence --setting-sources user';
const TIMEOUT_MS = +process.env.REQTREE_CLAUDE_TIMEOUT_MS || 120000;
const BIG_TREE_LINES = 200;

// 模型只能做这几种改动（和提示词里列的一致）。模型编出 delete_node、set_files 之类会删掉整个子树，一律丢掉
const ALLOWED_OPS = new Set(['add_rule', 'replace_rule', 'remove_rule', 'add_node', 'set_status', 'add_files', 'override_rule']);
// 每轮最多问几个问题、每个问题几个选项
const MAX_QUESTIONS = 2;
const MIN_OPTIONS = 2, MAX_OPTIONS = 4;

// add_files 只在有根据时保留：glob 能匹配这一轮没归属的文件，或者用户这句话里提到了 glob 里的路径（用户明确要设文件）。
// 已经被这个需求现有范围覆盖的具体文件也丢掉。2026-10-22 实测 Codex 的小模型在没有未归属文件时，
// 给已由 DataScience/ch02-*.html 覆盖的 R4 又加了 DataScience/ch02-next.html。提示词约束不可靠，在代码里拦
const globMatches = (globs, rel) => !!nodeForFile({ children: [{ files: globs, children: [], level: 1 }] }, rel);
// dropped：传了数组就把丢掉的放进去（{ op, reason: 'no-basis' }），记录员要报给面板
function filterAddFiles(ops, { root, unmapped = [], user = '', dropped } = {}) {
  const out = [];
  for (const o of ops) {
    if (o.op !== 'add_files') { out.push(o); continue; }
    const node = root && findById(root, o.node);
    const globs = (o.globs || []).filter(g => {
      if (typeof g !== 'string' || !g.trim()) return false;
      if (node && node.files.length && !/[*?]/.test(g) && globMatches(node.files, g)) return false;
      if (unmapped.some(f => globMatches([g], f))) return true;
      return g.split(/[/*?]+/).some(seg => seg.length >= 2 && !/^\.[A-Za-z0-9]+$/.test(seg) && user.includes(seg.replace(/[-_.]+$/, '')));
    });
    if (globs.length) out.push({ ...o, globs });
    else { log(`丢掉没有根据的 add_files：${JSON.stringify(o)}`); if (dropped) dropped.push({ op: o, reason: 'no-basis' }); }
  }
  return out;
}

// 模型给的一组改动：只留允许的操作，换行压成空格，没根据的 add_files 去掉
const allowedOp = allowed => o => o && typeof o === 'object' && allowed.has(o.op);
function cleanOps(list, ctx, allowed = ALLOWED_OPS) {
  const arr = Array.isArray(list) ? list : [];
  const ok = arr.filter(allowedOp(allowed)).map(oneLine);
  if (ok.length < arr.length) {
    const bad = arr.filter(o => !allowedOp(allowed)(o));
    log(`丢掉模型给的不允许的操作：${JSON.stringify(bad)}`);
    if (ctx && ctx.dropped) ctx.dropped.push(...bad.map(op => ({ op, reason: 'not-allowed' })));
  }
  return filterAddFiles(ok, ctx);
}

// 比较两条改动是不是同一条（模型照提示把默认做法也写进了 ops，要认出来，免得记两次）
const OP_FIELDS = ['op', 'node', 'parent', 'id', 'title', 'key', 'text', 'old', 'new', 'from', 'status', 'globs'];
const opKey = o => { const x = oneLine(o); return JSON.stringify(OP_FIELDS.map(k => (typeof x[k] === 'string' ? x[k].trim() : x[k] == null ? null : x[k]))); };
const oneLineText = (s, max) => { const t = String(s).replace(/[\r\n]+/g, ' ').trim(); return t.length > max ? t.slice(0, max) + '…' : t; };

// 模型给的一个问题，先看格式：问题文字、2–4 个选项（各有 label 和 ops）、default 指向其中一个。
// 选项的改动和普通改动过同样的筛子；有改动被筛掉的选项整个不要（剩下的改动已经不是 label 说的意思了）。
// default 那个选项不合格，或者剩下不到 2 个选项，整个问题不要
function shapeQuestion(q, ctx, allowed) {
  if (!q || typeof q !== 'object' || typeof q.text !== 'string' || !q.text.trim() || !Array.isArray(q.options)) return null;
  const def = Number.isInteger(q.default) ? q.default : 0;
  const seen = new Set();
  const options = q.options.slice(0, MAX_OPTIONS).map(o => {
    if (!o || typeof o !== 'object' || typeof o.label !== 'string' || !o.label.trim() || !Array.isArray(o.ops)) return null;
    const label = oneLineText(o.label, 60);
    if (seen.has(label)) return null;
    const ops = cleanOps(o.ops, ctx, allowed);
    if (ops.length < o.ops.length) return null;
    seen.add(label);
    return { label, ops };
  });
  return keepOptions({ text: oneLineText(q.text, 200), options, default: def });
}
// 去掉不合格（null）的选项，default 跟着挪
function keepOptions(q) {
  if (!q.options[q.default]) return null;
  const kept = q.options.filter(Boolean);
  if (kept.length < MIN_OPTIONS) return null;
  return { ...q, options: kept, default: kept.indexOf(q.options[q.default]) };
}

// 从模型的输出里挑出合格的问题，并把 ops 里和问题选项重复的改动拿掉（问题的默认做法单独记一条改动，才撤销得掉）。
// 选项的改动要在「这一轮其余改动做完之后」的树上至少有一条能生效，否则这个选项不要（指向不存在的需求、规则）。
// 被丢掉的问题，它的改动留在 ops 里照常生效。返回 { ops, questions }
function pickQuestions(raw, { text, before = [], ops = [], ctx, allowed = ALLOWED_OPS, max = MAX_QUESTIONS }) {
  const list = Array.isArray(raw) ? raw : [];
  const cands = list.map(q => shapeQuestion(q, ctx, allowed)).filter(Boolean).slice(0, max);
  if (cands.length < Math.min(list.length, max)) log(`丢掉格式不对的问题：${JSON.stringify(list).slice(0, 500)}`);
  const keysOf = qs => new Set(qs.flatMap(q => q.options.flatMap(o => o.ops.map(opKey))));
  const k1 = keysOf(cands);
  const base = applyOps(text, [...before, ...ops.filter(o => !k1.has(opKey(o)))]).text;
  const questions = cands.map(q => keepOptions({
    ...q, options: q.options.map(o => (!o.ops.length || applyOps(base, o.ops).applied.length ? o : null)),
  })).filter(Boolean);
  if (questions.length < cands.length) log(`丢掉选项对不上需求树的问题：${JSON.stringify(cands.filter(c => !questions.some(q => q.text === c.text)))}`);
  const k2 = keysOf(questions);
  return { ops: ops.filter(o => !k2.has(opKey(o))), questions };
}

// 问题的默认做法写进树（用户正在编辑就排队），再把问题记下来。返回 { applied, queued, skipped }
function recordQuestions(treePath, questions, source = '记录员') {
  let applied = [], queued = 0, skipped = [];
  for (const q of questions) {
    const id = Q.newId();
    const ops = q.options[q.default].ops;
    const r = ops.length ? store.submitOps(treePath, ops, { qid: id }) : { applied: [], queued: 0, id: null, skipped: [] };
    Q.addQuestion(treePath, { id, source, text: q.text, options: q.options, default: q.default, defaultApplied: true, changeId: r.id, queued: r.queued > 0 });
    applied = applied.concat(r.applied); queued += r.queued; skipped = skipped.concat(r.skipped || []);
  }
  return { applied, queued, skipped };
}

// 从对话记录（jsonl，Claude Code 内部格式）取最近几轮：用户的话 + AI 回复正文
// 长对话的记录有几十 MB，只读末尾一段就够找到最近几轮
const TAIL_BYTES = 1024 * 1024;

const clean = s => String(s).replace(/<(system-reminder|ide_[a-z_]+)>[\s\S]*?<\/\1>/g, '').trim();
const clip = (s, max) => (s.length > max ? s.slice(0, max) + '…（截断）' : s);

function lastTurns(transcriptPath, n) {
  const turns = [];
  for (const line of store.readTail(transcriptPath, TAIL_BYTES).split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const c = e.message && e.message.content;
    if (e.type === 'user' && !e.isMeta) {
      const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : (c || []);
      if (blocks.some(b => b.type === 'tool_result')) continue;
      const text = clean(blocks.filter(b => b.type === 'text').map(b => b.text).join('\n'));
      if (text) turns.push({ user: text, ai: '' });
    } else if (e.type === 'assistant' && turns.length && Array.isArray(c)) {
      turns[turns.length - 1].ai += c.filter(b => b.type === 'text').map(b => b.text).join('\n');
    }
  }
  return turns.slice(-n).map(t => ({ user: clip(t.user, 2000), ai: clip(t.ai, 2500) }));
}

// 明显没有长期要求的消息不调用模型：整句就是「好」「继续」这类应答、斜杠命令、两个字以内、短的纯提问。
// 不按长度一刀切：「全用中文」「标题别加粗」只有四五个字，却是长期要求（2026-10-22 审查发现）。
// 也不用关键词白名单：那会漏掉"第1章开头用霍乱"这类没有关键词的要求
const TRIVIAL = /^(好|好的|好吧|好滴|行|行吧|可以|可以的|嗯|嗯嗯|对|对的|是|是的|ok|okay|继续|开始|做吧|去吧|谢谢|收到|明白|了解|知道了|没问题|不错|go)[。.!！~～\s]*$/i;
function isTrivial(msg) {
  const s = String(msg).trim();
  if (s.startsWith('/') || [...s].length <= 2 || TRIVIAL.test(s)) return true;
  // 短的纯提问
  return /[?？]\s*$/.test(s) && s.length < 30 && !/(以后|不要|别|改成|都要|应该|必须)/.test(s);
}

// notes：这一轮 AI 写进自动记忆的笔记 [{ file, text }]（hook 从 PostToolUse 记下的，见 job.memory）
function buildPrompt(tree, turns, touched, unmapped, notes = [], aiFindings = false) {
  const latest = turns[turns.length - 1];
  const earlier = turns.slice(0, -1).map(t => `用户：${t.user}\nAI：${t.ai}`);
  const noteBlock = notes.length ? `\n<这一轮 AI 写进它自己的自动记忆的笔记>\n${notes.map(n => `文件 ${n.file}：\n${n.text}`).join('\n---\n')}\n</这一轮 AI 写进它自己的自动记忆的笔记>\n` : '';
  const noteTask = notes.length ? `
5. 自动记忆只该记和项目内容无关的事（用户本人的情况、工具和电脑环境、私人信息、外部资源在哪）。上面某份笔记整份都是这个项目的需求或规则时：先确保需求树里有（已有同一件事就不加；没有就照第 1 条加或改写），再输出 {"op":"memory_absorb","file":"文件名"} 删掉这份笔记。笔记里混着和项目无关的内容，或者拿不准的，不动它。` : '';
  return `你是需求记录员。下面是一个项目的需求树（Markdown）：标题是需求，开头是 ID，结尾 ✅完成 🔨进行中 ⏳待做 ❓待定；标题下 "- " 开头的是规则，可带 [键]，子需求用同一个键覆盖母规则；"> 文件：" 是这个需求对应的文件。

<需求树>
${tree}
</需求树>
${earlier.length ? `\n<更早的对话（只作上下文）>\n${earlier.join('\n---\n')}\n</更早的对话>\n` : ''}
<最新一轮>
用户：${latest.user}
AI：${latest.ai}
</最新一轮>
${touched.length ? `\n这一轮 AI 改了这些需求的文件：${touched.join('、')}` : ''}${unmapped.length ? `\n这一轮 AI 改了这些还没归属的文件：${unmapped.join('、')}` : ''}${noteBlock}

请输出这一轮应该对需求树做的改动：
1. 用户提出的长期要求（新规则、修改或否决已有规则、新需求）。AI 的建议只有在用户明确同意时才算。
   - 对某一章、某个页面或模块的内容、结构、风格做的决定（以后还成立），也是长期要求，挂在那个需求上；树里还没有这个需求，就在对应的上级下 add_node 再加规则。AI 这一轮已经照做了也要记。
     例：「第5章用地铁线路图来举例」→ 记到第5章；「把第5章的地铁图改大一点」→ 一次性，不记。
   - 只有针对这次改动、做完就结束的指令（"把这段改短""修一下这个 bug"）、提问、闲聊不算。
   - 只记这个项目自己的需求：在讨论别的工具、别的项目（比如正在用的插件、另一个程序）时提的要求不记。
   - 和项目内容无关的不记，那些归 AI 自己的自动记忆：用户的工具和电脑环境（如"别在会话中装插件""这台电脑的终端是 GBK"）、私人信息（服务器地址、账号、密码、本机路径、邮箱）。需求树会提交进仓库，私人信息绝不能写进树。
   - **先在树里找同一主题的已有规则**（同一件事，哪怕措辞不同）：
     · 意思已经包含 → 什么都不做；
     · 用户的新说法和它不一样（哪怕没说"改成"）→ 以最新的为准改写它，不要两条并存：replace_rule（old 填树里原文，不含 [键]）；
     · 用户否决它 → remove_rule。
     只有树里确实没有这个主题时才 add_rule。宁可改一条，不要加一条相似的。
     例：旧「像素风探险地图」，新「改成2D横版像素游戏」→ replace_rule；
         P 里旧「手账风全课通用」，新「手账风只属于第一篇」→ 缩小范围：remove_rule P 那条，在第一篇 add_rule；
         P 里旧「每章互动不超过4个」，新「第5章互动可以多一点」→ 只第5章例外：在第5章 override_rule。
   - 规则挂在它管辖范围最小的节点上；用户说"以后都""所有章节""每次"之类时，挂到覆盖这个范围的最高节点。最顶上那个需求只放明确对整个项目都成立的规则。
   - 这个项目整体怎么做事、怎么写、怎么沟通的偏好（如"交流用中文""反馈含糊先问清""文风要平实"），不是某门课、某个模块内容特有的，挂到最顶上那个需求——哪怕说的时候进行中某一章。只有那一块内容本身的决定才挂在那一块上。
   - 子需求要在本范围内推翻上级的规则时，用 override_rule（node 是子需求，from 是上级 ID，text 是上级原文，new 是新内容）。
   - 规则写成一句简短具体的中文，用用户的意思，不要扩写。
${aiFindings ? `   - AI 在这一轮回复里明确说出的、以后改这块还用得上的做法或坑（例：「qa.mjs 必须传绝对路径，相对路径会静默得到空结果」「这个接口要先登录再调」），用户没有反对的，也记成规则，挂在对应需求上，规则开头写「（AI 发现）」。只记确定的、能照着做的；这一轮的进展、猜测、一次性的修复步骤不记。
` : ''}2. 需求状态：用户说某需求做完了，或 AI 的回复明确说整个需求做完了 → set_status done；用户说某需求还没想好、先放着、待定 → set_status question。看着像做完了又不确定（比如只说做完了一部分）→ 不改，按第 4 条问「做完了吗」，default 是「还没」（ops 为空）。
3. 没归属的文件如果明显属于某个需求，用 add_files 给出 glob（如 DataScience/ch02-*.html）；拿不准就不给。
4. 拿不准就问：只在真有歧义、只有用户能定的时候问——这句话管全项目还是只管当前这门课或这一章；新说法是取代旧规则、缩小范围还是补充；某需求做完没有。先把最可能的做法照常写进 ops，同时在 questions 里问：text 是一句简短的问题，options 是 2–4 种做法（label 几个字，ops 是这种做法完整的改动，可以为空），default 是已写进 ops 的那个选项的序号（从 0 起）。每轮最多 2 个问题；有把握的直接改，不要问。${noteTask}

只输出 JSON，不要任何别的文字；没有改动就输出 {"ops":[]}：
{"ops":[{"op":"replace_rule","node":"ID","old":"树里原文","text":"新内容"},{"op":"add_rule","node":"ID","key":"可选","text":"..."},{"op":"remove_rule","node":"ID","text":"原文"},{"op":"override_rule","node":"子需求ID","from":"上级ID","text":"上级原文","new":"新内容"},{"op":"add_node","parent":"ID","id":"新ID","title":"..."},{"op":"set_status","node":"ID","status":"done 或 question"},{"op":"add_files","node":"ID","globs":["..."]}],
 "questions":[{"text":"「每章配3张图」只管这门课，还是全项目？","options":[{"label":"只管这门课","ops":[{"op":"add_rule","node":"C1","text":"每章配3张图"}]},{"label":"全项目","ops":[{"op":"add_rule","node":"P","text":"每章配3张图"}]}],"default":0}]}`;
}

// 补漏：把最近几轮用户的原话一起对照树，只补单轮判断漏掉的长期要求。
// 只能加（add_rule、add_node）：不改、不删规则，不改状态、不设文件。补漏只看到一串原话，看不到每句当时树是什么样，
// 改规则容易改错（实测把「第2章只出 3 道」改回了后来的全局「3–5 道」）；改主意由单轮判断负责
const SWEEP_OPS = new Set(['add_rule', 'add_node']);
function buildSweepPrompt(tree, messages) {
  return `你是需求记录员，现在做一次补漏检查。下面是一个项目的需求树（Markdown）：标题是需求，开头是 ID；标题下 "- " 开头的是规则，可带 [键]；"> 文件：" 是这个需求对应的文件。

<需求树>
${tree}
</需求树>

<用户最近说的话（按时间顺序）>
${messages.map((m, i) => `${i + 1}. ${m}`).join('\n')}
</用户最近说的话>

逐句对照需求树，只补明显漏记的长期要求：
- 长期要求：用户提出、以后还要遵守的规则或偏好，包括对某一章、某个页面或模块的内容、结构、风格做的决定。
- 下面这些都不动：树里已经有同一件事（哪怕措辞不同，或已经被后来的话改过）；只针对当时那次改动、做完就结束的指令（"把这段改短""把标题改成 X""修一下这个 bug"）；提问、闲聊；用户取消或否决的东西（树里没有就是已经删了，不要记成"不要 X"）；拿不准的。
- 规则挂在管辖范围最小的节点上；树里没有对应的需求，就在对应的上级下 add_node 再加规则。规则写成一句简短具体的中文。

只输出 JSON，不要任何别的文字；没有要补的就输出 {"ops":[]}：
{"ops":[{"op":"add_rule","node":"ID","text":"..."},{"op":"add_node","parent":"ID","id":"新ID","title":"..."}]}`;
}

// 把命令行拆成参数（posix 不经过 shell 时用）：认双引号、单引号和反斜杠转义，和 sh 的规则一致
function splitCommand(cmd) {
  const args = [];
  let cur = '', has = false, quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote === "'") { if (c === "'") quote = null; else cur += c; continue; }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < cmd.length && '"\\$`'.includes(cmd[i + 1])) cur += cmd[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (c === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; has = true; continue; }
    if (/\s/.test(c)) { if (has) { args.push(cur); cur = ''; has = false; } continue; }
    cur += c; has = true;
  }
  if (has) args.push(cur);
  return args;
}

// 杀掉整棵进程树。Windows 上 claude 是 claude.cmd，经 cmd.exe 再起 node，只杀 cmd.exe 会留下真正干活的 node；
// posix 上子进程单独成一个进程组（detached），杀整个组
function killTree(child) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }
}

// 调用 claude。Windows 要经过 shell（claude 是 .cmd）；posix 直接按参数启动，免得路径里的 $、引号被 shell 解释
function runModel(prompt, timeoutMs = TIMEOUT_MS) {
  return new Promise(resolve => {
    const win = process.platform === 'win32';
    const [file, ...args] = win ? [CLAUDE] : splitCommand(CLAUDE);
    let child;
    try {
      child = spawn(file, args, {
        shell: win, windowsHide: true, detached: !win,
        cwd: os.tmpdir(), // 不在项目里运行，避免加载项目的 hook
        env: { ...process.env, REQTREE_RECORDER: '1' },
      });
    } catch (error) { resolve({ error }); return; }
    let stdout = '', stderr = '', done = false;
    const finish = r => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    child.stdout.setEncoding('utf8').on('data', d => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', d => { stderr += d; });
    child.stdin.on('error', () => {}); // 对方没读完就退出时写入会 EPIPE
    child.stdin.end(prompt);
    child.on('error', error => finish({ error }));
    child.on('close', status => finish({ status, stdout, stderr }));
    const timer = setTimeout(() => {
      killTree(child);
      // 不等管道关闭：万一还有孙进程攥着管道，也不能把记录员挂住
      for (const s of [child.stdout, child.stderr, child.stdin]) try { s.destroy(); } catch {}
      finish({ timedOut: true });
    }, timeoutMs);
  });
}

// 出错时除了中文 message，再带上结构化的 t（{ k: 文字表的键, a: 参数 }），面板按当前语言显示
const fail = (message, k, ...a) => Object.assign(new Error(message), { t: { k, a } });

// 调用模型，返回它输出的 JSON 对象
// timeoutMs：等多久（体检一批内容多，等得久些）
async function askJson(prompt, { timeoutMs = TIMEOUT_MS } = {}) {
  const res = await runModel(prompt, timeoutMs);
  if (res.timedOut) throw fail(`调用模型超时（${Math.round(timeoutMs / 1000)} 秒没有返回）`, 'rec.err.timeout', Math.round(timeoutMs / 1000));
  if (res.error) throw fail(`调用模型失败：${res.error.message}`, 'rec.err.spawn', res.error.message);
  if (res.status !== 0) {
    const out = (res.stderr || res.stdout || '').trim().slice(0, 200);
    throw fail(`模型返回错误：${out || '退出码 ' + res.status}`, 'rec.err.model', out || String(res.status));
  }
  const m = (res.stdout || '').match(/\{[\s\S]*\}/);
  if (!m) throw fail(`模型没有返回 JSON：${(res.stdout || '').slice(0, 120)}`, 'rec.err.noJson', (res.stdout || '').slice(0, 120));
  let out;
  try { out = JSON.parse(m[0]); } catch { throw fail(`模型没有返回 JSON：${(res.stdout || '').slice(0, 120)}`, 'rec.err.noJson', (res.stdout || '').slice(0, 120)); }
  if (!out || typeof out !== 'object') throw fail('模型返回的 JSON 里没有 ops', 'rec.err.noOps');
  return out;
}

// 只要改动（补漏用）：允许的操作
async function askModel(prompt) {
  const ops = (await askJson(prompt)).ops;
  if (!Array.isArray(ops)) throw fail('模型返回的 JSON 里没有 ops', 'rec.err.noOps');
  const ok = ops.filter(o => o && ALLOWED_OPS.has(o.op));
  if (ok.length < ops.length) log(`丢掉模型给的不允许的操作：${JSON.stringify(ops.filter(o => !ok.includes(o)))}`);
  return ok;
}

// 这一轮 AI 写进自动记忆的笔记（hook 给的 [{ dir, file }]）→ 可以收编的 [{ dir, file, text }]。
// 收编会删整份，所以模型必须看到整份：超过 NOTE_MAX 字的不给；用户本人（user）、外部资源（reference）两类本来就该留在记忆里，也不给
const NOTE_MAX = 1500;
function readNotes(list) {
  const M = require('../src/memory');
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    if (!m || typeof m.dir !== 'string' || typeof m.file !== 'string' || !M.isMemFile(m.file)) continue;
    let text;
    try { text = fs.readFileSync(path.join(m.dir, m.file), 'utf8').trim(); } catch { continue; }
    let type = '';
    try { type = M.readNote(m.dir, m.file).type; } catch {}
    if (type === 'user' || type === 'reference' || [...text].length > NOTE_MAX) continue;
    out.push({ dir: m.dir, file: m.file, text });
  }
  return out.slice(0, 5);
}

// 这一轮做了什么，写成结构化的几段（{ k, a }），面板按当前语言拼（media/strings.js 的 rec.*）
function describeParts(applied, queued, asked = 0) {
  const count = op => applied.filter(o => o.op === op).length;
  const parts = [];
  const rules = count('add_rule') + count('replace_rule') + count('remove_rule') + count('add_node') + count('add_files') + count('override_rule');
  if (rules) parts.push({ k: 'rec.rules', a: [rules] });
  if (count('memory_remove')) parts.push({ k: 'rec.absorbed', a: [count('memory_remove')] });
  const done = applied.filter(o => o.op === 'set_status' && o.status === 'done').map(o => o.node);
  const doing = applied.filter(o => o.op === 'set_status' && o.status === 'doing').map(o => o.node);
  if (done.length) parts.push({ k: 'rec.done', a: [done] });
  if (doing.length) parts.push({ k: 'rec.doing', a: [doing] });
  if (queued) parts.push({ k: 'rec.queued', a: [queued] });
  if (asked) parts.push({ k: 'rec.asked', a: [asked] });
  return parts.length ? parts : [{ k: 'rec.none', a: [] }];
}

// 同样几段的中文（state.json 里的 message、recorder.log、命令行和旧版本的面板用）。
// 和 media/strings.js 的中文一致（测试对照）；hook 运行时只复制 src/ 和 hooks/，读不到 media/，所以这里留一份
const ZH = {
  'rec.rules': n => `记下 ${n} 条`, 'rec.absorbed': n => `把 ${n} 份记忆收进需求树`,'rec.done': ids => `${ids.join('、')} 标为完成`, 'rec.doing': ids => `${ids.join('、')} 标为进行中`,
  'rec.queued': n => `${n} 条改动等你保存需求树后写入`, 'rec.asked': n => `${n} 件事拿不准，问你了`, 'rec.none': '这一轮没有新要求',
  'rec.paused': '已暂停（只标进行中，不记新要求）', 'rec.sweep': n => `补漏记下 ${n} 条`, 'rec.sweepNone': n => `补漏查了 ${n} 句，没有漏的`,
  'rec.sweepFail': m => `补漏失败：${m}`, 'rec.skipped': (n, first) => `${n} 条没写进去：${first}`,
};
const partText = p => { const v = ZH[p.k]; return typeof v === 'function' ? v(...(p.a || [])) : v; };
const partsText = parts => parts.map(partText).join('；');

function describe(applied, queued, asked = 0) {
  return partsText(describeParts(applied, queued, asked));
}

// 没写进去的改动：applyOps 跳过的（找不到需求、已经有了……）和这里筛掉的（不允许的操作、没根据的文件对应）。
// 都写进 recorder.log；状态里给个数和第一条，面板能看到，不再只说「这一轮没有新要求」
const skipText = s => `${s.op && s.op.op ? store.describeOp(s.op) : JSON.stringify(s.op)}（${SKIP_REASON[s.reason] || s.reason}）`;

async function main(jobPath) {
  const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
  fs.unlinkSync(jobPath);
  const { treePath } = job;
  const touched = job.touched || [];
  const unmapped = job.unmapped || [];
  let status;
  try {
    const text = fs.readFileSync(treePath, 'utf8');
    const root = parse(text);
    // 1. 确定的事：改过的需求标 🔨
    const ops = touched
      .map(id => findById(root, id))
      .filter(n => n && (!n.status || n.status === 'todo' || n.status === 'question'))
      .map(n => ({ op: 'set_status', node: n.id, status: 'doing' }));

    // 2. 需要判断的事交给模型。对话优先用 hook 通过公开字段（prompt、last_assistant_message）攒下的；
    //    拿不到时才退回去读对话记录（未公开格式，可能随版本变化）。只补漏（压缩前）时没有这一轮
    let turns = (job.turns || []).filter(t => t && t.user).map(t => ({ user: clip(clean(t.user), 2000), ai: clip(t.ai || '', 2500) }));
    if (!turns.length && !job.sweepOnly) {
      try { turns = lastTurns(job.transcriptPath, 2); }
      catch (e) { throw fail(`拿不到这一轮的对话：hook 没收到用户原话，读对话记录也失败了（${e.message}）`, 'rec.err.noTurnRead', e.message); }
      if (!turns.length) throw fail('拿不到这一轮的对话：hook 没收到用户原话，对话记录里也没找到', 'rec.err.noTurn');
    }
    const latest = turns.length ? turns[turns.length - 1].user : '';
    const config = store.readConfig(treePath);
    let asked = false, questions = [], absorb = [];
    const skipped = [];
    const notes = readNotes(job.memory);
    // 用户只说了「好」，AI 也可能在这一轮写了记忆：有新笔记就照样调用模型
    if (turns.length && config.recorder !== 'off' && (!isTrivial(latest) || notes.length)) {
      const lines = text.split(/\r?\n/).length;
      const tree = lines > BIG_TREE_LINES ? outline(text, touched) : text;
      const out = await askJson(buildPrompt(tree, turns, touched, unmapped, notes, config.aiFindings !== false));
      if (!Array.isArray(out.ops) && !Array.isArray(out.questions)) throw fail('模型返回的 JSON 里没有 ops', 'rec.err.noOps');
      // memory_absorb 只认这一轮写过的笔记；换成删整份记忆（先备份，可撤销）
      const own = new Map(notes.map(n => [n.file, n]));
      const rest = [];
      for (const o of Array.isArray(out.ops) ? out.ops : []) {
        if (o && o.op === 'memory_absorb') {
          const n = own.get(o.file);
          if (n && !absorb.some(a => a.file === n.file)) absorb.push({ op: 'memory_remove', dir: n.dir, file: n.file, whole: true });
          else log(`丢掉对不上的 memory_absorb：${JSON.stringify(o)}`);
        } else rest.push(o);
      }
      const ctx = { root, unmapped, user: latest, dropped: skipped };
      const picked = pickQuestions(out.questions, { text, before: ops, ops: cleanOps(rest, ctx), ctx: { root, unmapped, user: latest } });
      ops.push(...picked.ops);
      questions = picked.questions;
      asked = true;
    }

    let { applied, queued, skipped: s1 = [] } = ops.length ? store.submitOps(treePath, ops) : { applied: [], queued: 0 };
    skipped.push(...s1);
    if (questions.length) {
      const r = recordQuestions(treePath, questions);
      applied = applied.concat(r.applied); queued += r.queued;
      skipped.push(...r.skipped);
      log(`问用户 ${questions.length} 个问题：${JSON.stringify(questions)}`);
    }
    // 收编记忆：放在这一轮所有改动（包括问题的默认做法）之后。都写进去了（或者只是树里已经有）才删笔记；
    // 有改动没写进去（找不到需求等），或者还在排队（用户正在编辑需求树，写没写进去还不知道），笔记都留着，免得规则两边都丢了。
    // 这一轮问了问题也不删：规则可能在用户还没选的那个选项里
    if (absorb.length) {
      if (!queued && !questions.length && skipped.every(s => s.reason === 'duplicate' || s.reason === 'same')) {
        const r = store.submitOps(treePath, absorb);
        applied = applied.concat(r.applied); queued += r.queued;
        log(`收编记忆：${JSON.stringify(absorb.map(a => a.file))}`);
      } else log(`这一轮有改动没写进去、在排队或在问用户，不删记忆：${JSON.stringify(absorb.map(a => a.file))}`);
    }
    let parts = config.recorder === 'off' ? [{ k: 'rec.paused', a: [] }] : describeParts(applied, queued, questions.length);

    // 3. 补漏：这一轮记完以后，拿最新的树对照最近几轮的原话（hook 每 sweepEvery 轮、压缩前才给）
    const sweep = (job.sweep || []).filter(m => typeof m === 'string' && m.trim()).map(m => clip(clean(m), 1000));
    if (sweep.length && config.recorder !== 'off') {
      let notePart;
      try {
        const now = fs.readFileSync(treePath, 'utf8');
        const tree = now.split(/\r?\n/).length > BIG_TREE_LINES ? outline(now, touched) : now;
        const sops = (await askModel(buildSweepPrompt(tree, sweep))).filter(o => SWEEP_OPS.has(o.op));
        asked = true;
        const r = sops.length ? store.submitOps(treePath, sops) : { applied: [], queued: 0 };
        const n = r.applied.length + r.queued;
        notePart = n ? { k: 'rec.sweep', a: [n] } : { k: 'rec.sweepNone', a: [sweep.length] };
        log(`补漏 ${sweep.length} 句｜${JSON.stringify(r.applied)}`);
        applied = applied.concat(r.applied); queued += r.queued;
      } catch (e) {
        // 这一轮的记录已经写进树了，补漏失败不能把它说成整轮出错
        if (job.sweepOnly) throw e;
        notePart = { k: 'rec.sweepFail', a: [e.message] };
        log('补漏出错：' + e.stack);
      }
      const alone = job.sweepOnly || (parts.length === 1 && parts[0].k === 'rec.none');
      parts = alone ? [notePart] : parts.concat(notePart);
    }
    if (skipped.length) {
      for (const s of skipped) log(`没写进去：${skipText(s)}｜${JSON.stringify(s.op)}`);
      const part = { k: 'rec.skipped', a: [skipped.length, skipText(skipped[0])] };
      parts = parts.length === 1 && parts[0].k === 'rec.none' ? [part] : parts.concat(part);
    }
    const message = partsText(parts);
    status = { ok: true, asked, message, parts };
    log(`${message}｜${JSON.stringify(applied)}`);
    // 标着 🔨 很久没动的需求：变成问题（不调用模型，每个需求每个周期只问一次）
    try { Q.staleQuestions(treePath); } catch (e) { log('久未动的问题没生成：' + e.message); }
  } catch (e) {
    status = { ok: false, message: e.message, ...(e.t ? { t: e.t } : {}) };
    log('出错：' + e.stack);
  }
  // 状态只是给面板看的。树已经改好了、只是状态写不进去（state.lock 一直被占）时，不能把这一轮说成出错
  try { store.writeRecorderStatus(treePath, status); }
  catch (e) { log(`面板状态没写进去（${e.message}）${status.ok ? '；这一轮的改动已经写进需求树' : ''}`); }
}

if (require.main === module) {
  // 做完就退出：超时被杀掉的子进程万一留下了句柄，也不让记录员一直挂着
  main(process.argv[2]).catch(e => log('出错：' + e.stack)).finally(() => process.exit(0));
}
module.exports = {
  lastTurns, isTrivial, buildPrompt, buildSweepPrompt, SWEEP_OPS, ALLOWED_OPS, describe, describeParts, splitCommand, filterAddFiles,
  cleanOps, pickQuestions, recordQuestions, askJson, fail, log, BIG_TREE_LINES,
};
