'use strict';
// 信息架构实测（真实模型，花钱）：照用户装上新版、第一次点「体检」的流程走——先自动重新整理（Sonnet），再体检（Haiku），
// 每遍都在项目的副本上做（只复制文本文件和 .reqtree，不复制 .git），真实项目不动。记下：
//   硬标准：规则一条不丢、原文不改；「决定：」一条不少
//   信息架构评分（src/health.js）：整理前、整理后、体检后
//   埋的错找没找到：规则里提到不存在的类名（该删）、两份文档说法矛盾（按后改的改先改的）、能写成检查的规则（该生成检查）
//   用时、调用模型几次、出错几次、直接处理几项、问了几个问题
// 用法：node test/eval-ia.js <项目目录> <输出目录> [遍数=3] [--lang gd|js]
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const [src, out, repsArg] = process.argv.slice(2);
if (require.main === module && (!src || !out)) { console.error('用法：node test/eval-ia.js <项目目录> <输出目录> [遍数=3] [--lang gd|js]'); process.exit(1); }
const REPS = Number(repsArg) || 3;
const LANG = (process.argv.find((a, i) => process.argv[i - 1] === '--lang')) || 'gd';
if (require.main === module) fs.mkdirSync(out, { recursive: true });

// 脚本也要（2026-10-25 没复制 .ps1，副本上「用 tools/release_windows.ps1 打包」被当成文件找不到删掉了）
const TEXT = /\.(md|html?|js|mjs|cjs|ts|css|json|txt|py|gd|gdshader|tscn|tres|godot|cfg|svg|csv|ya?ml|toml|sh|ps1|bat|cmd|cs)$/i;
const SKIP = /^(node_modules|\.git|\.godot|\.import|dist|build|\.venv|__pycache__)$/;
function copyProject(from, to) {
  let n = 0;
  (function walk(rel) {
    let ents = [];
    try { ents = fs.readdirSync(path.join(from, rel), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) { if (!SKIP.test(e.name) && !(rel === '' && e.name === '.claude')) walk(r); continue; }
      if (!TEXT.test(e.name) && !rel.startsWith('.reqtree')) continue;
      const st = fs.statSync(path.join(from, r));
      if (st.size > 3e6) continue;
      fs.mkdirSync(path.dirname(path.join(to, r)), { recursive: true });
      fs.copyFileSync(path.join(from, r), path.join(to, r));
      fs.utimesSync(path.join(to, r), st.atime, st.mtime);
      n++;
    }
  })('');
  // 编译目标：Claude（副本里没有 hook 设置，建一个空的规则文件夹让 compile 认得）
  fs.mkdirSync(path.join(to, '.claude', 'rules', 'reqtree'), { recursive: true });
  // 自动记忆不查（这次测的是结构和规则），记忆文件夹指到空的
  fs.writeFileSync(path.join(to, '.claude', 'settings.local.json'), JSON.stringify({ autoMemoryDirectory: path.join(to, '..', path.basename(to) + '-mem') }));
  // 上次体检 / 自动整理的标记不要：这是「第一次用新版」
  for (const f of ['reorganized.json', 'checks.json']) fs.rmSync(path.join(to, '.reqtree', f), { force: true });
  return n;
}

