'use strict';
// 效果实验（真实模型，花钱）：让 AI 真改文件，三种装法比一比——守不守规矩、有没有重写项目里已有的功能、摸索了多少、花多少。
//   A 不装：同样的规则全写进 CLAUDE.md（没有需求树的人就是这样，每次全文加载），每个需求挂的文档也在那里点名
//   B 装需求树、没有代码地图：编译成按路径加载的规则
//   C 装需求树、有代码地图：B 再加上 src/codemap.js 生成的地图
// 每种一份项目副本（只有文本文件），git 记下原样，每遍开始前还原。不装 hook（不跑记录员），自动记忆指向空文件夹。
// 评判（Sonnet）：拿到改到的文件适用的全部规则、这块已有的模块（代码地图里列的）和改动（diff），
// 逐条判断改动涉及没有、守了没有；再判断有没有自己新写了一份已有模块已经提供的功能。
// 用法：node test/eval-effect.js <项目目录> <需求树文件> <输出目录> --set=vl|shidi [--reps=4] [--arms=A,B,C]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const P = require(ROOT + '/src/parser');
const { scopeOf, autoLoads } = require(ROOT + '/src/compile');
const { isRoot } = require(ROOT + '/src/common');
const { copyProject } = require('./eval-ia');

const [src, treeFile, out] = process.argv.slice(2);
const opt = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const REPS = Number(opt('reps', 4));
const ARMS = opt('arms', 'A,B,C').split(',');
const SET = opt('set', 'vl');
const DONE = '直接改文件，不用问我，改完用一两句话说你改了什么。';
const TASKS = {
  vl: [
    { id: 'ds', prompt: `在数据科学课第1章（DataScience/ch01-cholera.html）的末尾、练习之前，加一小节「本章小结」，讲清这一章的要点。${DONE}` },
    { id: 'ml', prompt: `给机器学习课梯度下降这一章（ml-quest/ch03-gradient-descent.html）加一道小练习：选择题，考学习率太大时会发生什么。${DONE}` },
  ],
  shidi: [
    { id: 'closed', prompt: `店铺打烊后，玩家走近店门时，在屏幕上提示一句「已打烊，营业时间 9:00–21:00」（时间写这家店实际的营业时间）。只加这个提示，别的不动。代码在 pig-city-diary/ 里。${DONE}` },
    { id: 'tip', prompt: `外卖送达时按用时给小费：送得越快小费越多，最多多给 30%。数值要能调。代码在 pig-city-diary/ 里。${DONE}` },
  ],
}[SET];
fs.mkdirSync(out, { recursive: true });

const treeText = fs.readFileSync(treeFile, 'utf8');
const root = P.parse(treeText);
// 这个文件适用的规则：根上的 + 范围覆盖它的需求的（和编译出的加载方式一样）
function rulesFor(files) {
  const seen = new Set(), list = [];
  for (const f of files) for (const n of P.walk(root)) {
    const hit = isRoot(n) || (autoLoads(n) && scopeOf(n).some(g => P.globToRegExp(g).test(f)));
    if (hit) for (const r of n.rules) { const k = `${n.id}：${r.text}`; if (!seen.has(k)) { seen.add(k); list.push(k); } }
  }
  return list;
}
const git = (dir, args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 256 << 20, windowsHide: true });

function setup(arm) {
  const dir = path.join(out, arm);
  fs.rmSync(dir, { recursive: true, force: true });
  copyProject(src, dir);
  fs.writeFileSync(path.join(dir, '需求树.md'), treeText);
  fs.rmSync(path.join(dir, '.reqtree'), { recursive: true, force: true });
  fs.rmSync(path.join(dir, '.claude', 'rules', 'reqtree'), { recursive: true, force: true });
  if (arm === 'A') {
    fs.rmSync(path.join(dir, '需求树.md'));
    const lines = ['', '## 项目规则', ''];
    for (const n of P.walk(root)) {
      if (!n.rules.length && !n.docs.length) continue;
      lines.push(`### ${n.title}${n.files.length ? `（${n.files.join('、')}）` : ''}`);
      if (n.docs.length) lines.push(`背景文档：${n.docs.join('、')}`);
      for (const r of n.rules) lines.push(`- ${r.text}`);
      lines.push('');
    }
    fs.appendFileSync(path.join(dir, 'CLAUDE.md'), lines.join('\n'));
  } else {
    const tree = path.join(dir, '需求树.md');
    fs.mkdirSync(path.join(dir, '.claude', 'rules', 'reqtree'), { recursive: true });
    if (arm === 'B') { fs.mkdirSync(path.join(dir, '.reqtree'), { recursive: true }); fs.writeFileSync(path.join(dir, '.reqtree', 'config.json'), JSON.stringify({ codeMap: false })); }
    require(ROOT + '/src/compile').compile(tree, { targets: { claude: true, codex: false } });
    if (arm === 'C') { require(ROOT + '/src/codemap').refresh(tree, { targets: { claude: true, codex: false } }); require(ROOT + '/src/compile').compile(tree, { targets: { claude: true, codex: false } }); }
  }
  git(dir, ['init', '-q']);
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=eval', '-c', 'user.email=eval@x', 'commit', '-qm', 'base', '--no-verify']);
  return dir;
}

