#!/usr/bin/env node
'use strict';
// 对照实验：装 reqtree 和不装，规则库的混乱程度差多少（重复、过时、多余、错误、遗漏、矛盾）。
// 播放 test/fixtures/confusion/script.json 里的 32 轮对话，每轮之后各组更新自己的规则库：
//   plain   对照组A：主 AI（Haiku 扮演）按一句普通的"有长期要求就记进项目规则文档"，输出改后的 Markdown 全文
//   careful 对照组B：同上，但提示词写得认真（原地改、一条只写一处、一次性指令不记、例外写在那一章）
//   reqtree 实验组：记录员的同一套逻辑（buildPrompt → 模型给 ops → applyOps 直接写回树），
//           并且和 hook 一样每 --sweep=N 轮（默认 8，0 关掉）补漏一次（buildSweepPrompt，只许加和改）
// 播完后，评审模型（Sonnet）对照 expected.json 逐条判定，程序汇总成数字。
// 花额度，手动运行：
//   node test/eval-confusion.js [遍数=2] [--arms=plain,careful,reqtree] [--out=目录]
//   node test/eval-confusion.js --judge-only --out=目录      只重新评审已有的结果
//   --steps=N 只播前 N 轮、--no-judge 不评审（冒烟测试）、--sweep=N 补漏间隔
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const recorder = require('../hooks/recorder');
const { buildPrompt, isTrivial } = recorder;
const { applyOps, parse, walk } = require('../src/parser');

const FIX = path.join(__dirname, 'fixtures', 'confusion');
const BASE = '--strict-mcp-config --no-session-persistence --setting-sources user --output-format json';
const HAIKU = process.env.REQTREE_CLAUDE_CMD || `claude -p --model haiku ${BASE}`;
const SONNET = `claude -p --model sonnet ${BASE}`;
// 和 hooks/recorder.js 一致：模型只能做这几种改动
const ALLOWED_OPS = new Set(['add_rule', 'replace_rule', 'remove_rule', 'add_node', 'set_status', 'add_files']);

const args = process.argv.slice(2);
const opt = name => { const a = args.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const RUNS = Number(args.find(a => /^\d+$/.test(a))) || 2;
const ARMS = (opt('arms') || 'plain,careful,reqtree').split(',');
const SWEEP = opt('sweep') != null ? Number(opt('sweep')) : 8;
const OUT = path.resolve(opt('out') || path.join(os.tmpdir(), 'reqtree-eval-confusion', new Date().toISOString().replace(/[:.]/g, '-')));

// --steps=N 只播前 N 轮（冒烟测试用）
const script = JSON.parse(fs.readFileSync(path.join(FIX, 'script.json'), 'utf8')).turns.slice(0, Number(opt('steps')) || undefined);
const expected = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8'));
const INIT_TREE = fs.readFileSync(path.join(FIX, 'init-tree.md'), 'utf8');
const INIT_DOC = fs.readFileSync(path.join(FIX, 'init-doc.md'), 'utf8');

const stats = { calls: 0, cost: 0, fails: 0 };

// 调一次 claude -p，返回 { text, cost, ms }；失败重试一次
function call(cmd, prompt, tries = 2) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const p = spawn(cmd, { shell: true, cwd: os.tmpdir(), env: { ...process.env, REQTREE_RECORDER: '1' }, windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', async code => {
      stats.calls++;
      let j = null;
      try { j = JSON.parse(out); } catch {}
      if (j && !j.is_error && typeof j.result === 'string') {
        stats.cost += j.total_cost_usd || 0;
        return resolve({ text: j.result, cost: j.total_cost_usd || 0, ms: Date.now() - t0, usage: j.usage });
      }
      if (tries > 1) return resolve(await call(cmd, prompt, tries - 1));
      stats.fails++;
      resolve({ text: null, error: (err || out).slice(0, 300) || `退出码 ${code}`, ms: Date.now() - t0 });
    });
    p.stdin.end(prompt);
  });
}

