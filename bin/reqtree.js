#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parse, walk, findById, pathOf, effectiveRules, check, STATUS_EMOJI } = require('../src/parser');
const store = require('../src/store');
const { autoLoads } = require('../src/compile');
const { isStale, STALE_DAYS } = require('../src/viewmodel');

// 只跟踪编辑类工具，不跟踪 Bash：每次 hook 要启动一个 node（这台机器约 0.2 秒），而 AI 改文件绝大多数走 Edit/Write
const EDIT_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';

const ROOT = path.join(__dirname, '..');
const VERSION = require('../package.json').version;

// ---------- 运行时副本 ~/.reqtree/runtime ----------
// hook 命令不指向这个仓库或插件的安装目录：插件升级后目录名会变（shidipeng.reqtree-0.8.0 → 0.9.0），
// npx 的缓存目录也随时会被清掉。所以 init 把 hook 运行要用的 hooks/ 和 src/ 复制到固定位置，hook 命令指向那里。
// 每次 init（以及插件发现副本比自己旧时）整个覆盖，并写下版本号；副本比自己新（别的项目用新版装过）时不降级。
// 先复制 src 再复制 hooks：复制到一半时正在运行的 hook 是「新 src + 旧 hook」，旧 hook 用到的 src 接口不会消失
const RUNTIME_PARTS = ['src', 'hooks'];
const reqtreeHome = () => process.env.REQTREE_HOME || path.join(os.homedir(), '.reqtree');
const runtimeDir = () => path.join(reqtreeHome(), 'runtime');

// 把 from 目录同步到 to：逐个文件先写临时文件再改名（正在运行的 hook 读到的要么旧要么新），删掉 from 里已经没有的文件
function syncDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  const names = new Set(fs.readdirSync(from));
  for (const name of fs.readdirSync(to)) {
    if (!names.has(name) && !name.endsWith('.tmp')) fs.rmSync(path.join(to, name), { recursive: true, force: true });
  }
  for (const name of names) {
    const src = path.join(from, name), dst = path.join(to, name);
    if (fs.statSync(src).isDirectory()) { syncDir(src, dst); continue; }
    const tmp = `${dst}.${process.pid}.tmp`;
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dst);
  }
}

function installRuntime() {
  const dir = runtimeDir();
  for (const part of RUNTIME_PARTS) syncDir(path.join(ROOT, part), path.join(dir, part));
  fs.writeFileSync(path.join(dir, 'version'), VERSION + '\n');
  return dir;
}

// 副本的版本号；从没装过返回 null
function runtimeVersion() {
  try { return fs.readFileSync(path.join(runtimeDir(), 'version'), 'utf8').trim(); } catch { return null; }
}

// a 是否比 b 旧（只比数字部分：0.8.0 < 0.10.0）
function isOlder(a, b) {
  const pa = String(a).split(/[.-]/).map(n => parseInt(n, 10) || 0), pb = String(b).split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  return false;
}

// 插件启动时调用：装过副本、但比当前版本旧，就悄悄换成新的。没装过不创建（那是 init 的事）
function refreshRuntimeIfOlder() {
  const v = runtimeVersion();
  if (!v || !isOlder(v, VERSION)) return false;
  installRuntime();
  return true;
}

// ---------- Claude Code 的 hook ----------