// 改某个文件时规则、说明、地图一共多少字（静态算：CLAUDE.md + 每次加载的 + 路径匹配的）
function contextChars(dir, files) {
  const chars = f => { try { return [...fs.readFileSync(f, 'utf8')].length; } catch { return 0; } };
  let n = chars(path.join(dir, 'CLAUDE.md'));
  const rules = path.join(dir, '.claude', 'rules', 'reqtree');
  if (fs.existsSync(rules)) for (const f of fs.readdirSync(rules)) {
    const t = fs.readFileSync(path.join(rules, f), 'utf8');
    const m = t.match(/^---\npaths:\n([\s\S]*?)\n---/);
    const globs = m ? [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]) : null;
    if (!globs || files.some(file => globs.some(g => P.globToRegExp(g).test(file)))) n += [...t].length;
  }
  return n;
}

// 这几个文件所在那块已有的模块（C 组的代码地图里列的），给评判看「有没有重写已有的」
function existingModules(files) {
  const dir = path.join(out, 'C', '.claude', 'rules', 'reqtree');
  const parts = [];
  try {
    for (const f of fs.readdirSync(dir).filter(x => /^(map-.+|_map)\.md$/.test(x))) {
      const t = fs.readFileSync(path.join(dir, f), 'utf8');
      const m = t.match(/^---\npaths:\n([\s\S]*?)\n---/);
      const globs = m ? [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]) : null;
      if (!globs || files.some(file => globs.some(g => P.globToRegExp(g).test(file)))) parts.push(t.replace(/^---[\s\S]*?---\n/, '').replace(/<!--.*?-->\n?/g, ''));
    }
  } catch {}
  return parts.join('\n').slice(0, 12000);
}

