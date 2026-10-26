'use strict';
// 「装与不装」违规实验的执行器（花钱：每次调用真实的 claude -p，Sonnet）。
//   node test/eval-violation-run.js <工作目录> <任务列表,如 T1,T2> <条件列表,如 A,B,C> <每格几遍> [预算美元]
// 工作目录里：tpl-A/ tpl-B/ tpl-C/（模板）、runs/（每次的干净副本）、results/（每次一个 json + 原始 jsonl）、home/（隔离的 ~/.ruletree）、tmp/（隔离的 TEMP，hook.log 在这里）
// 已有结果的格子会跳过，可以反复运行续跑。累计花费到预算就停止发新任务。
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const P = require('./eval-violation-project');
const { judge } = require('./eval-violation');

const [workArg, taskArg, condArg, repArg, budgetArg] = process.argv.slice(2);
const WORK = path.resolve(workArg);
const REPO = path.join(__dirname, '..');
// 第二轮（隐含规则）：EVAL_V2=1，用另一个工作目录
const V2 = process.env.EVAL_V2 === '1';
const BUDGET = Number(budgetArg || 15);
const CONC = 3;
const w = (...p) => path.join(WORK, ...p);
const writeAll = (dir, files) => { for (const [f, t] of Object.entries(files)) { const p = path.join(dir, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); } };
const gitInit = dir => {
  const g = a => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  g(['init', '-q']); g(['config', 'core.autocrlf', 'false']); g(['config', 'user.email', 'e@e']); g(['config', 'user.name', 'e']);
  g(['add', '-A']); g(['commit', '-q', '-m', 'init']);
};

// 模板：A 装 RuleTree（真的跑 init）、B 什么都没有、C 全写进 CLAUDE.md
function makeTemplates() {
  fs.mkdirSync(w('home'), { recursive: true }); fs.mkdirSync(w('tmp'), { recursive: true });
  for (const c of ['A', 'B', 'C']) {
    const d = w('tpl-' + c);
    if (fs.existsSync(d)) continue;
    fs.mkdirSync(d, { recursive: true });
    writeAll(d, P.buildProject(V2));
    if (c === 'C') writeAll(d, { 'CLAUDE.md': P.claudeMd(V2) });
    if (c === 'A') {
      const rf = {}; for (const [n, t] of Object.entries(P.ruleFiles(V2))) rf['.claude/rules/ruletree/' + n] = t;
      writeAll(d, rf);
      gitInit(d); // init 要在 git 项目里
      const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'ruletree.js'), 'init', d], { encoding: 'utf8', env: { ...process.env, RULETREE_HOME: w('home', '.ruletree') } });
      fs.writeFileSync(w('init-A.log'), (r.stdout || '') + (r.stderr || ''));
      fs.rmSync(path.join(d, '.git'), { recursive: true, force: true });
    }
  }
}

// fs.cpSync 在带中文的长路径上会 EIO，自己递归复制
function copyDir(a, b) {
  fs.mkdirSync(b, { recursive: true });
  for (const e of fs.readdirSync(a, { withFileTypes: true })) e.isDirectory() ? copyDir(path.join(a, e.name), path.join(b, e.name)) : fs.copyFileSync(path.join(a, e.name), path.join(b, e.name));
}

function freshCopy(cond, name) {
  const dir = w('runs', name);
  fs.rmSync(dir, { recursive: true, force: true });
  copyDir(w('tpl-' + cond), dir);
  try { fs.rmSync(path.join(dir, '.ruletree', 'context.jsonl'), { force: true }); } catch {}
  gitInit(dir);
  return dir;
}