// hook 命令。Claude Code 用 shell 执行它：posix 用单引号（路径里的 $、反引号、空格都原样保留，单引号写成 '\''）；
// Windows 的路径里不会有双引号，用双引号、正斜杠
function hookCommand(file, platform = process.platform) {
  if (platform === 'win32') return `node "${file.replace(/\\/g, '/')}"`;
  return `node '${file.replace(/'/g, `'\\''`)}'`;
}

// 认自己装的 hook：命令里有 hooks/hook.js，路径里有 reqtree（含 ~/.reqtree/runtime、改过名的 reqtree-0.7.0）
// 或 Vibe-Friend / Vibecoding-Friend（git clone 下来的仓库名，仓库改过名）。不要求两者紧挨着；用户自己别的 hook.js 不算
const isOurs = h => { const c = String((h && h.command) || '').replace(/\\/g, '/'); return /hooks\/+hook\.js/.test(c) && /reqtree|vibe(coding)?-friend/i.test(c); };

// 读 Claude Code 的 settings（解析不了就抛错，绝不当成空对象写回去）
const { readSettings } = require('../src/memory');

// hook 命令里的脚本路径（引号里的那段）
const scriptOf = h => { const m = String((h && h.command) || '').match(/"([^"]+)"|'([^']+)'/); return m ? (m[1] || m[2]) : null; };

// 项目的 .claude/settings.json 或 settings.local.json 里有没有能用的需求树 hook：命令是我们的，而且脚本文件还在
// （指向已经删掉的旧位置的算没装，插件会提示重新启用）
function hasHooks(dir) {
  const usable = h => { if (!isOurs(h)) return false; const p = scriptOf(h); return !!p && fs.existsSync(p); };
  return ['settings.json', 'settings.local.json'].some(f => {
    let s = null;
    try { s = readSettings(path.join(dir, '.claude', f), null); } catch {}
    return !!(s && s.hooks && typeof s.hooks === 'object' && Object.values(s.hooks).some(groups =>
      Array.isArray(groups) && groups.some(g => g && Array.isArray(g.hooks) && g.hooks.some(usable))));
  });
}

// 写 Claude Code 的 hook。先删掉旧的需求树 hook 再按当前版本写入
// （旧版本 --track-bash 写的 "…|Bash" matcher 也随之换成 EDIT_MATCHER）
function installClaude(dir, { runtime, log }) {
  const command = hookCommand(path.join(runtime, 'hooks', 'hook.js'));
  const settingsPath = path.join(dir, '.claude', 'settings.local.json');
  const settings = readSettings(settingsPath, {});
  settings.hooks = settings.hooks || {};
  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = settings.hooks[event]
      .map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !isOurs(h)) }))
      .filter(g => g.hooks.length);
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  // 记录活动和启动记录员都放后台（async），不让 AI 等；UserPromptSubmit 要在 AI 开工前把规则编译好，所以同步。
  // PreCompact：上下文压缩前把最近的原话交给记录员补漏（见 hooks/hook.js takeSweep）。
  // InstructionsLoaded（Claude Code 2.1.69 起）：加载 CLAUDE.md、.claude/rules 时触发，记给上下文用量表；不设 matcher，所有加载原因都记
  const events = [['UserPromptSubmit', null, false], ['Stop', null, true], ['PostToolUse', EDIT_MATCHER, true], ['InstructionsLoaded', null, true], ['PreCompact', null, true]];
  for (const [event, matcher, async] of events) {
    const group = { hooks: [{ type: 'command', command, ...(async ? { async: true } : {}) }] };
    if (matcher) group.matcher = matcher;
    (settings.hooks[event] = settings.hooks[event] || []).push(group);
  }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  log(`✓ hook 已写入 ${settingsPath}`);
}

function installCodex(dir, { runtime, log }) {
  const r = require('../src/targets/codex-install').installCodex(dir, { runtimeDir: runtime });
  log(`✓ Codex hook 已写入 ${r.hooksPath}`);
  log(`✓ 规则索引已写入 ${r.agentsPath}`);
  r.warnings.forEach(w => log('提醒：' + w));
}

// 每种 AI 工具怎么装：(dir, { runtime, log }) => void
const TOOLS = { claude: installClaude, codex: installCodex };
// 装完还要用户做什么
const NEXT_STEP = {
  claude: '新开 Claude Code 会话后生效。',
  codex: '还差一步：在项目里运行 codex，输入 /hooks，信任 5 个「需求树」hook（不信任也能用：规则索引写在 AGENTS.md 里）。',
};

// 在项目里启用需求树：复制运行时副本、按工具装 hook、忽略 .reqtree/、没有树文件就建一个模板、编译规则。
// 重复运行无副作用。命令行和插件共用（插件传 log 收集输出）；出错抛异常，不退出进程
function init(dir, { tool = 'claude', log = console.log } = {}) {
  const install = TOOLS[tool];
  if (!install) throw new Error(`不认识的 --tool：${tool}（可选：${Object.keys(TOOLS).join('、')}）`);
  dir = path.resolve(dir);
  if (!fs.statSync(dir).isDirectory()) throw new Error(`不是文件夹：${dir}`);
  const have = runtimeVersion();
  let runtime;
  if (have && isOlder(VERSION, have)) {
    runtime = runtimeDir();
    log(`✓ ${runtime} 里已经是更新的版本 ${have}（这次是 ${VERSION}），不覆盖`);
  } else {
    runtime = installRuntime();
    log(`✓ hook 程序已复制到 ${runtime}（版本 ${VERSION}）`);
  }
  install(dir, { runtime, log });

  const gi = path.join(dir, '.gitignore');
  let text = '';
  try { text = fs.readFileSync(gi, 'utf8'); } catch {}
  if (!/^\.reqtree\/?$/m.test(text)) {
    fs.writeFileSync(gi, text + (text && !text.endsWith('\n') ? '\n' : '') + '.reqtree/\n');
    log('✓ .gitignore 已忽略 .reqtree/');
  }

  if (!store.findTree(dir)) {
    fs.writeFileSync(path.join(dir, '需求树.md'), store.initialTree(dir));
    log('✓ 已按项目的文件夹创建 需求树.md');
  }
  const tree = store.findTree(dir);
  store.ensureTracking(tree);
  const r = compileOrThrow(tree);
  log(r.written.length ? `✓ 已编译 ${r.written.length} 个规则文件到 ${path.relative(dir, r.dir)}` : `✓ 规则文件已是最新（${path.relative(dir, r.dir)}）`);
  log('完成。' + NEXT_STEP[tool]);
  return { tree, runtime };
}

// 编译出错时 store 只把错误记进 state.json（给面板看）；这里要直接报出来
function compileOrThrow(tree) {
  const r = store.compileTree(tree, { force: true });
  if (!r) throw new Error(`编译失败：${(store.readCompileStatus(tree) || {}).message || '未知错误'}`);
  return r;
}
function compileOrExit(tree) {
  try { return compileOrThrow(tree); } catch (e) { console.error(e.message); process.exit(1); }
}

// init 的参数：[目录] [--tool 名字 | --tool=名字]；别的 -- 选项（如旧的 --track-bash）忽略
function parseInitArgs(args) {
  let dir = null, tool = 'claude', ai = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--no-ai') ai = false;
    else if (a === '--tool') tool = args[++i];
    else if (a.startsWith('--tool=')) tool = a.slice(7);
    else if (!a.startsWith('--') && dir == null) dir = a;
  }
  return { dir: dir || process.cwd(), tool, ai };
}

const USAGE = `用法：
  reqtree init  [目录] [--tool claude|codex] [--no-ai] 在项目里装好 hook 和忽略规则（默认当前目录），用 AI 按要做的事生成需求树（--no-ai 只按文件夹分）
  reqtree disable [目录]        在项目里停用：去掉 hook 和编译出的规则（需求树.md 留着）
  reqtree tree  <文件>          打印整棵树
  reqtree rules <文件> <ID>     打印某个节点实际生效的规则（含继承与覆盖）
  reqtree check <文件>          检查重复 ID、重复规则键、重复规则、很久没动的 🔨（只读）
  reqtree check <文件> --fix    体检：合并重复规则，冲突、该提到上级的有把握就直接改，拿不准的不动，只有要改掉「决定：」才问你（都能撤销）
                                （要调用模型；加 --no-model 不调用）；也按分工整理 Claude Code 自动记忆（--no-memory 不查）；还查挂的文档和 CLAUDE.md、AGENTS.md：
                                和树重复的从文档里删掉、该进树的搬进树（只查上次之后改过的，--full 全部重查）
  reqtree map   <文件>          重建代码地图（每个需求这块已有的代码、依赖的公共模块）
  reqtree who   <文件> <名字>   某个函数、类、信号在哪定义、谁在用（也可以是文件路径：被谁用）
  reqtree questions <文件>      列出等你回答的问题
  reqtree answer <文件> <问题ID> <选项序号|dismiss>   回答问题（序号从 1 起；dismiss 保持现在的样子）
  reqtree compile <文件>        编译成 Claude Code 原生规则（.claude/rules/reqtree/）`;

// 命令行显示问题：编号 + 问题 + 选项（序号从 1 起，标出现在用的和建议的）
function printQuestion(q) {
  console.log(`${q.id}  ${q.text}`);
  q.options.forEach((o, i) => {
    const tag = i === q.default ? (q.defaultApplied ? '（现在是这样）' : '（建议）') : '';
    console.log(`  ${i + 1}. ${o.label}${tag}`);
  });
}

async function checkFix(file, { model, memoryOn = true, full = false }) {
  const { runCheckup } = require('../src/checkup');
  const r = await runCheckup(file, { model, memory: memoryOn ? undefined : false, full });
  if (r.checked && r.checked.calls) console.log(`看了 ${r.checked.notes} 份记忆、${r.checked.docs} 份文档（上次体检后没改过的跳过；--full 全部重查），调用模型 ${r.checked.calls} 次`);
  for (const o of r.merged) console.log(`合并重复规则：删掉 ${o.node} 的「${o.text}」（留后写的那条）`);
  for (const o of r.removed) console.log(`删掉记忆 ${o.file}：内容已经在需求树或 CLAUDE.md 里（备份在 .reqtree/memory-backup/，可以撤销）`);
  if (r.noFiles.length) console.log(`提醒：${r.noFiles.join('、')} 有规则，可它们和上级都没有对应的文件，这些规则不会自动加载给 AI`);
  if (r.categorized.length) console.log(`给 ${r.categorized.join('、')} 的规则分了组（只改面板上的显示）`);
  for (const m of r.missing) console.log(`提醒：${m.node} ${m.title} 标着进行中，可对应的文件（${m.globs.join(', ')}）一个也找不到`);
  for (const d of r.docMissing) console.log(`提醒：${d.node} 挂的文档 ${d.doc} 找不到`);
  for (const d of r.docUnlinked) console.log(`提醒：${d.doc} 在 ${d.node} 的文件夹里，却没挂上（在需求下写「> 文档：${d.doc}」）`);
  for (const a of r.auto || []) console.log(`直接处理：${a.text}${a.options ? ` → ${a.options[a.default].label}` : ''}（可以撤销）`);
  for (const d of r.docDup) console.log(`文档里和需求树重复、没法自动删的（表格里、带子项或找不准）：${d.doc}「${d.text}」（树里在 ${d.node}）`);
  for (const d of r.toDoc) console.log(`记忆 ${d.file} 像是 ${d.node} 的经验或进度，建议挪进${d.docs.length ? ` ${d.docs[0]}` : '它的文档'}`);
  const asked = [...r.stale, ...r.scope, ...r.structure, ...r.memory, ...r.questions, ...r.docs];
  for (const q of asked) printQuestion(q);
  if (r.error) console.error(`查冲突时调用模型出错：${r.error.message}`);
  console.log(`合并 ${r.merged.length} 条重复规则，${r.removed.length ? `删掉 ${r.removed.length} 份已在树里的记忆，` : ''}${(r.auto || []).length ? `直接处理 ${r.auto.length} 项，` : ''}新提出 ${asked.length} 个问题${asked.length ? '（在 VS Code 里回答，或者 reqtree answer <文件> <问题ID> <选项序号>）' : ''}`);
  return r.error ? 1 : 0;
}

if (require.main === module) {
  const [cmd, file, id] = process.argv.slice(2);
  if (cmd === 'disable') {
    const done = disable(file || process.cwd());
    console.log(done.length ? `已停用：改了 ${done.join('、')}；需求树.md 留着，重新启用运行 init` : '这个项目没有启用需求树');
    process.exit(0);
  }
  if (cmd === 'init') {
    const { dir, tool, ai } = parseInitArgs(process.argv.slice(3));
    try { init(dir, { tool }); } catch (e) { console.error(e.message); process.exit(1); }
    if (!ai) process.exit(0);
    // 和插件一样用 AI 初始化（src/init.js）：树还是模板或按文件夹生成的样子才做，失败就保持原样
    const tree = store.findTree(path.resolve(dir));
    if (!tree || !require('../src/init').templateShaped(fs.readFileSync(tree, 'utf8').replace(/\r\n/g, '\n'))) process.exit(0);
    console.log('正在用 AI 读项目、按要做的事生成需求（一两分钟；按 Ctrl+C 跳过，树保持按文件夹分的样子）…');
    require('../src/init').initProject(path.resolve(dir)).then(r => {
      if (r.ai) console.log(`✓ 已按要做的事生成 ${r.nodes.length} 个需求（不满意可以在面板「最近改动」里撤销）`);
      else if (!r.skipped) console.log(`AI 初始化没成功（${r.error ? r.error.message : '未知原因'}），需求树保持按文件夹分的样子；在 VS Code 里打开项目时插件会再试`);
      process.exit(0);
    }, e => { console.error(e.message); process.exit(0); });
    return;
  }
  if (!cmd || !file) { console.log(USAGE); process.exit(1); }
  const flags = process.argv.slice(4); // 文件之后的参数

  if (cmd === 'check' && flags.includes('--fix')) {
    checkFix(path.resolve(file), { model: !flags.includes('--no-model'), memoryOn: !flags.includes('--no-memory'), full: flags.includes('--full') })
      .then(code => process.exit(code), e => { console.error(e.message); process.exit(1); });
    return;
  }
  if (cmd === 'questions') {
    const Q = require('../src/questions');
    const open = Q.openQuestions(path.resolve(file));
    open.forEach(printQuestion);
    console.log(open.length ? `共 ${open.length} 个问题等你回答` : '没有等你回答的问题');
    process.exit(0);
  }
  if (cmd === 'answer') {
    const Q = require('../src/questions');
    const [qid, pick] = flags;
    const tree = path.resolve(file);
    const done = pick === 'dismiss' ? Promise.resolve({ ok: Q.dismissQuestion(tree, qid), reason: 'gone' })
      : Q.answerQuestion(tree, qid, Number(pick) - 1);
    done.then(r => {
      if (r.ok) { console.log('好了'); process.exit(0); }
      console.error(r.reason === 'bad' ? '没有这个选项' : '找不到这个问题，或者已经回答过、过期了');
      process.exit(1);
    }, e => { console.error(e.message); process.exit(1); });
    return;
  }

  if (cmd === 'map') {
    const r = require('../src/codemap').refresh(path.resolve(file));
    console.log(`代码地图：看了 ${r.files} 个文件，${r.nodes.length} 个需求有地图（${r.nodes.join('、') || '无'}），写了 ${r.written.length} 份，用时 ${r.ms} ms`);
    process.exit(0);
  }
  if (cmd === 'who') {
    if (!id) { console.log(USAGE); process.exit(1); }
    console.log(require('../src/codemap').who(path.dirname(path.resolve(file)), id));
    process.exit(0);
  }

  const root = parse(fs.readFileSync(file, 'utf8'));
  const label = n => `${n.id} ${n.title}${n.status ? ' ' + STATUS_EMOJI[n.status] : ''}`;

  if (cmd === 'tree') {
    const print = (node, indent) => {
      for (const c of node.children) {
        console.log(indent + label(c) + (c.rules.length ? `  (规则 ${c.rules.length})` : ''));
        print(c, indent + '  ');
      }
    };
    print(root, '');
  } else if (cmd === 'rules') {
    const node = id && findById(root, id);
    if (!node) { console.error(`找不到节点：${id}`); process.exit(1); }
    console.log(`# ${pathOf(node).map(label).join(' → ')}\n`);
    for (const r of effectiveRules(node)) {
      const from = r.owner === node ? '' : `（来自 ${r.owner.id}）`;
      const over = r.overrides ? `（覆盖 ${r.overrides.owner.id} 的同名规则）` : '';
      console.log(`- ${r.key ? `[${r.key}] ` : ''}${r.text}${from}${over}`);
    }
  } else if (cmd === 'compile') {
    const r = compileOrExit(path.resolve(file));
    console.log(`写入 ${r.written.length} 个，删除 ${r.removed.length} 个：${r.dir}`);
  } else if (cmd === 'check') {
    // 只读：不写配置和状态（也不迁移旧文件）、不编译
    const problems = check(root);
    for (const p of problems) console.log(`第 ${p.line + 1} 行：${p.msg}`);
    for (const n of walk(root)) if (n.rules.length && !autoLoads(n)) console.log(`提醒：${n.id} ${n.title} 有规则但没有文件对应（上级也没有），规则不会自动加载给 AI`);
    const { touched, since } = store.readState(path.resolve(file));
    for (const n of walk(root)) if (isStale(n, touched, since)) console.log(`提醒：${n.id} ${n.title} 标着 🔨，但 ${STALE_DAYS} 天内 AI 没改过它的文件，是做完了还是暂停了？`);
    for (const o of require('../src/checkup').duplicateOps(fs.readFileSync(file, 'utf8'))) console.log(`提醒：${o.node} 里「${o.text}」和后面的「${o.why}」是同一件事，运行 check --fix 只留后面那条`);
    console.log(problems.length ? `共 ${problems.length} 个问题` : '没有发现问题');
    process.exit(problems.length ? 1 : 0);
  } else {
    console.log(USAGE); process.exit(1);
  }
}

