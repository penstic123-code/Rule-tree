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
// 每次 init（以及插件发现副本比自己旧时）整个覆盖，并写下版本号。
const RUNTIME_PARTS = ['hooks', 'src'];
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

// 项目的 .claude/settings.json 或 settings.local.json 里有没有需求树的 hook（哪怕指向旧位置）
function hasHooks(dir) {
  return ['settings.json', 'settings.local.json'].some(f => {
    const s = store.readJson(path.join(dir, '.claude', f), null);
    return !!(s && s.hooks && typeof s.hooks === 'object' && Object.values(s.hooks).some(groups =>
      Array.isArray(groups) && groups.some(g => g && Array.isArray(g.hooks) && g.hooks.some(isOurs))));
  });
}

// 写 Claude Code 的 hook。先删掉旧的需求树 hook 再按当前版本写入
// （旧版本 --track-bash 写的 "…|Bash" matcher 也随之换成 EDIT_MATCHER）
function installClaude(dir, { runtime, log }) {
  const command = hookCommand(path.join(runtime, 'hooks', 'hook.js'));
  const settingsPath = path.join(dir, '.claude', 'settings.local.json');
  const settings = store.readJson(settingsPath, {});
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
  codex: '还差一步：在项目里运行 codex，输入 /hooks，信任 4 个「需求树」hook（不信任也能用：规则索引写在 AGENTS.md 里）。',
};

// 在项目里启用需求树：复制运行时副本、按工具装 hook、忽略 .reqtree/、没有树文件就建一个模板、编译规则。
// 重复运行无副作用。命令行和插件共用（插件传 log 收集输出）；出错抛异常，不退出进程
function init(dir, { tool = 'claude', log = console.log } = {}) {
  const install = TOOLS[tool];
  if (!install) throw new Error(`不认识的 --tool：${tool}（可选：${Object.keys(TOOLS).join('、')}）`);
  dir = path.resolve(dir);
  if (!fs.statSync(dir).isDirectory()) throw new Error(`不是文件夹：${dir}`);
  const runtime = installRuntime();
  log(`✓ hook 程序已复制到 ${runtime}（版本 ${VERSION}）`);
  install(dir, { runtime, log });

  const gi = path.join(dir, '.gitignore');
  let text = '';
  try { text = fs.readFileSync(gi, 'utf8'); } catch {}
  if (!/^\.reqtree\/?$/m.test(text)) {
    fs.writeFileSync(gi, text + (text && !text.endsWith('\n') ? '\n' : '') + '.reqtree/\n');
    log('✓ .gitignore 已忽略 .reqtree/');
  }

  if (!store.findTree(dir)) {
    fs.writeFileSync(path.join(dir, '需求树.md'), store.TEMPLATE);
    log('✓ 已创建模板 需求树.md');
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
  let dir = null, tool = 'claude';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--tool') tool = args[++i];
    else if (a.startsWith('--tool=')) tool = a.slice(7);
    else if (!a.startsWith('--') && dir == null) dir = a;
  }
  return { dir: dir || process.cwd(), tool };
}

const USAGE = `用法：
  reqtree init  [目录] [--tool claude|codex] 在项目里装好 hook 和忽略规则（默认当前目录）
  reqtree tree  <文件>          打印整棵树
  reqtree rules <文件> <ID>     打印某个节点实际生效的规则（含继承与覆盖）
  reqtree check <文件>          检查重复 ID、重复规则键、很久没动的 🔨
  reqtree compile <文件>        编译成 Claude Code 原生规则（.claude/rules/reqtree/）`;

if (require.main === module) {
  const [cmd, file, id] = process.argv.slice(2);
  if (cmd === 'init') {
    const { dir, tool } = parseInitArgs(process.argv.slice(3));
    try { init(dir, { tool }); } catch (e) { console.error(e.message); process.exit(1); }
    process.exit(0);
  }
  if (!cmd || !file) { console.log(USAGE); process.exit(1); }

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
    console.log(problems.length ? `共 ${problems.length} 个问题` : '没有发现问题');
    process.exit(problems.length ? 1 : 0);
  } else {
    console.log(USAGE); process.exit(1);
  }
}

module.exports = {
  init, TOOLS, VERSION, hookCommand, isOurs, hasHooks,
  installRuntime, runtimeDir, runtimeVersion, refreshRuntimeIfOlder, isOlder, parseInitArgs,
};