function runClaude(dir, prompt, extra, env) {
  return new Promise(resolve => {
    const args = ['-p', '--model', 'sonnet', '--output-format', 'stream-json', '--verbose', '--max-turns', '25',
      '--permission-mode', 'acceptEdits', '--setting-sources', 'project,local', '--strict-mcp-config', '--disable-slash-commands',
      '--allowedTools', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Agent', 'Task', 'Bash(node:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(git:*)', ...(extra || [])];
    const t0 = Date.now();
    const ch = spawn('claude', args, { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let out = '', err = '';
    ch.stdout.on('data', d => { out += d; }); ch.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => ch.kill(), 12 * 60 * 1000);
    ch.on('close', () => { clearTimeout(timer); resolve({ out, err, ms: Date.now() - t0 }); });
    ch.stdin.end(prompt);
  });
}

function summarize(raw) {
  const ev = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const res = ev.filter(e => e.type === 'result').pop() || {};
  const tools = {}, reads = [], sidechain = { tools: 0 };
  for (const e of ev) {
    if (e.type !== 'assistant' || !e.message || !Array.isArray(e.message.content)) continue;
    for (const c of e.message.content) {
      if (c.type !== 'tool_use') continue;
      tools[c.name] = (tools[c.name] || 0) + 1;
      if (c.input && c.input.file_path) reads.push(`${c.name}:${String(c.input.file_path).replace(/\\/g, '/').split('/').slice(-3).join('/')}`);
      if (e.parent_tool_use_id) sidechain.tools++;
    }
  }
  const u = res.usage || {};
  return {
    cost: res.total_cost_usd || 0, turns: res.num_turns || 0, ms: res.duration_ms || 0, isError: !!res.is_error, subtype: res.subtype,
    input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), freshInput: u.input_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0, cacheCreate: u.cache_creation_input_tokens || 0, output: u.output_tokens || 0,
    text: res.result || '', tools, reads, subagentToolCalls: sidechain.tools,
  };
}

async function runJob(job) {
  const name = `${job.cond}-${job.task}-${job.rep}`;
  const dir = freshCopy(job.cond, name);
  const task = [...P.TASKS, ...P.TASKS2, ...P.EXTRA].find(t => t.id === job.task);
  const env = { ...process.env, TEMP: w('tmp'), TMP: w('tmp'), RULETREE_HOME: w('home', '.ruletree'), CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
  const r = await runClaude(dir, task.prompt, [], env);
  fs.mkdirSync(w('results'), { recursive: true });
  fs.writeFileSync(w('results', name + '.jsonl'), r.out);
  const s = summarize(r.out);
  const j = judge(dir, job.task, V2);
  let ctx = null;
  try { ctx = fs.readFileSync(path.join(dir, '.ruletree', 'context.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch {}
  const rec = { ...job, name, wallMs: r.ms, ...s, ...j, ctx, stderr: r.err.slice(0, 500) };
  fs.writeFileSync(w('results', name + '.json'), JSON.stringify(rec, null, 1));
  return rec;
}

const spent = () => { let t = 0; try { for (const f of fs.readdirSync(w('results'))) if (f.endsWith('.json')) t += JSON.parse(fs.readFileSync(w('results', f), 'utf8')).cost || 0; } catch {} return t; };

(async () => {
  makeTemplates();
  const jobs = [];
  for (let rep = 1; rep <= Number(repArg || 3); rep++) for (const task of taskArg.split(',')) for (const cond of condArg.split(',')) jobs.push({ cond, task, rep });
  const todo = jobs.filter(j => !fs.existsSync(w('results', `${j.cond}-${j.task}-${j.rep}.json`)));
  console.log(`待跑 ${todo.length} 次，已花 $${spent().toFixed(2)}，预算 $${BUDGET}`);
  let i = 0, stop = false;
  const worker = async () => {
    while (!stop) {
      const job = todo[i++]; if (!job) return;
      if (spent() >= BUDGET) { stop = true; console.log('到预算，停止'); return; }
      const rec = await runJob(job);
      console.log(`${rec.name} 违反 ${rec.violations.map(v => v.rule).join(',') || '-'} 完成 ${rec.done} $${rec.cost.toFixed(3)} 回合 ${rec.turns}${rec.isError ? ' 出错 ' + rec.subtype : ''}`);
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log(`累计 $${spent().toFixed(2)}`);
})();