// 在项目里停用：去掉需求树的 hook（Claude 和 Codex）、删掉编译出的规则和代码地图。需求树.md 和 .reqtree/（改动记录、备份）留着，
// 以后再启用一切照旧。返回动了哪些地方
function disable(dir) {
  dir = path.resolve(dir);
  const done = [];
  for (const f of ['settings.local.json', 'settings.json']) {
    const p = path.join(dir, '.claude', f);
    const s = readSettings(p, null);
    if (!s || !s.hooks || typeof s.hooks !== 'object') continue;
    let changed = false;
    for (const ev of Object.keys(s.hooks)) {
      if (!Array.isArray(s.hooks[ev])) continue;
      const next = s.hooks[ev].map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !isOurs(h)) })).filter(g => g.hooks.length);
      if (JSON.stringify(next) !== JSON.stringify(s.hooks[ev])) changed = true;
      if (next.length) s.hooks[ev] = next; else delete s.hooks[ev];
    }
    if (!changed) continue;
    if (!Object.keys(s.hooks).length) delete s.hooks;
    fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
    done.push(`.claude/${f}`);
  }
  try { require('../src/targets/codex-install').uninstallCodex(dir); } catch {}
  const rules = path.join(dir, '.claude', 'rules', 'reqtree');
  try {
    for (const n of fs.readdirSync(rules)) {
      const p = path.join(rules, n);
      if (/reqtree:(generated|codemap)/.test(fs.readFileSync(p, 'utf8'))) fs.unlinkSync(p);
    }
    if (!fs.readdirSync(rules).length) fs.rmdirSync(rules);
    done.push('.claude/rules/reqtree/');
  } catch {}
  return done;
}

module.exports = {
  init, disable, TOOLS, VERSION, hookCommand, isOurs, hasHooks, readSettings, RUNTIME_PARTS,
  installRuntime, runtimeDir, runtimeVersion, refreshRuntimeIfOlder, isOlder, parseInitArgs,
};