// ---------- 对照组：主 AI 维护一份 Markdown 规则文档 ----------
const DOC_NAME = '项目规则.md';
const PLAIN_INSTR = `项目说明里写着：「用户提出长期要求时，记进 ${DOC_NAME}。」`;
const CAREFUL_INSTR = `项目说明里写着：「用户提出长期要求（以后都要遵守的规则或偏好）时，记进 ${DOC_NAME}。一次性的指令、提问、闲聊不用记。改已有规则时在原条目上改，不要另加一条；用户推翻的规则删掉；同一条规则只写一处，以用户最新的说法为准；只对某一章的例外写在那一章名下。」`;

function docPrompt(instr, doc, turns) {
  const convo = turns.map(t => `用户：${t.user}\nAI：${t.ai}`).join('\n---\n');
  return `你是这个项目的 AI 编程助手。项目里有一份规则文档 ${DOC_NAME}，记录用户的长期要求，以后每次对话都会读它。${instr}

下面是 ${DOC_NAME} 现在的内容：
<${DOC_NAME}>
${doc}
</${DOC_NAME}>

最近的对话（最后一轮是刚刚发生的）：
<对话>
${convo}
</对话>

请根据刚刚这一轮对话，看 ${DOC_NAME} 需不需要更新。直接在回复里输出更新后的完整文件内容（不要用工具写文件），放在 <file> 和 </file> 之间；不需要改就原样输出。`;
}

function extractDoc(text) {
  const m = text && text.match(/<file>\s*([\s\S]*?)\s*<\/file>/);
  if (!m) return null;
  return m[1].replace(/^```(?:markdown|md)?\s*\n/, '').replace(/\n```\s*$/, '').trim() + '\n';
}

// ---------- 实验组：记录员 ----------
function extractOps(text) {
  const m = text && text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { const ops = JSON.parse(m[0]).ops; return Array.isArray(ops) ? ops.filter(o => o && ALLOWED_OPS.has(o.op)) : null; } catch { return null; }
}

async function playRun(arm, run) {
  const dir = path.join(OUT, `${arm}-${run}`);
  fs.mkdirSync(dir, { recursive: true });
  let state = arm === 'reqtree' ? INIT_TREE : INIT_DOC;
  const log = [];
  for (let i = 0; i < script.length; i++) {
    // 和 hook 一样只给最近两轮：更早的对话 + 最新一轮
    const turns = script.slice(Math.max(0, i - 1), i + 1).map(t => ({ user: t.user, ai: t.ai }));
    const entry = { n: script[i].n, user: script[i].user };
    if (arm === 'reqtree') {
      if (isTrivial(script[i].user)) entry.skipped = '短消息/短提问，不调用模型';
      else {
        const r = await call(HAIKU, buildPrompt(state, turns, [], []));
        Object.assign(entry, { ms: r.ms, cost: r.cost, raw: r.text, error: r.error });
        const ops = extractOps(r.text);
        if (!ops) entry.parseFail = true;
        else {
          const { text, applied } = applyOps(state, ops);
          entry.ops = ops; entry.applied = applied.map(a => { const { undo, ...rest } = a; return rest; });
          state = text;
        }
      }
      // 补漏：和 hooks/hook.js takeSweep 一样，攒够 SWEEP 轮、其中有实质内容才调用
      if (SWEEP > 0 && (i + 1) % SWEEP === 0 && recorder.buildSweepPrompt) {
        const pending = script.slice(i + 1 - SWEEP, i + 1).map(t => t.user);
        if (pending.some(m => !isTrivial(m))) {
          const r = await call(HAIKU, recorder.buildSweepPrompt(state, pending));
          const ops = (extractOps(r.text) || []).filter(o => recorder.SWEEP_OPS.has(o.op));
          const { text, applied } = applyOps(state, ops);
          entry.sweep = { cost: r.cost, raw: r.text, error: r.error, applied: applied.map(a => { const { undo, ...rest } = a; return rest; }) };
          state = text;
        }
      }
    } else {
      const r = await call(HAIKU, docPrompt(arm === 'plain' ? PLAIN_INSTR : CAREFUL_INSTR, state, turns));
      Object.assign(entry, { ms: r.ms, cost: r.cost, error: r.error });
      const doc = extractDoc(r.text);
      if (!doc) { entry.parseFail = true; entry.raw = r.text; } else { entry.changed = doc.trim() !== state.trim(); state = doc; }
    }
    log.push(entry);
    fs.writeFileSync(path.join(dir, `step${String(i + 1).padStart(2, '0')}.md`), state);
    process.stdout.write(`${arm}-${run}:${i + 1} `);
  }
  fs.writeFileSync(path.join(dir, 'final.md'), state);
  fs.writeFileSync(path.join(dir, 'log.json'), JSON.stringify(log, null, 2));
  return state;
}

