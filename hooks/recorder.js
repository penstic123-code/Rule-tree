#!/usr/bin/env node
'use strict';
// 记录员：每轮回复结束后由 hook 在后台启动。
// 1. 这一轮 AI 改过的需求，没状态 / 待做 / 待定 的标成 🔨（确定的事，不用模型）
// 2. 用户这一轮说了实质内容时，让小模型判断有没有新要求、哪些需求做完了、新文件该归哪个需求
// 改动直接生效（面板上可撤销）。结果写进 .reqtree/state.json 的 recorder，面板会显示；出错也写在那里。
// 用法：node recorder.js <job.json>
//   job = { treePath, turns[{ user, ai, start }], transcriptPath, touched[], unmapped[] }
//   turns 是 hook 用公开字段攒下的最近两轮；transcriptPath 只在 turns 为空时兜底读（未公开格式）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { parse, findById, outline, nodeForFile } = require('../src/parser');
const store = require('../src/store');

const LOG = path.join(os.tmpdir(), 'reqtree', 'recorder.log');
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
const ALLOWED_OPS = new Set(['add_rule', 'replace_rule', 'remove_rule', 'add_node', 'set_status', 'add_files']);

// add_files 只在有根据时保留：glob 能匹配这一轮没归属的文件，或者用户这句话里提到了 glob 里的路径（用户明确要设文件）。
// 已经被这个需求现有范围覆盖的具体文件也丢掉。2026-10-22 实测 Codex 的小模型在没有未归属文件时，
// 给已由 DataScience/ch02-*.html 覆盖的 R4 又加了 DataScience/ch02-next.html。提示词约束不可靠，在代码里拦
const globMatches = (globs, rel) => !!nodeForFile({ children: [{ files: globs, children: [], level: 1 }] }, rel);
function filterAddFiles(ops, { root, unmapped = [], user = '' }) {
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
    else log(`丢掉没有根据的 add_files：${JSON.stringify(o)}`);
  }
  return out;
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

// 明显没有长期要求的消息不调用模型。不用关键词白名单：那会漏掉"第1章开头用霍乱"这类没有关键词的要求。
const TRIVIAL = /^(好|好的|行|可以|嗯|对|是|ok|okay|继续|开始|做吧|去吧|谢谢|收到|没问题|go)[。.!！~～\s]*$/i;
function isTrivial(msg) {
  if (msg.startsWith('/') || msg.length < 6 || TRIVIAL.test(msg)) return true;
  // 短的纯提问
  return /[?？]\s*$/.test(msg) && msg.length < 30 && !/(以后|不要|别|改成|都要|应该|必须)/.test(msg);
}

function buildPrompt(tree, turns, touched, unmapped) {
  const latest = turns[turns.length - 1];
  const earlier = turns.slice(0, -1).map(t => `用户：${t.user}\nAI：${t.ai}`);
  return `你是需求记录员。下面是一个项目的需求树（Markdown）：标题是需求，开头是 ID，结尾 ✅完成 🔨正在做 ⏳待做 ❓待定；标题下 "- " 开头的是规则，可带 [键]，子需求用同一个键覆盖母规则；"> 文件：" 是这个需求对应的文件。

<需求树>
${tree}
</需求树>
${earlier.length ? `\n<更早的对话（只作上下文）>\n${earlier.join('\n---\n')}\n</更早的对话>\n` : ''}
<最新一轮>
用户：${latest.user}
AI：${latest.ai}
</最新一轮>
${touched.length ? `\n这一轮 AI 改了这些需求的文件：${touched.join('、')}` : ''}${unmapped.length ? `\n这一轮 AI 改了这些还没归属的文件：${unmapped.join('、')}` : ''}

请输出这一轮应该对需求树做的改动：
1. 用户提出的长期要求（新规则、修改或否决已有规则、新需求）。AI 的建议只有在用户明确同意时才算。
   - 对某一章、某个页面或模块的内容、结构、风格做的决定（以后还成立），也是长期要求，挂在那个需求上；树里还没有这个需求，就在对应的上级下 add_node 再加规则。AI 这一轮已经照做了也要记。
     例：「第5章用地铁线路图来举例」→ 记到第5章；「把第5章的地铁图改大一点」→ 一次性，不记。
   - 只有针对这次改动、做完就结束的指令（"把这段改短""修一下这个 bug"）、提问、闲聊不算。
   - **先在树里找同一主题的已有规则**（同一件事，哪怕措辞不同）：
     · 意思已经包含 → 什么都不做；
     · 用户改了它的内容 → replace_rule（old 填树里原文，不含 [键]），不要另加一条；
     · 用户否决它 → remove_rule。
     只有树里确实没有这个主题时才 add_rule。宁可改一条，不要加一条相似的。
   - 规则挂在它管辖范围最小的节点上；用户说"以后都""所有章节""每次"之类时，挂到覆盖这个范围的最高节点。
   - 子需求要在本范围内推翻上级的规则时，用 add_rule 并写上和上级同一个 [键]（上级没有键就别加）。
   - 规则写成一句简短具体的中文，用用户的意思，不要扩写。
2. 需求状态：只有用户明确说某需求做完了、或 AI 说做完而用户认可时，才 set_status 为 done。
3. 没归属的文件如果明显属于某个需求，用 add_files 给出 glob（如 DataScience/ch02-*.html）；拿不准就不给。

只输出 JSON，不要任何别的文字；没有改动就输出 {"ops":[]}：
{"ops":[{"op":"replace_rule","node":"ID","old":"树里原文","text":"新内容"},{"op":"add_rule","node":"ID","key":"可选","text":"..."},{"op":"remove_rule","node":"ID","text":"原文"},{"op":"add_node","parent":"ID","id":"新ID","title":"..."},{"op":"set_status","node":"ID","status":"done"},{"op":"add_files","node":"ID","globs":["..."]}]}`;
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
function runModel(prompt) {
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
    }, TIMEOUT_MS);
  });
}

