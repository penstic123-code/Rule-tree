'use strict';
// 实测：干活的 AI 照说明书（_guide.md）记规则，准不准。要花钱（真实调用 claude -p，Sonnet）。
// 用法：node test/eval-record.js [--only A1,B2] [--runs 3] [--work 目录] [--model sonnet] [--budget 9]
// 做法：用 example/（中文示例）+ 几个假内容页搭模板项目 → 每次运行前复制一份干净的 → claude -p 带一句像真人说的话
//      → 用 src/ 里的读取函数比对规则文件的变化，按每个场景的期望判定（不靠肉眼）。
// 判定规则见 SCENARIOS 里的 kind：record 记到指定需求、none 一条都不许记、revise 改原条（不另加）。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const T = require('../src/tree');
const store = require('../src/store');

const ROOT = path.resolve(__dirname, '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const WORK = path.resolve(arg('work', path.join(require('os').tmpdir(), 'ruletree-eval-record')));
const RUNS = Number(arg('runs', 3));
const MODEL = arg('model', 'sonnet');
const BUDGET = Number(arg('budget', 9)); // 累计花费超过就停
const ONLY = arg('only', '') ? arg('only', '').split(',') : null;
const PER_RUN_CAP = arg('cap', '1.0');

// 每个场景的第 n 句话用 prompts[n]。expect：
//   kind 'record'：改的规则文件必须只有 files 之一（soft 里的算「挂到了上级」，半对）；新增 1–2 条；回复里要说「已记到 Rx」且和实际一致
//   kind 'none'：任何规则文件都不许变（不许新建、不许删）
//   kind 'revise'：只改 file，删一条加一条（规则条数不变），旧说法不在了
//   decision：新增的条以「决定：」开头；reason：理由关键词（正则）要出现在新增条里
const SCENARIOS = [
  { id: 'A', name: '改文件 + 以后都要守的要求', kind: 'record', cases: [
    { prompt: '把 DataScience/ch02-pipeline.html 的第一个小节标题改成「数据从哪来」。还有，第2章每个小节最后都要有一句小结，以后都这样。', files: ['R4'] },
    { prompt: 'DataScience/index.html 的页面标题改成「数据科学入门」。以后目录页每一篇旁边都要写上预计阅读时间。', files: ['R1'] },
    { prompt: 'DataScience/ch01-intro.html 里第一道练习题的解析再写详细点。另外以后第1章的练习题每道都要标上难度（易/中/难）。', files: ['R3.3'], soft: ['R3'] },
  ] },
  { id: 'B', name: '几个做法里拍板', kind: 'record', decision: true, cases: [
    { prompt: 'DataScience/ch02-pipeline.html 的开头有两种写法：一是用一个问题开头，二是用一个小场景开头。我选小场景，因为读者先要有画面才有兴趣读下去。按这个改一下开头。', files: ['R4'], reason: /画面|兴趣/ },
    { prompt: '目录页 DataScience/index.html 里每一篇的简介，写一句话还是写两三句？我定一句话，因为目录页太长读者会直接跳过。照这个把简介改一下。', files: ['R1'], reason: /跳过|太长/ },
    { prompt: '第1章的反例，是用红色标出，还是用虚线框？我选虚线框，因为红绿色盲的读者分不出红色。照这个改 DataScience/ch01-intro.html 里的反例。', files: ['R3.1'], soft: ['R3'], reason: /色盲/ },
  ] },
  { id: 'C', name: '只是提问', kind: 'none', cases: [
    { prompt: '第1章里说开场故事的段落可以到 6 行，为什么这样？' },
    { prompt: '第1章的练习题到底出几道？这和整个项目的要求不是冲突了吗？' },
    { prompt: '我要改第 2 章的时候，要守哪些规则？列给我看一下。' },
  ] },
  { id: 'D', name: '一次性指令', kind: 'none', cases: [
    { prompt: '帮我把 DataScience/ch01-intro.html 开场故事的第一段改得紧凑一点。这次先别加新的例子，等我想好再说。', edits: true },
    { prompt: '给 DataScience/ch02-pipeline.html 的第一节补两句过渡。这一章先别加图，图我之后统一做。', edits: true },
    { prompt: 'DataScience/index.html 的标题改成「数据科学入门」。这次先别动目录里的排序，我还没想好。', edits: true },
  ] },
  { id: 'E', name: '明说全项目的要求', kind: 'record', cases: [
    { prompt: '帮我看一下 DataScience/ch02-pipeline.html 有没有错别字。另外整个项目所有页面的正文字体都用思源宋体，全项目都这样。', files: ['P'] },
    { prompt: 'DataScience/index.html 的标题改成「数据科学入门」。还有，整个项目里所有章的标题都不要超过 12 个字，这是全项目的要求。', files: ['P'] },
    { prompt: 'DataScience/ch01-intro.html 末尾加一句结束语。另外整个课程的文案都不要用感叹号，所有页面通用。', files: ['P'] },
  ] },
  { id: 'F', name: '改主意推翻已有规则', kind: 'revise', cases: [
    { prompt: '第1章开场故事那几段我看了，之前说可以到 6 行，太长了，改主意了，最多 5 行。DataScience/ch01-intro.html 里按这个压一下。', file: 'R3.2', oldRe: /6\s*行/, newRe: /5\s*行/ },
    { prompt: '第1章之前定的是不引原话，现在改主意了：可以引原话，但必须标出处。在 DataScience/ch01-intro.html 里补一句带出处的引用。', file: 'R3', oldRe: /不引原话/, newRe: /出处/ },
    { prompt: '每篇最后一章放回顾这个不要了，改成回顾放在每篇的第一章前面。DataScience/index.html 的说明里也按这个改一下。', file: 'R1', oldRe: /最后一章/, newRe: /(第一章(前|之前)|开头|最前|篇首|前面)/ },
  ] },
];

const HTML = {
  'index.html': `<!doctype html><html><head><meta charset="utf-8"><title>数据科学</title></head><body>
<h1>数据科学</h1>
<p>这是一门由浅入深的数据科学课，共 6 篇 24 章。</p>
<ol>
<li><a href="ch01-intro.html">第1章 什么是数据</a> 简介：数据是对世界的记录，我们从一个勇士爬塔的故事讲起，再慢慢认识数据的种类、来源和用途。</li>
<li><a href="ch02-pipeline.html">第2章 数据的旅程</a> 简介：数据从产生到被使用，要经过采集、清洗、存储、分析几个环节，每个环节都可能出问题。</li>
</ol>
<p>第一篇最后一章：本篇回顾（待写）。</p>
</body></html>
`,
  'ch01-intro.html': `<!doctype html><html><head><meta charset="utf-8"><title>第1章 什么是数据</title></head><body>
<h1>第1章 什么是数据</h1>
<section id="story"><h2>开场故事</h2>
<p>很久以前，有一位勇士要爬一座很高的塔。塔有一百层，每一层都藏着一个谜题，答不上来就不能上楼。勇士带着一本旧笔记本，上面记着他每次失败的原因。后来他发现，只要翻翻笔记本里写过的东西，就能避开重复的错误，这本笔记本就是他最早的数据。</p>
<p>他从笔记里看出，夜里的谜题总是比白天难，于是他改成白天赶路。</p></section>
<section id="examples"><h2>例子</h2>
<ul><li>例子一：温度计每小时记下的温度，是数据。</li>
<li>例子二：商店的销售小票，是数据。</li>
<li>例子三：地图上的路线，是数据。</li>
<li>反例：一个人心里的想法，没有被记录下来，不是数据。</li></ul></section>
<section id="exercises"><h2>练习题</h2>
<ol><li>题目：下面哪一个是数据？A 昨天的气温记录　B 一个突然冒出来的念头。<p>解析：A 被记录下来了。</p></li>
<li>题目：举一个生活中的数据例子。<p>解析：任何被记录的事实都可以。</p></li>
<li>题目：为什么说笔记本是勇士的数据？<p>解析：因为它记录了过去的事实。</p></li></ol></section>
</body></html>
`,
  'ch02-pipeline.html': `<!doctype html><html><head><meta charset="utf-8"><title>第2章 数据的旅程</title></head><body>
<h1>第2章 数据的旅程</h1>
<section id="s1"><h2>数据怎么来的</h2>
<p>上一章的勇士还有一个问题没解决：笔记本里的记录从哪里来？这一节我们看数据是怎样被采集的。</p></section>
<section id="s2"><h2>采集之后</h2>
<p>采集来的数据往往带着错误，需要清洗之后才能使用。</p></section>
</body></html>
`,
};

// ---------- 搭模板 ----------
// 手写复制：Windows 上 fs.cpSync 复制 .claude 目录会报 EIO
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}
function buildTemplate() {
  const tpl = path.join(WORK, 'template');
  fs.rmSync(tpl, { recursive: true, force: true });
  fs.mkdirSync(path.join(tpl, 'DataScience'), { recursive: true });
  copyDir(path.join(ROOT, 'example', '.claude'), path.join(tpl, '.claude'));
  for (const [n, t] of Object.entries(HTML)) fs.writeFileSync(path.join(tpl, 'DataScience', n), t);
  const r = spawnSync('node', [path.join(ROOT, 'bin', 'ruletree.js'), 'init', tpl], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('init 失败：' + r.stderr);
  const g = c => spawnSync('git', c, { cwd: tpl, encoding: 'utf8' });
  g(['init', '-q']); g(['add', '-A']);
  g(['-c', 'user.name=eval', '-c', 'user.email=e@e', 'commit', '-qm', 'base']);
  return tpl;
}

// ---------- 读状态 ----------
// 规则文件 → { 文件名: { id, rules:[text], raw } }
function readRules(dir) {
  const out = {};
  for (const [name, text] of store.readFiles(dir)) {
    const n = T.parseFile(name, text);
    out[name] = { id: n.root ? 'P' : n.id, rules: n.rules.map(r => r.text), raw: text };
  }
  return out;
}
function diffRules(before, after) {
  const files = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out = [];
  for (const f of files) {
    const b = before[f], a = after[f];
    if (b && a && b.raw === a.raw) continue;
    const bs = b ? b.rules : [], as = a ? a.rules : [];
    out.push({
      file: f, id: (a || b).id, created: !b, deleted: !a,
      added: as.filter(x => !bs.includes(x)), removed: bs.filter(x => !as.includes(x)),
      nonRuleChange: !!(b && a) && b.rules.join('\n') === a.rules.join('\n'), // 规则没变、别的行变了（标题/范围/状态）
      countBefore: bs.length, countAfter: as.length,
    });
  }
  return out;
}
const checkNotes = dir => {
  const r = spawnSync('node', [path.join(ROOT, 'bin', 'ruletree.js'), 'check', dir], { encoding: 'utf8' });
  return r.stdout.split('\n').filter(l => l.startsWith('- '));
};

// ---------- 判定 ----------
function judge(sc, c, d, reply, checkNew) {
  const why = [];
  let verdict = 'ok';
  const bad = (m) => { verdict = 'wrong'; why.push(m); };
  let said = (reply.match(/已记到\s*[`「"*]*([A-Za-z_]+[\d.]*)/) || [])[1] || null;
  if (said) said = said.replace(/\.$/, ''); // 「_root.md」会被抓成「_root.」
  if (sc.kind === 'none') {
    if (d.length) bad(`不该改规则文件，却改了 ${d.map(x => x.id + (x.added.length ? ' +' + x.added.length : '') + (x.removed.length ? ' -' + x.removed.length : '')).join('、')}：${d.flatMap(x => x.added).join(' | ')}`);
    if (said) bad(`回复里说了「已记到 ${said}」`);
  } else if (sc.kind === 'record') {
    const touched = d.filter(x => !x.nonRuleChange || x.added.length);
    const ids = touched.map(x => x.id);
    if (!d.length) bad('一条都没记');
    else if (d.length > 1) bad(`改了 ${d.length} 个规则文件：${ids.join('、')}`);
    else {
      const x = d[0];
      if (x.created) bad(`新建了规则文件 ${x.file}`);
      else if (x.deleted) bad('删了规则文件');
      else if (!c.files.includes(x.id)) { if ((c.soft || []).includes(x.id)) { verdict = 'soft'; why.push(`记到了上级 ${x.id}（期望 ${c.files.join('/')}）`); } else bad(`记错地方：${x.id}（期望 ${c.files.join('/')}）`); }
      if (verdict !== 'wrong') {
        if (x.removed.length) bad(`删了/改了原有规则：${x.removed.join(' | ')}`);
        else if (x.added.length < 1) bad('没有新增规则条');
        else if (x.added.length > 2) bad(`一次加了 ${x.added.length} 条，不是一句话`);
        if (sc.decision && !x.added.some(t => /^决定[：:]/.test(t))) bad('没以「决定：」开头：' + x.added.join(' | '));
        if (c.reason && !x.added.some(t => c.reason.test(t))) bad('没带上理由：' + x.added.join(' | '));
      }
      if (!said) { if (verdict === 'ok') verdict = 'soft'; why.push('回复里没说「已记到 Rx」'); }
      else if (!d.length || said.replace(/^_?root$/i, 'P') !== x.id) { if (verdict === 'ok') verdict = 'soft'; why.push(`回复说已记到 ${said}，实际在 ${x.id}`); }
    }
  } else if (sc.kind === 'revise') {
    const x = d.find(y => y.id === c.file);
    if (!d.length) bad('一条都没改');
    else if (d.length > 1 || !x) bad(`改的文件不对：${d.map(y => y.id).join('、')}（期望 ${c.file}）`);
    else {
      if (x.added.length !== 1 || x.removed.length !== 1) bad(`不是「一条换一条」：+${x.added.length} -${x.removed.length}（加：${x.added.join(' | ')}；删：${x.removed.join(' | ')}）`);
      else if (x.countAfter !== x.countBefore) bad('规则条数变了');
      if (verdict !== 'wrong') {
        if (!c.oldRe.test(x.removed[0])) bad('删掉的不是原来那条：' + x.removed[0]);
        if (!c.newRe.test(x.added[0])) bad('新写的没有新说法：' + x.added[0]);
      }
      if (verdict === 'ok' && !said) { verdict = 'soft'; why.push('回复里没说「已记到 Rx」'); }
    }
  }
  if (checkNew.length) { why.push(`check 新增问题：${checkNew.join('；')}`); if (verdict === 'ok') verdict = 'soft'; }
  return { verdict, why, said };
}

// ---------- 运行 ----------
function runOne(tpl, sc, i) {
  const c = sc.cases[i];
  const dir = path.join(WORK, `${sc.id}${i + 1}`);
  fs.rmSync(dir, { recursive: true, force: true });
  copyDir(tpl, dir);
  const before = readRules(dir);
  const notesBefore = checkNotes(dir);
  const guideBefore = fs.readFileSync(store.rulesDir(dir) + '/_guide.md', 'utf8');
  // 话从标准输入给：Windows 下经 shell 传带空格的参数会被截断
  const args = ['-p', '--model', MODEL, '--output-format', 'json', '--permission-mode', 'auto',
    '--tools', 'Read,Edit,Write,Glob,Grep',
    '--allowedTools', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Edit(.claude/rules/ruletree/**)', 'Write(.claude/rules/ruletree/**)', '--setting-sources', 'project,local', '--disable-slash-commands',
    '--no-session-persistence', '--max-budget-usd', PER_RUN_CAP];
  const t0 = Date.now();
  const r = spawnSync('claude', args, { cwd: dir, input: c.prompt, encoding: 'utf8', timeout: 600000, shell: process.platform === 'win32', env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } });
  const secs = Math.round((Date.now() - t0) / 1000);
  let j = null;
  try { j = JSON.parse(r.stdout); } catch {}
  // hook 是后台跑的，稍等它写完 changes.jsonl
  spawnSync('node', ['-e', 'setTimeout(()=>{},3000)']);
  const after = readRules(dir);
  const d = diffRules(before, after);
  const notesAfter = checkNotes(dir);
  const checkNew = notesAfter.filter(n => !notesBefore.includes(n));
  const reply = j && typeof j.result === 'string' ? j.result : '';
  const res = judge(sc, c, d, reply, checkNew);
  const changes = store.readChanges(dir, 50);
  const aiChanges = changes.filter(e => e.source === 'AI' || e.by === 'AI');
  const touchedContent = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout.split('\n').filter(l => l && !/\.claude\/rules\/ruletree|\.ruletree|\.gitignore/.test(l));
  const extra = [];
  if (fs.readFileSync(store.rulesDir(dir) + '/_guide.md', 'utf8') !== guideBefore) extra.push('说明书被改了');
  if (fs.existsSync(path.join(dir, 'CLAUDE.md'))) extra.push('新建了 CLAUDE.md');
  if (c.edits && !touchedContent.some(l => /DataScience/.test(l))) extra.push('没有改内容页（任务没做）');
  return {
    id: `${sc.id}${i + 1}`, scenario: sc.name, prompt: c.prompt, verdict: res.verdict, why: res.why, said: res.said,
    diff: d.map(x => ({ id: x.id, file: x.file, added: x.added, removed: x.removed, created: x.created, deleted: x.deleted })),
    cost: j ? j.total_cost_usd : null, turns: j ? j.num_turns : null, secs, isError: j ? j.is_error : true,
    reply: reply.slice(0, 2000), aiChangeRecords: aiChanges.length, changeSources: [...new Set(changes.map(e => e.source))],
    checkNew, extra, contentFiles: touchedContent, stderr: r.status ? (r.stderr || '').slice(0, 300) : '',
  };
}

function main() {
  fs.mkdirSync(WORK, { recursive: true });
  const tpl = buildTemplate();
  const baseNotes = checkNotes(tpl);
  console.log(`模板：${tpl}；基线 check：${baseNotes.length ? baseNotes.join('；') : '无问题'}`);
  const results = [];
  let spent = 0;
  const outFile = path.join(WORK, 'results.jsonl');
  for (const sc of SCENARIOS) for (let i = 0; i < Math.min(RUNS, sc.cases.length); i++) {
    if (ONLY && !ONLY.includes(`${sc.id}${i + 1}`) && !ONLY.includes(sc.id)) continue;
    if (spent >= BUDGET) { console.log(`累计 $${spent.toFixed(2)} 已达预算，停止`); return finish(results, spent); }
    const r = runOne(tpl, sc, i);
    spent += r.cost || 0;
    results.push(r);
    fs.appendFileSync(outFile, JSON.stringify(r) + '\n');
    console.log(`${r.id} ${r.verdict}  $${(r.cost || 0).toFixed(3)} ${r.secs}s  ${r.why.join('；')}`);
  }
  finish(results, spent);
}
function finish(results, spent) {
  const by = {};
  for (const r of results) { const k = r.id[0]; (by[k] = by[k] || { ok: 0, soft: 0, wrong: 0 })[r.verdict]++; }
  console.log('\n场景  对  半对  错', JSON.stringify(by));
  console.log(`总花费 $${spent.toFixed(3)}`);
}

if (require.main === module) main();
module.exports = { SCENARIOS, diffRules, judge };