// ---------- 把最终规则库拆成一条条规则（带范围） ----------
function rulesOfTree(text) {
  const out = [];
  for (const n of walk(parse(text))) {
    const scope = [];
    for (let x = n; x && x.parent; x = x.parent) scope.unshift(x.parent.parent ? x.title : '全局（所有课程）');
    for (const r of n.rules) out.push({ scope: scope.join(' > '), text: (r.key ? `[${r.key}] ` : '') + r.text });
  }
  return out;
}
function rulesOfDoc(text) {
  const init = new Set(INIT_DOC.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
  const out = [], stack = [];
  let fence = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) { fence = !fence; continue; }
    const line = raw.trim();
    const h = !fence && line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { stack.length = h[1].length - 1; stack[h[1].length - 1] = h[2]; continue; }
    if (!line || init.has(line) || /^[-*_]{3,}$/.test(line) || /^\|[-:\s|]+\|$/.test(line)) continue;
    out.push({ scope: stack.filter(Boolean).slice(1).join(' > ') || '（文档开头）', text: line.replace(/^([-*+]|\d+[.、)])\s+/, '') });
  }
  return out;
}

// ---------- 评审 ----------
function judgePrompt(rules) {
  const convo = script.map(t => `${t.n} [${t.kind}] 用户：${t.user}\n   AI：${t.ai}`).join('\n');
  const exp = expected.rules.map(e => `${e.id}｜范围：${e.scope}｜${e.point}（来自第 ${e.from.join('、')} 条）`).join('\n');
  const bad = Object.entries(expected.should_not_remain).map(([k, v]) => `${k}：\n${v.map(x => '  - ' + x).join('\n')}`).join('\n');
  const list = rules.map((r, i) => `R${i + 1}｜范围：${r.scope}｜${r.text}`).join('\n');
  return `你是评审。一个 AI 助手在下面这段对话里，每轮之后维护一份项目规则库。请对照标准答案，逐条评判对话结束时规则库里的每一条规则。

<对话>（方括号里是这条消息的类型：new 新要求 / modify 修改 / restate 换说法重复 / overturn 推翻 / exception 某一章的例外 / oneoff 一次性指令 / chat 闲聊 / question 提问 / confirm 同意 AI 的建议）
${convo}
</对话>

<标准答案：最后应该剩下的规则>
${exp}

不该留下的：
${bad}

${expected.legit_exceptions}
</标准答案>

<最终规则库>（范围是这条规则写在哪个标题下面）
${list}
</最终规则库>

每条最终规则只选一个判定：
- 正确：对应某条标准答案，意思对、范围对。一条规则合并了几条标准答案（如 E7+E8）也算正确，matches 里都列上。同一条标准答案已经有一条正确的规则时，后面再出现的算重复。
- 重复：和另一条最终规则表达同一个要求（换了说法也算），第二条及以后算重复。
- 过时：内容是被后来的消息修改或推翻之前的旧版本。如果一条规则写了新旧两种说法但明确以新的为准，算正确。
- 多余：来自一次性指令、提问、闲聊，或者是用户从没提过、AI 自己加的要求；也包括不是规则的说明文字、改动记录、状态记录。
- 错误：用户确实提过这件事，但内容记错，或范围错（例如章节例外写成全局，一门课的规则写成全局）。

标准答案覆盖：对每条 E，最终规则库里有没有一条判为"正确"的规则表达它；没有就是遗漏（covered=false）。
矛盾：列出最终规则库里互相冲突、照着做会无所适从的规则对（含过时规则和新规则的冲突）。写在对应章节下、明确只管那一章的例外不算矛盾。

逐条给理由（一句话）。只输出 JSON，不要别的文字：
{"rules":[{"id":"R1","verdict":"正确","matches":["E1"],"reason":"..."}],"expected":[{"id":"E1","covered":true,"by":["R1"],"reason":"..."}],"contradictions":[{"a":"R2","b":"R9","reason":"..."}]}`;
}