async function askModel(prompt) {
  const res = await runModel(prompt);
  if (res.timedOut) throw new Error(`调用模型超时（${Math.round(TIMEOUT_MS / 1000)} 秒没有返回）`);
  if (res.error) throw new Error(`调用模型失败：${res.error.message}`);
  if (res.status !== 0) throw new Error(`模型返回错误：${(res.stderr || res.stdout || '').trim().slice(0, 200) || '退出码 ' + res.status}`);
  const m = (res.stdout || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`模型没有返回 JSON：${(res.stdout || '').slice(0, 120)}`);
  const ops = JSON.parse(m[0]).ops;
  if (!Array.isArray(ops)) throw new Error('模型返回的 JSON 里没有 ops');
  const ok = ops.filter(o => o && ALLOWED_OPS.has(o.op));
  if (ok.length < ops.length) log(`丢掉模型给的不允许的操作：${JSON.stringify(ops.filter(o => !ok.includes(o)))}`);
  return ok;
}

function describe(applied, queued) {
  const count = op => applied.filter(o => o.op === op).length;
  const parts = [];
  const rules = count('add_rule') + count('replace_rule') + count('remove_rule') + count('add_node') + count('add_files');
  if (rules) parts.push(`记下 ${rules} 条`);
  const done = applied.filter(o => o.op === 'set_status' && o.status === 'done').map(o => o.node);
  const doing = applied.filter(o => o.op === 'set_status' && o.status === 'doing').map(o => o.node);
  if (done.length) parts.push(`${done.join('、')} 标为完成`);
  if (doing.length) parts.push(`${doing.join('、')} 标为正在做`);
  if (queued) parts.push(`${queued} 条改动等你保存需求树后写入`);
  return parts.join('；') || '这一轮没有新要求';
}

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
      catch (e) { throw new Error(`拿不到这一轮的对话：hook 没收到用户原话，读对话记录也失败了（${e.message}）`); }
      if (!turns.length) throw new Error('拿不到这一轮的对话：hook 没收到用户原话，对话记录里也没找到');
    }
    const latest = turns.length ? turns[turns.length - 1].user : '';
    const config = store.readConfig(treePath);
    let asked = false;
    if (turns.length && config.recorder !== 'off' && !isTrivial(latest)) {
      const lines = text.split(/\r?\n/).length;
      const tree = lines > BIG_TREE_LINES ? outline(text, touched) : text;
      ops.push(...filterAddFiles(await askModel(buildPrompt(tree, turns, touched, unmapped)), { root, unmapped, user: latest }));
      asked = true;
    }

    let { applied, queued } = ops.length ? store.submitOps(treePath, ops) : { applied: [], queued: 0 };
    let message = config.recorder === 'off' ? '已暂停（只标正在做，不记新要求）' : describe(applied, queued);

    // 3. 补漏：这一轮记完以后，拿最新的树对照最近几轮的原话（hook 每 sweepEvery 轮、压缩前才给）
    const sweep = (job.sweep || []).filter(m => typeof m === 'string' && m.trim()).map(m => clip(clean(m), 1000));
    if (sweep.length && config.recorder !== 'off') {
      let note;
      try {
        const now = fs.readFileSync(treePath, 'utf8');
        const tree = now.split(/\r?\n/).length > BIG_TREE_LINES ? outline(now, touched) : now;
        const sops = (await askModel(buildSweepPrompt(tree, sweep))).filter(o => SWEEP_OPS.has(o.op));
        asked = true;
        const r = sops.length ? store.submitOps(treePath, sops) : { applied: [], queued: 0 };
        const n = r.applied.length + r.queued;
        note = n ? `补漏记下 ${n} 条` : `补漏查了 ${sweep.length} 句，没有漏的`;
        log(`补漏 ${sweep.length} 句｜${JSON.stringify(r.applied)}`);
        applied = applied.concat(r.applied); queued += r.queued;
      } catch (e) {
        // 这一轮的记录已经写进树了，补漏失败不能把它说成整轮出错
        if (job.sweepOnly) throw e;
        note = `补漏失败：${e.message}`;
        log('补漏出错：' + e.stack);
      }
      message = job.sweepOnly || message === '这一轮没有新要求' ? note : `${message}；${note}`;
    }
    status = { ok: true, asked, message };
    log(`${message}｜${JSON.stringify(applied)}`);
  } catch (e) {
    status = { ok: false, message: e.message };
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
module.exports = { lastTurns, isTrivial, buildPrompt, buildSweepPrompt, SWEEP_OPS, describe, splitCommand, filterAddFiles };
