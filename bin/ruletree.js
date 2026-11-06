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
const { isOurs, settingsHooks, scriptOf } = require('../src/common'); // 认 hook 的办法放 src/common.js：hooks/hook.js 够不到 bin/
const isCurrent = h => isOurs(h) && /ruletree/i.test(String(h.command));
// 装了能用的新版 hook（脚本文件还在）
const enabledIn = dir => settingsHooks(dir, h => { if (!isCurrent(h)) return false; const p = scriptOf(h); return !!p && fs.existsSync(p); });
// 还装着旧版（需求树 reqtree）的 hook：要升级
const hasOldHooks = dir => settingsHooks(dir, h => isOurs(h) && !isCurrent(h));

// 让 AI 记规则不用每次弹「允许」：Claude Code 对 .claude/ 里的文件默认要确认。只放行规则文件夹，写在 settings.local.json（不进 git）
const ALLOW_RULES = 'Edit(/.claude/rules/ruletree/**)';

// 从一份 settings 里去掉我们的 hook 和允许规则（别的原样留着），返回有没有改
function stripOurs(s) {
  if (!s) return false;
  let changed = false;
  const allow = s.permissions && s.permissions.allow;
  if (Array.isArray(allow) && allow.includes(ALLOW_RULES)) {
    s.permissions.allow = allow.filter(r => r !== ALLOW_RULES);
    if (!s.permissions.allow.length) delete s.permissions.allow;
    if (!Object.keys(s.permissions).length) delete s.permissions;
    changed = true;
  }
  if (!s.hooks || typeof s.hooks !== 'object') return changed;
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
function installClaude(dir, { runtime, log, plugin }) {
  if (plugin) return installAllowOnly(dir, log);
  const command = hookCommand(path.join(runtime, 'hooks', 'hook.js'));
  const shared = path.join(dir, '.claude', 'settings.json');
  const sh = readSettings(shared, null);
  if (stripOurs(sh)) { fs.writeFileSync(shared, JSON.stringify(sh, null, 2) + '\n'); log(`✓ 去掉了 ${shared} 里的需求树 hook`); }
  const settingsPath = path.join(dir, '.claude', 'settings.local.json');
  const settings = readSettings(settingsPath, {});
  stripOurs(settings);
  settings.permissions = settings.permissions && typeof settings.permissions === 'object' ? settings.permissions : {};
  settings.permissions.allow = [...(Array.isArray(settings.permissions.allow) ? settings.permissions.allow : []), ALLOW_RULES];
  settings.hooks = settings.hooks || {};
  for (const [event, matcher] of [['PostToolUse', EDIT_MATCHER], ['InstructionsLoaded', null]]) {
    const group = { hooks: [{ type: 'command', command, async: true }] };
    if (matcher) group.matcher = matcher;
    (settings.hooks[event] = settings.hooks[event] || []).push(group);
  }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  log(`✓ hook 和「AI 可以直接改规则文件夹」的允许规则已写入 ${settingsPath}`);
}

// 插件路线：hook 由插件自己带（hooks/hooks.json），项目里不装 hook，免得和插件的重复；只写允许规则。
// 项目里原有的 hook 不动（VS Code 路线的项目照常用，插件的 hook 见到它会让路）
function installAllowOnly(dir, log) {
  const settingsPath = path.join(dir, '.claude', 'settings.local.json');
  const settings = readSettings(settingsPath, {});
  settings.permissions = settings.permissions && typeof settings.permissions === 'object' ? settings.permissions : {};
  const allow = Array.isArray(settings.permissions.allow) ? settings.permissions.allow : [];
  if (!allow.includes(ALLOW_RULES)) settings.permissions.allow = [...allow, ALLOW_RULES];
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  log(`✓ 「AI 可以直接改规则文件夹」的允许规则已写入 ${settingsPath}（hook 由插件提供）`);
}

// 在项目里启用：复制运行时副本、装 hook、忽略 .ruletree/；旧版的 需求树.md 拆成规则文件，没有就按文件夹建第一批需求；写说明书。
// 重复运行无副作用。命令行和插件共用（插件传 log 收集输出）；出错抛异常，不退出进程
function init(dir, { log = console.log, plugin = false } = {}) {
  dir = path.resolve(dir);
  if (!fs.statSync(dir).isDirectory()) throw new Error(`不是文件夹：${dir}`);
  const have = runtimeVersion();
  let runtime = null; // 插件路线不用运行时副本：hook 直接从插件目录跑
  if (plugin) {}
  else if (have && isOlder(VERSION, have)) { runtime = runtimeDir(); log(`✓ ${runtime} 里已经是更新的版本 ${have}（这次是 ${VERSION}），不覆盖`); }
  else { runtime = installRuntime(); log(`✓ hook 程序已复制到 ${runtime}（版本 ${VERSION}）`); }
  installClaude(dir, { runtime, log, plugin });
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
  const gs = require('../src/files').rulesGitState(dir, store.RULES_DIR);
  if (gs === 'ignored') log(`! ${store.RULES_DIR.replace(/\\/g, '/')}/ 被 .gitignore 忽略了：规则只在这个文件夹里，其他工作区、分支和同事看不到。想共享，在 .gitignore 里放行（.claude/ 整个被忽略时，要改成 .claude/* 再加一行 !.claude/rules/），然后提交`);
  else if (gs === 'untracked') log(`! ${store.RULES_DIR.replace(/\\/g, '/')}/ 还没加进 git：不提交的话，其他工作区、分支和同事看不到规则。请自己 git add 并提交`);
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
  ruletree snapshot [目录] [--file <路径>] --json  打印项目现状（给 Claude 插件的面板读），--file 是正在改的文件
  ruletree edit    [目录] --json  从标准输入读 {"ops":[...]} 或 {"undo":"id"}，改规则或撤销（给 Claude 插件的面板用）
  ruletree tree    [目录]        打印整棵树
  ruletree rules   <编号> [目录]  打印某个需求实际要守的规则（含上级的）
  ruletree check   [目录]        只用程序检查（不调用模型、不改文件）：重复、送不到、提到的文件不在、文档不在、规则太多
  ruletree checkup [目录] [--no-model]  体检：程序检查 + 分块调用模型找重复、矛盾、过时的规则并直接改（可在面板上撤销），写报告`;

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
  const fi = rest.indexOf('--file'), file = fi >= 0 ? rest[fi + 1] : undefined; // --file 后面跟着路径，不当作目录参数
  const own = fi >= 0 ? rest.filter((_, i) => i !== fi && i !== fi + 1) : rest;
  const flags = own.filter(a => a.startsWith('--')), args = own.filter(a => !a.startsWith('--'));
  const dirArg = i => path.resolve(args[i] || process.cwd());
  if (cmd === 'init') { init(dirArg(0)); return 0; }
  if (cmd === 'disable') {
    const done = disable(dirArg(0));
    console.log(done.length ? `已停用：改了 ${done.join('、')}；规则文件留着` : '这个项目没有启用需求树');
    return 0;
  }
  if (cmd === 'snapshot') { console.log(JSON.stringify(require('../src/snapshot').snapshot(dirArg(0), { file }))); return 0; }
  if (cmd === 'edit') {
    // 从标准输入读 JSON：{ ops } 或 { undo }。结果打印成一行 JSON；输入不合规矩退出码 1
    const { findProjectUp } = require('../src/common');
    const dir = findProjectUp(dirArg(0));
    const out = r => console.log(JSON.stringify(r));
    if (!dir) { out({ ok: false, result: 'failed', message: '这个项目没有启用需求树' }); return 1; }
    let input;
    try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { out({ ok: false, result: 'failed', message: '标准输入不是 JSON' }); return 1; }
    try { out(await require('../src/edit').run(dir, input)); } catch (e) { out({ ok: false, result: 'failed', message: e.message }); return 1; }
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
    console.log(flags.includes('--no-model') ? '体检（只用程序检查）…' : '体检：程序检查 + 分块调用模型（并行，通常一两分钟）…');
    const r = await C.runCheckup(dir, { model: !flags.includes('--no-model') });
    console.log(r.report);
    return r.error || r.failed.length ? 1 : 0;
  }
  console.log(USAGE);
  return 1;
}

if (require.main === module) main(process.argv.slice(2)).then(code => process.exit(code), e => { console.error(e.message); process.exit(1); });

module.exports = {
  init, disable, VERSION, hookCommand, isOurs, enabledIn, hasOldHooks, stripOurs, RUNTIME_PARTS,
  installRuntime, runtimeDir, runtimeVersion, refreshRuntimeIfOlder, isOlder, main,
};
