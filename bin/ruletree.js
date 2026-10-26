#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('../src/tree');
const store = require('../src/store');
const { ensureGuide } = require('../src/guide');
const { readSettings } = require('../src/memory');

// 只跟踪编辑类工具，不跟踪 Bash：每次 hook 要启动一个 node（约 0.2 秒），AI 改文件绝大多数走 Edit/Write
const EDIT_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';
const ROOT = path.join(__dirname, '..');
const VERSION = require('../package.json').version;

// ---------- 运行时副本 ~/.ruletree/runtime ----------
// hook 命令不指向插件的安装目录：插件升级后目录名会变，npx 的缓存也随时会被清掉。所以 init 把 hooks/ 和 src/ 复制到固定位置，hook 命令指向那里。
// 每次 init（以及插件发现副本比自己旧时）整个覆盖并写下版本号；副本比自己新时不降级。先复制 src 再复制 hooks：复制到一半时旧 hook 用到的 src 接口不会消失
const RUNTIME_PARTS = ['src', 'hooks'];
const home = () => process.env.RULETREE_HOME || path.join(os.homedir(), '.ruletree');
const runtimeDir = () => path.join(home(), 'runtime');

// 把 from 目录同步到 to：逐个文件先写临时文件再改名，删掉 from 里已经没有的文件
function syncDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  const names = new Set(fs.readdirSync(from));
  for (const name of fs.readdirSync(to)) if (!names.has(name) && !name.endsWith('.tmp')) fs.rmSync(path.join(to, name), { recursive: true, force: true });
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
function runtimeVersion() {
  try { return fs.readFileSync(path.join(runtimeDir(), 'version'), 'utf8').trim(); } catch { return null; }
}
// a 是否比 b 旧（只比数字部分：0.8.0 < 0.10.0）
function isOlder(a, b) {
  const pa = String(a).split(/[.-]/).map(n => parseInt(n, 10) || 0), pb = String(b).split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  return false;
}
// 插件启动时调用：装过副本、但比当前版本旧，就换成新的。没装过不创建（那是 init 的事）
function refreshRuntimeIfOlder() {
  const v = runtimeVersion();
  if (!v || !isOlder(v, VERSION)) return false;
  installRuntime();
  return true;
}

// ---------- Claude Code 的 hook ----------