// 埋错：不存在的类名、两份说法矛盾的文档（a 是三天前改的，b 刚改）、一条能写成检查的规则
const SEED = {
  gd: { stale: '改天气只调 `WeatherDirectorX.apply_preset`', check: 'GDScript 里不留 print() 调试输出', checkRe: /print/ },
  js: { stale: '弹窗统一用 `ModalKitX.open`', check: 'JS 里不留 console.log 调试输出', checkRe: /console/ },
}[LANG];
function seed(dir, tree) {
  const { parse } = require(ROOT + '/src/parser');
  let text = fs.readFileSync(tree, 'utf8');
  // 挂到文档最少的两个需求上（每个需求最多挂 4 份，挂满的会被挤掉，测的就不是体检了）
  const top = parse(text).children[0].children.filter(n => n.files.length).sort((a, b) => a.docs.length - b.docs.length);
  const [n1, n2] = top;
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs/seed-a.md'), '# 练习的规范\n\n- 每个练习最多 3 道小题\n- 题目先给例子\n');
  fs.writeFileSync(path.join(dir, 'docs/seed-b.md'), '# 小题的写法\n\n- 每个练习最多 5 道小题\n- 选项不超过 4 个\n');
  const old = Date.now() / 1000 - 3 * 86400;
  fs.utimesSync(path.join(dir, 'docs/seed-a.md'), old, old);
  const lines = text.split('\n');
  const after = n => lines.findIndex(l => new RegExp(`^#+ ${n.id.replace(/\./g, '\\.')} `).test(l));
  // 从后往前插，前面的行号不变
  for (const [n, doc, rule] of [[n2, 'docs/seed-b.md', null], [n1, 'docs/seed-a.md', SEED.stale]].sort((a, b) => after(b[0]) - after(a[0]))) {
    const at = after(n) + 1;
    lines.splice(at, 0, `> 文档：${doc}`, ...(rule ? [`- ${rule}`] : []));
  }
  text = lines.join('\n');
  // 能写成检查的规则放在根上（看整理会不会把它挪到代码那一类）
  text = text.replace(/^(# .*\n(?:[^#\n-].*\n)*)/, `$1- ${SEED.check}\n`);
  fs.writeFileSync(tree, text);
  return { n1: n1.id, n2: n2.id };
}

const rulesOf = text => require(ROOT + '/src/init').existingRules(text).map(r => r.text).sort();
function health(tree) {
  const store = require(ROOT + '/src/store');
  store.compileTree(tree, { force: true });
  try { require(ROOT + '/src/codemap').refresh(tree); } catch {}
  const C = require(ROOT + '/src/codemap');
  return require(ROOT + '/src/health').measure(tree, { graph: C.build(path.dirname(tree)) });
}
const brief = h => ({ score: h.score, parts: h.parts, nodes: h.structure.nodes, depth: h.structure.depth, rules: h.structure.rules, root: h.structure.rootRules,
  big: h.structure.big.length, never: h.structure.neverLoaded.rules, rulesPerFile: h.load.rules.avg, rulesMax: h.load.rules.max, chars: Math.round(h.load.chars.avg), charsP90: h.load.chars.p90,
  overlap: h.overlap.share, misplaced: h.code ? h.code.misplaced.length : null });

async function one(base, i) {
  const dir = path.join(out, `run-${i}`);
  fs.rmSync(dir, { recursive: true, force: true });
  // fs.cpSync 在这台 Windows 上整个目录复制会报 EIO：逐个文件复制
  (function copy(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      if (e.isDirectory()) copy(path.join(from, e.name), path.join(to, e.name));
      else { fs.copyFileSync(path.join(from, e.name), path.join(to, e.name)); const st = fs.statSync(path.join(from, e.name)); fs.utimesSync(path.join(to, e.name), st.atime, st.mtime); }
    }
  })(base, dir);
  const tree = path.join(dir, '需求树.md');
  seed(dir, tree);
  const before = fs.readFileSync(tree, 'utf8');
  const row = { run: i };
  row.before = brief(health(tree));
  // 1. 自动重新整理（体检开头会做的那一步，单独做是为了分开计时、分开算分）
  const Init = require(ROOT + '/src/init');
  let t0 = Date.now();
  const r = await Init.reorganize(tree, { auto: true });
  row.reorganize = { ok: !!r.ai, seconds: Math.round((Date.now() - t0) / 1000), nodes: r.ai ? undefined : null, lostDocs: r.lostDocs || [], error: r.error ? r.error.message : null };
  const mid = fs.readFileSync(tree, 'utf8');
  const a = rulesOf(before), b = rulesOf(mid);
  row.hard = {
    rulesBefore: a.length, rulesAfter: b.length,
    lost: (() => { const left = new Map(); for (const x of b) left.set(x, (left.get(x) || 0) + 1); return a.filter(x => { const k = left.get(x) || 0; if (k) left.set(x, k - 1); return !k; }).slice(0, 10); })(),
    decisionsKept: a.filter(x => x.startsWith('决定：')).every(x => b.includes(x)),
    seedDocsLinked: ['docs/seed-a.md', 'docs/seed-b.md'].map(d => mid.includes(d)),
    checkRuleAt: (() => { const { parse, walk } = require(ROOT + '/src/parser'); const n = [...walk(parse(mid))].find(x => x.rules.some(y => y.text === SEED.check)); return n ? `${n.id} ${n.title} ${n.files.join(',')}` : null; })(),
  };
  row.reorganized = brief(health(tree));
  fs.writeFileSync(path.join(out, `tree-${i}.md`), mid);
  // 2. 体检（规则 + 文档；记忆不查）
  t0 = Date.now();
  const { runCheckup } = require(ROOT + '/src/checkup');
  const c = await runCheckup(tree, { memory: false, parts: { rules: true, docs: true, memory: false } });
  row.checkup = {
    seconds: Math.round((Date.now() - t0) / 1000), calls: c.checked.calls, failed: c.checked.failed, error: c.error ? c.error.message : null,
    reorganizedAgain: !!c.reorganized, auto: c.auto.length, merged: c.merged.length, asked: [...c.questions, ...c.stale, ...c.memory, ...c.scope, ...c.structure, ...c.docs].length,
    checksSaved: c.checks ? c.checks.saved.map(x => `${x.node}「${x.rule}」${x.glob} /${x.forbid}/`) : [], checksDropped: c.checks ? c.checks.dropped.map(d => d.reason) : [],
    docClash: c.docClash.length, autoSample: c.auto.slice(0, 40).map(x => x.text),
  };
  const end = fs.readFileSync(tree, 'utf8');
  row.seeds = {
    staleRemoved: !end.includes(SEED.stale),
    clashFixed: /最多 5 道小题/.test(fs.readFileSync(path.join(dir, 'docs/seed-a.md'), 'utf8')) && /最多 5 道小题/.test(fs.readFileSync(path.join(dir, 'docs/seed-b.md'), 'utf8')),
    checkMade: !!(c.checks && c.checks.saved.some(x => x.rule === SEED.check || SEED.checkRe.test(x.forbid))),
  };
  row.after = brief(health(tree));
  fs.writeFileSync(path.join(out, `final-${i}.md`), end);
  fs.writeFileSync(path.join(out, `run-${i}.json`), JSON.stringify(row, null, 1));
  console.log(JSON.stringify({ run: i, hard: row.hard, reorganize: row.reorganize, scores: [row.before.score, row.reorganized.score, row.after.score], seeds: row.seeds, checkup: { ...row.checkup, autoSample: undefined } }));
  return row;
}

module.exports = { copyProject };
if (require.main !== module) { /* 被别的实测脚本借用 copyProject */ } else if (process.argv.includes('--dry')) {
  // 只复制、埋错，看埋得对不对（不调用模型）
  const base = path.join(out, 'base');
  fs.rmSync(base, { recursive: true, force: true });
  console.log('复制', copyProject(src, base));
  const tree = path.join(base, '需求树.md');
  console.log(seed(base, tree));
  const { parse, walk } = require(ROOT + '/src/parser');
  for (const n of walk(parse(fs.readFileSync(tree, 'utf8')))) if (n.docs.some(d => d.includes('seed')) || n.rules.some(r => r.text === SEED.check || r.text === SEED.stale)) console.log(n.id, n.docs, n.rules.filter(r => r.text === SEED.check || r.text === SEED.stale).map(r => r.text));
  process.exit(0);
}
else (async () => {
  const base = path.join(out, 'base');
  fs.rmSync(base, { recursive: true, force: true });
  const n = copyProject(src, base);
  console.log(`复制了 ${n} 个文件到 ${base}`);
  const rows = await Promise.all(Array.from({ length: REPS }, (_, i) => one(base, i + 1).catch(e => ({ run: i + 1, error: e.stack }))));
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(rows, null, 1));
  console.log('完成', path.join(out, 'results.json'));
})();