const VERDICTS = ['正确', '重复', '过时', '多余', '错误'];
async function judge(dir, arm) {
  const text = fs.readFileSync(path.join(dir, 'final.md'), 'utf8');
  const rules = arm === 'reqtree' ? rulesOfTree(text) : rulesOfDoc(text);
  fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify(rules, null, 2));
  let j = null;
  for (let k = 0; k < 2 && !j; k++) {
    const r = await call(SONNET, judgePrompt(rules));
    fs.writeFileSync(path.join(dir, 'judge-raw.txt'), r.text || r.error || '');
    const m = r.text && r.text.match(/\{[\s\S]*\}/);
    try { j = m && JSON.parse(m[0]); } catch { j = null; }
  }
  if (!j) return { arm, dir, error: '评审没返回 JSON' };
  fs.writeFileSync(path.join(dir, 'judge.json'), JSON.stringify(j, null, 2));
  const count = Object.fromEntries(VERDICTS.map(v => [v, (j.rules || []).filter(r => r.verdict === v).length]));
  return {
    arm, run: path.basename(dir), total: rules.length, ...count,
    遗漏: (j.expected || []).filter(e => !e.covered).length,
    矛盾: (j.contradictions || []).length,
    judged: (j.rules || []).length,
  };
}

const NAMES = { plain: '对照A 普通提示词', careful: '对照B 认真提示词', reqtree: '实验组 reqtree' };
function table(rows) {
  const cols = ['total', ...VERDICTS, '遗漏', '矛盾'];
  const head = `| 组 | 遍 | 规则总数 | ${VERDICTS.join(' | ')} | 遗漏 | 矛盾 |\n|---|---|${cols.map(() => '---').join('|')}|`;
  const lines = [head];
  for (const arm of ARMS) {
    const rs = rows.filter(r => r.arm === arm && !r.error);
    for (const r of rs) lines.push(`| ${NAMES[arm]} | ${r.run} | ${cols.map(c => r[c]).join(' | ')} |`);
    if (rs.length) lines.push(`| **${NAMES[arm]}** | 平均 | ${cols.map(c => (rs.reduce((s, r) => s + r[c], 0) / rs.length).toFixed(1)).join(' | ')} |`);
  }
  return lines.join('\n');
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();
  const jobs = [];
  if (!args.includes('--judge-only')) {
    console.log(`输出目录：${OUT}\n播放剧本：${ARMS.join('、')} 各 ${RUNS} 遍，并行`);
    await Promise.all(ARMS.flatMap(arm => Array.from({ length: RUNS }, (_, i) => playRun(arm, i + 1))));
    console.log(`\n播放完成：${stats.calls} 次调用，${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
  }
  if (args.includes('--no-judge')) return;
  for (const d of fs.readdirSync(OUT)) {
    const m = d.match(/^(plain|careful|reqtree)-\d+$/);
    if (m && ARMS.includes(m[1]) && fs.existsSync(path.join(OUT, d, 'final.md'))) jobs.push(judge(path.join(OUT, d), m[1]));
  }
  const rows = await Promise.all(jobs);
  const report = `${table(rows)}\n\n调用 ${stats.calls} 次（失败 ${stats.fails}），费用 $${stats.cost.toFixed(3)}，用时 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`;
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ rows, stats, ms: Date.now() - t0 }, null, 2));
  fs.writeFileSync(path.join(OUT, 'summary.md'), report + '\n');
  console.log('\n' + report);
  for (const r of rows.filter(r => r.error)) console.log(`✗ ${r.dir}：${r.error}`);
})();