// Claude Code 用 shell 执行 hook 命令：posix 用单引号（单引号写成 '\''）；Windows 用双引号、正斜杠
function hookCommand(file, platform = process.platform) {
  if (platform === 'win32') return `node "${file.replace(/\\/g, '/')}"`;
  return `node '${file.replace(/'/g, `'\\''`)}'`;
}
// 认自己装的 hook：命令里有 hooks/hook.js，路径里有 ruletree，或者旧版的 reqtree、Vibe-Friend（升级时一起换掉）。用户自己别的 hook.js 不算
const isOurs = h => { const c = String((h && h.command) || '').replace(/\\/g, '/'); return /hooks\/+hook\.js/.test(c) && /ruletree|reqtree|vibe(coding)?-friend/i.test(c); };
const isCurrent = h => isOurs(h) && /ruletree/i.test(String(h.command));
const scriptOf = h => { const m = String((h && h.command) || '').match(/"([^"]+)"|'([^']+)'/); return m ? (m[1] || m[2]) : null; };

function settingsHooks(dir, pred) {
  return ['settings.json', 'settings.local.json'].some(f => {
    let s = null;
    try { s = readSettings(path.join(dir, '.claude', f), null); } catch {}
    return !!(s && s.hooks && typeof s.hooks === 'object' && Object.values(s.hooks).some(groups =>
      Array.isArray(groups) && groups.some(g => g && Array.isArray(g.hooks) && g.hooks.some(pred))));
  });
}
// 装了能用的新版 hook（脚本文件还在）
const enabledIn = dir => settingsHooks(dir, h => { if (!isCurrent(h)) return false; const p = scriptOf(h); return !!p && fs.existsSync(p); });
// 还装着旧版（需求树 reqtree）的 hook：要升级
const hasOldHooks = dir => settingsHooks(dir, h => isOurs(h) && !isCurrent(h));

// 从一份 settings 里去掉我们的 hook（别的 hook 原样留着），返回有没有改
function stripOurs(s) {
  if (!s || !s.hooks || typeof s.hooks !== 'object') return false;
  let changed = false;
  for (const ev of Object.keys(s.hooks)) {
    if (!Array.isArray(s.hooks[ev])) continue;
    const next = s.hooks[ev].map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !isOurs(h)) })).filter(g => g.hooks.length);
    if (JSON.stringify(next) !== JSON.stringify(s.hooks[ev])) changed = true;
    if (next.length) s.hooks[ev] = next; else delete s.hooks[ev];
  }
  if (!Object.keys(s.hooks).length) delete s.hooks;
  return changed;
}

// 写 Claude Code 的 hook：先去掉旧的（共享的 settings.json 里的也去掉，不然每个事件触发两次），再写进 settings.local.json。
// 两个都在后台运行（async），不让 AI 等：PostToolUse 记 AI 改了哪个需求的文件、改规则文件时记一条改动；
// InstructionsLoaded（Claude Code 2.1.69 起）记上下文用量
function installClaude(dir, { runtime, log }) {
  const command = hookCommand(path.join(runtime, 'hooks', 'hook.js'));
  const shared = path.join(dir, '.claude', 'settings.json');
  const sh = readSettings(shared, null);
  if (stripOurs(sh)) { fs.writeFileSync(shared, JSON.stringify(sh, null, 2) + '\n'); log(`✓ 去掉了 ${shared} 里的需求树 hook`); }
  const settingsPath = path.join(dir, '.claude', 'settings.local.json');
  const settings = readSettings(settingsPath, {});
  stripOurs(settings);
  settings.hooks = settings.hooks || {};
  for (const [event, matcher] of [['PostToolUse', EDIT_MATCHER], ['InstructionsLoaded', null]]) {
    const group = { hooks: [{ type: 'command', command, async: true }] };
    if (matcher) group.matcher = matcher;
    (settings.hooks[event] = settings.hooks[event] || []).push(group);
  }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  log(`✓ hook 已写入 ${settingsPath}`);
}

// 在项目里启用：复制运行时副本、装 hook、忽略 .ruletree/；旧版的 需求树.md 拆成规则文件，没有就按文件夹建第一批需求；写说明书。
// 重复运行无副作用。命令行和插件共用（插件传 log 收集输出）；出错抛异常，不退出进程
function init(dir, { log = console.log } = {}) {
  dir = path.resolve(dir);
  if (!fs.statSync(dir).isDirectory()) throw new Error(`不是文件夹：${dir}`);
  const have = runtimeVersion();
  let runtime;
  if (have && isOlder(VERSION, have)) { runtime = runtimeDir(); log(`✓ ${runtime} 里已经是更新的版本 ${have}（这次是 ${VERSION}），不覆盖`); }
  else { runtime = installRuntime(); log(`✓ hook 程序已复制到 ${runtime}（版本 ${VERSION}）`); }
  installClaude(dir, { runtime, log });
  if (store.ensureGitignore(dir)) log('✓ .gitignore 已忽略 .ruletree/');
  const up = require('../src/migrate').upgrade(dir);
  if (up) log(`✓ 旧的 ${path.basename(up.legacy)} 已拆成 ${up.count} 个需求文件（原文件挪到 ${path.relative(dir, up.legacy)}）${up.renamed.length ? `；换了编号：${up.renamed.map(r => `${r.from}→${r.to}`).join('、')}` : ''}`);
  else if (!store.hasRules(dir)) {
    store.replaceAll(dir, store.initialFiles(dir), { source: '新建' });
    log(`✓ 已在 ${store.RULES_DIR} 按项目的文件夹建好第一批需求`);
  }
  ensureGuide(dir);
  store.syncFiles(dir, null, '其他'); // 第一次：建快照
  store.ensureTracking(dir);
  log('完成。新开 Claude Code 会话后生效。');
  return { dir, runtime, upgraded: up };
}

// 停用：去掉 hook。规则文件留着（它们是 Claude Code 的普通规则，照样按路径加载；不想要就删掉 .claude/rules/ruletree/）。返回动了哪些地方
function disable(dir) {
  dir = path.resolve(dir);
  const done = [];
  for (const f of ['settings.local.json', 'settings.json']) {
    const p = path.join(dir, '.claude', f);
    const s = readSettings(p, null);
    if (!stripOurs(s)) continue;
    fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
    done.push(`.claude/${f}`);
  }
  return done;
}

const USAGE = `用法（目录默认是当前目录）：
  ruletree init    [目录]        在项目里启用：装 hook、忽略 .ruletree/；旧版的 需求树.md 拆成规则文件，没有就按文件夹建第一批需求
  ruletree disable [目录]        停用：去掉 hook（规则文件留着）
  ruletree tree    [目录]        打印整棵树
  ruletree rules   <编号> [目录]  打印某个需求实际要守的规则（含上级的）
  ruletree check   [目录]        只用程序检查（不调用模型、不改文件）：重复、送不到、提到的文件不在、文档不在、规则太多
  ruletree checkup [目录] [--no-model]  体检：程序检查 + 一次模型调用找重复、矛盾、过时的规则并直接改（可在面板上撤销），写报告`;

function printTree(dir) {
  const label = n => `${n.id} ${n.title}${n.status ? ' ' + T.STATUS_EMOJI[n.status] : ''}`;
  const root = store.readTree(dir);
  const print = (node, indent) => { for (const c of node.children) { console.log(indent + label(c) + (c.rules.length ? `  (规则 ${c.rules.length})` : '')); print(c, indent + '  '); } };
  print(root, '');
}

function printRules(dir, id) {
  const root = store.readTree(dir);
  const node = id && T.findById(root, id);
  if (!node) { console.error(`找不到需求：${id}`); return 1; }
  console.log(`# ${T.pathOf(node).map(n => `${n.id} ${n.title}`).join(' → ')}\n`);
  for (const n of T.pathOf(node)) for (const r of n.rules) console.log(`- ${r.text}${n === node ? '' : `（来自 ${n.id}）`}`);
  return 0;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const flags = rest.filter(a => a.startsWith('--')), args = rest.filter(a => !a.startsWith('--'));
  const dirArg = i => path.resolve(args[i] || process.cwd());
  if (cmd === 'init') { init(dirArg(0)); return 0; }
  if (cmd === 'disable') {
    const done = disable(dirArg(0));
    console.log(done.length ? `已停用：改了 ${done.join('、')}；规则文件留着` : '这个项目没有启用需求树');
    return 0;
  }
  if (cmd === 'tree') { printTree(dirArg(0)); return 0; }
  if (cmd === 'rules') return printRules(dirArg(1), args[0]);
  if (cmd === 'check' || cmd === 'checkup') {
    const C = require('../src/checkup');
    const dir = dirArg(0);
    if (!store.hasRules(dir)) { console.error(`${dir} 里没有规则文件（${store.RULES_DIR}）；先运行 ruletree init`); return 1; }
    if (cmd === 'check') {
      const notes = C.programChecks(dir);
      notes.forEach(n => console.log('- ' + C.noteText(n)));
      console.log(notes.length ? `共 ${notes.length} 处要看` : '没有发现问题');
      return notes.length ? 1 : 0;
    }
    console.log(flags.includes('--no-model') ? '体检（只用程序检查）…' : '体检：程序检查 + 一次模型调用（一两分钟）…');
    const r = await C.runCheckup(dir, { model: !flags.includes('--no-model') });
    console.log(r.report);
    return r.error ? 1 : 0;
  }
  console.log(USAGE);
  return 1;
}

if (require.main === module) main(process.argv.slice(2)).then(code => process.exit(code), e => { console.error(e.message); process.exit(1); });

module.exports = {
  init, disable, VERSION, hookCommand, isOurs, enabledIn, hasOldHooks, stripOurs, RUNTIME_PARTS,
  installRuntime, runtimeDir, runtimeVersion, refreshRuntimeIfOlder, isOlder, main,
};