function claude(args, input, cwd, timeoutMs = 1200000) {
  return new Promise(resolve => {
    const p = spawn('claude', args, { cwd, shell: true, windowsHide: true, env: { ...process.env, REQTREE_RECORDER: '1' } });
    let so = '', se = '';
    p.stdout.on('data', d => { so += d; }); p.stderr.on('data', d => { se += d; });
    const t = setTimeout(() => { spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F']); }, timeoutMs);
    p.on('close', () => { clearTimeout(t); resolve({ so, se }); });
    p.stdin.end(input || '');
  });
}

async function judge(rules, mods, diff) {
  const prompt = `下面是一个项目里这次改到的文件适用的全部规则（编号）、这块代码已经有的模块，和 AI 这次的改动（git diff，+ 是加的，- 是删的；新文件整份是 +）。

1. 逐条判断规则：relevant 这条规则管不管这次改动做的事（改动里根本没涉及的写 false，可以不列）；relevant 为 true 的再判断 ok：改动守了这条没有。只看改动本身，不评价原有的内容。
2. dup：这次改动有没有自己新写了一份「已有的模块」里已经提供的功能（比如自己算营业时间、自己写一个提示框，而项目里已经有现成的）。有就写 true，并在 dupWhat 里一句话说重写了什么、本该用哪个。拿不准写 false。

<规则>
${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}
</规则>

<已有的模块>
${mods || '（这块没有代码地图）'}
</已有的模块>

<改动>
${diff.slice(0, 40000)}
</改动>

只输出 JSON：{"items":[{"i":1,"relevant":true,"ok":false,"why":"一句话"}],"dup":false,"dupWhat":""}`;
  const r = await claude(['-p', '--model', 'sonnet', '--strict-mcp-config', '--no-session-persistence', '--setting-sources', 'user', '--output-format', 'json'], prompt, os.tmpdir(), 600000);
  let meta = {};
  try { meta = JSON.parse(r.so); } catch {}
  const m = String(meta.result || r.so).match(/\{[\s\S]*\}/);
  try { return { ...JSON.parse(m[0]), cost: meta.total_cost_usd || 0 }; } catch { return null; }
}

// 一遍：还原副本 → 让 AI 做任务（stream-json，数工具调用）→ 取改动 → 评判
async function runOnce(arm, dir, task, rep) {
  git(dir, ['checkout', '-q', '--', '.']);
  git(dir, ['clean', '-qfd']);
  const t0 = Date.now();
  const r = await claude(['-p', JSON.stringify(task.prompt), '--model', 'sonnet', '--permission-mode', 'acceptEdits', '--max-budget-usd', '2.5',
    '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--no-session-persistence'], '', dir);
  const tools = {};
  let result = {};
  for (const line of r.so.split('\n')) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) for (const c of ev.message.content) if (c.type === 'tool_use') tools[c.name] = (tools[c.name] || 0) + 1;
    if (ev.type === 'result') result = ev;
  }
  git(dir, ['add', '-A']);
  const files = (git(dir, ['diff', '--cached', '--name-only']).stdout || '').split('\n').filter(Boolean);
  const diff = git(dir, ['diff', '--cached', '--no-color', '-U2']).stdout || '';
  git(dir, ['reset', '-q']);
  const rules = rulesFor(files);
  const j = diff ? await judge(rules, existingModules(files), diff) : null;
  const rel = ((j && j.items) || []).filter(x => x.relevant);
  const bad = rel.filter(x => !x.ok);
  const explore = ['Grep', 'Glob', 'Read', 'Bash', 'LS'].reduce((s, k) => s + (tools[k] || 0), 0);
  const u = result.usage || {};
  const row = { task: task.id, arm, rep, seconds: Math.round((Date.now() - t0) / 1000), cost: result.total_cost_usd || 0, judgeCost: j ? j.cost : 0, turns: result.num_turns,
    input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), output: u.output_tokens || 0,
    tools, explore, context: contextChars(dir, files.length ? files : ['x']), files, changed: !!diff, judged: !!j, relevant: rel.length, violations: bad.length,
    dup: !!(j && j.dup), dupWhat: j ? j.dupWhat || '' : '', bad: bad.map(x => `${x.i} ${(rules[x.i - 1] || '').slice(0, 50)}：${x.why}`), result: String(result.result || '').slice(0, 300) };
  fs.writeFileSync(path.join(out, `diff-${task.id}-${arm}-${rep}.diff`), diff);
  return row;
}

(async () => {
  const dirs = {};
  for (const a of ARMS.includes('C') ? ['C', ...ARMS.filter(x => x !== 'C')] : ARMS) dirs[a] = setup(a);
  const resFile = path.join(out, 'results.json');
  const results = fs.existsSync(resFile) ? JSON.parse(fs.readFileSync(resFile, 'utf8')) : [];
  for (const task of TASKS) for (let rep = 0; rep < REPS; rep++) {
    // 三种同时跑（各自一份副本）
    const rows = await Promise.all(ARMS.filter(a => !results.some(r => r.task === task.id && r.arm === a && r.rep === rep)).map(a => runOnce(a, dirs[a], task, rep)));
    for (const row of rows) { results.push(row); console.log(JSON.stringify({ ...row, bad: undefined, result: undefined, files: row.files.length, tools: undefined })); }
    fs.writeFileSync(resFile, JSON.stringify(results, null, 1));
  }
  const sum = a => {
    const rs = results.filter(r => r.arm === a);
    const avg = k => +(rs.reduce((s, r) => s + (r[k] || 0), 0) / Math.max(1, rs.length)).toFixed(2);
    return { runs: rs.length, changed: rs.filter(r => r.changed).length, violations: avg('violations'), relevant: avg('relevant'), dup: rs.filter(r => r.dup).length,
      explore: avg('explore'), turns: avg('turns'), input: Math.round(avg('input')), context: Math.round(avg('context')), cost: avg('cost'), seconds: avg('seconds') };
  };
  const summary = Object.fromEntries(ARMS.map(a => [a, sum(a)]));
  const byTask = Object.fromEntries(TASKS.map(t => [t.id, Object.fromEntries(ARMS.map(a => { const rs = results.filter(r => r.task === t.id && r.arm === a); return [a, +(rs.reduce((s, r) => s + r.violations, 0) / Math.max(1, rs.length)).toFixed(2)]; }))]));
  const spent = results.reduce((s, r) => s + (r.cost || 0) + (r.judgeCost || 0), 0);
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ summary, byTask, spent }, null, 1));
  console.log(JSON.stringify({ summary, byTask, spent: +spent.toFixed(2) }, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
