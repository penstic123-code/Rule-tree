'use strict';
// 在项目里为 OpenAI Codex 装好需求树：
// - <项目>/.codex/hooks.json：合并写入 3 个 hook（重复运行不重复；已有的原地换成新命令；用户自己的 hook 不动；旧版多出来的事件删掉）
// - <项目>/.ruletree/codex.json：装过 Codex 的标记
// - AGENTS.md 托管块（说明书、全局规则、按文件的规则索引，指向 .claude/rules/ruletree/ 里的需求文件）
// 不碰用户的 ~/.codex/config.toml。Codex 要求用户在 /hooks 里信任项目 hook 才会运行（见 docs/codex.md）；
// trustSnippet 给出等价的 config.toml 片段，只在用户明确同意时由调用方写入。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('../store');
const codex = require('./codex');

const HOOK_FILE = 'codex-hook.js';
const isOurs = h => /codex-hook\.js/.test((h && h.command) || '') || /codex-hook\.js/.test((h && h.commandWindows) || '');

// 事件、matcher、超时（秒）。都同步运行：PostToolUse 要把规则送回给 AI，必须同步
const EVENTS = [
  ['SessionStart', null, 15],
  ['UserPromptSubmit', null, 15],
  ['PostToolUse', 'Bash|apply_patch', 15],
];

function hookCommand(runtimeDir) {
  const script = path.join(runtimeDir, 'hooks', HOOK_FILE).split(path.sep).join('/');
  return `node "${script}"`;
}

// 返回合并后的 hooks.json 对象（不写盘）
function mergeHooks(existing, command) {
  const cfg = existing && typeof existing === 'object' ? existing : {};
  const hooks = cfg.hooks && typeof cfg.hooks === 'object' ? cfg.hooks : {};
  const wanted = new Map(EVENTS.map(([ev, matcher, timeout]) => [ev, { matcher, handler: { type: 'command', command, timeout, statusMessage: '需求树' } }]));
  // 原地替换：Codex 的信任键是「hooks.json 路径:事件:组序号:序号」，把我们的组挪到末尾会改变用户自己 hook 的序号，
  // 用户就得在 /hooks 里重新信任。所以已有的我们的 hook 留在原位换成新命令，多出来的删掉，没有的才加在末尾
  for (const ev of Object.keys(hooks)) {
    if (!Array.isArray(hooks[ev])) continue;
    const want = wanted.get(ev);
    let placed = false;
    hooks[ev] = hooks[ev].map(g => {
      if (!g || !Array.isArray(g.hooks) || !g.hooks.some(isOurs)) return g;
      const rest = g.hooks.filter(h => !isOurs(h));
      if (!want || placed) return { ...g, hooks: rest };
      placed = true;
      const i = g.hooks.findIndex(isOurs);
      const next = { ...g, hooks: [...rest.slice(0, i), want.handler, ...rest.slice(i)] };
      // 整组只有我们的 hook 时，matcher 也按当前版本写
      if (!rest.length) { if (want.matcher) next.matcher = want.matcher; else delete next.matcher; }
      return next;
    }).filter(g => !g || !Array.isArray(g.hooks) || g.hooks.length);
    if (placed) wanted.delete(ev);
    if (!hooks[ev].length) delete hooks[ev];
  }
  for (const [ev, { matcher, handler }] of wanted) {
    const group = { hooks: [handler] };
    if (matcher) group.matcher = matcher;
    (hooks[ev] = Array.isArray(hooks[ev]) ? hooks[ev] : []).push(group);
  }
  return { ...cfg, hooks };
}

function removeHooks(existing) {
  const cfg = existing && typeof existing === 'object' ? existing : {};
  const hooks = cfg.hooks || {};
  for (const ev of Object.keys(hooks)) {
    if (!Array.isArray(hooks[ev])) continue;
    hooks[ev] = hooks[ev].map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !isOurs(h)) })).filter(g => g.hooks.length);
    if (!hooks[ev].length) delete hooks[ev];
  }
  return { ...cfg, hooks };
}

const ensureGitignore = store.ensureGitignore;

// installCodex(projectDir, { runtimeDir })。项目里要已经有规则文件（命令行 init 先建好）
// runtimeDir：hook 脚本所在的目录（含 hooks/codex-hook.js、src/），默认本仓库
// 返回 { hooksPath, agentsPath, configPath, compiled, warnings, trust }
function installCodex(projectDir, opts = {}) {
  projectDir = path.resolve(projectDir);
  const runtimeDir = path.resolve(opts.runtimeDir || path.join(__dirname, '..', '..'));
  const warnings = [];
  if (!fs.existsSync(path.join(runtimeDir, 'hooks', HOOK_FILE))) warnings.push(`${runtimeDir} 里没有 hooks/${HOOK_FILE}，hook 会运行失败`);

  // 1. hooks.json。原文件不是合法 JSON 时不覆盖，交给用户
  const hooksPath = path.join(projectDir, '.codex', 'hooks.json');
  let existing = {};
  if (fs.existsSync(hooksPath)) {
    try { existing = JSON.parse(fs.readFileSync(hooksPath, 'utf8')); }
    catch (e) { throw new Error(`${hooksPath} 不是合法的 JSON，没有改它：${e.message}`); }
  }
  const merged = mergeHooks(existing, hookCommand(runtimeDir));
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  const text = JSON.stringify(merged, null, 2) + '\n';
  let old = null;
  try { old = fs.readFileSync(hooksPath, 'utf8'); } catch {}
  if (old !== text) fs.writeFileSync(hooksPath, text);
  // 同一层既有 hooks.json 又有 config.toml 里的 [hooks] 时 Codex 会合并并警告
  try { if (/^\s*\[\[?hooks[.\]]/m.test(fs.readFileSync(path.join(projectDir, '.codex', 'config.toml'), 'utf8'))) warnings.push('.codex/config.toml 里也有 [hooks]，Codex 会和 hooks.json 合并并在启动时警告'); } catch {}

  // 2. 标记
  const configPath = path.join(projectDir, codex.CONFIG);
  store.writeJson(configPath, { version: 2 });
  ensureGitignore(projectDir);
  // 旧版另抄的一份规则（.reqtree/rules/）不用了
  try { fs.rmSync(path.join(projectDir, '.reqtree', 'rules'), { recursive: true, force: true }); } catch {}

  // 3. AGENTS.md 托管块
  const compiled = codex.compile(projectDir);
  warnings.push(...compiled.errors, ...compiled.warnings);
  if (AGENTS_OVERRIDE(projectDir)) warnings.push('项目根有 AGENTS.override.md，Codex 不读同目录的 AGENTS.md，需求树的部分已写进 AGENTS.override.md');

  return { hooksPath, agentsPath: codex.agentsFile(projectDir), configPath, compiled, warnings, trust: trustEntries(projectDir) };
}

const AGENTS_OVERRIDE = projectDir => path.basename(codex.agentsFile(projectDir)) === 'AGENTS.override.md';

function uninstallCodex(projectDir) {
  projectDir = path.resolve(projectDir);
  const hooksPath = path.join(projectDir, '.codex', 'hooks.json');
  try {
    const cfg = removeHooks(JSON.parse(fs.readFileSync(hooksPath, 'utf8')));
    if (Object.keys(cfg.hooks).length || Object.keys(cfg).length > 1) fs.writeFileSync(hooksPath, JSON.stringify(cfg, null, 2) + '\n');
    else fs.unlinkSync(hooksPath);
  } catch {}
  for (const f of ['AGENTS.md', 'AGENTS.override.md']) {
    const p = path.join(projectDir, f);
    try {
      const t = fs.readFileSync(p, 'utf8');
      const n = codex.removeBlock(codex.removeBlock(t), codex.OLD);
      if (n !== t) { if (n.trim()) fs.writeFileSync(p, n); else fs.unlinkSync(p); }
    } catch {}
  }
  try { fs.unlinkSync(path.join(projectDir, codex.CONFIG)); } catch {}
}

// ---------- 信任 ----------
// Codex 对每个非托管 hook 按「定义的哈希」记录信任（~/.codex/config.toml 的 [hooks.state."<hooks.json 路径>:<事件>:<组>:<序号>"] trusted_hash），
// 哈希算法见 codex-rs/hooks/src/engine/discovery.rs hook_hash 与 codex-rs/config/src/fingerprint.rs version_for_toml：
// 对 { event_name, matcher?, hooks: [规范化后的这一个 handler] } 做键排序的紧凑 JSON，再 sha256。
// 已用 codex 0.163.0 的 app-server hooks/list 返回的 currentHash 对过，一致。
const sortKeys = v => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v);
const eventLabel = ev => ev.replace(/[A-Z]/g, (c, i) => (i ? '_' : '') + c.toLowerCase());

function hookHash(event, matcher, h) {
  const handler = { type: 'command', command: (process.platform === 'win32' && h.commandWindows) || h.command, timeout: h.timeout || 600, async: !!h.async };
  if (h.statusMessage != null) handler.statusMessage = h.statusMessage;
  if (h.additionalContextLimit != null && h.additionalContextLimit !== 2500) handler.additionalContextLimit = h.additionalContextLimit;
  const id = { event_name: eventLabel(event), hooks: [handler] };
  if (matcher != null && matcher !== '') id.matcher = matcher;
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(sortKeys(id))).digest('hex');
}

// 我们装的每个 hook 的 { key, hash, event }
function trustEntries(projectDir) {
  const hooksPath = path.join(path.resolve(projectDir), '.codex', 'hooks.json');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(hooksPath, 'utf8')); } catch { return []; }
  const out = [];
  for (const [ev, groups] of Object.entries(cfg.hooks || {})) {
    (groups || []).forEach((g, gi) => (g.hooks || []).forEach((h, hi) => {
      if (isOurs(h)) out.push({ event: ev, key: `${hooksPath}:${eventLabel(ev)}:${gi}:${hi}`, hash: hookHash(ev, g.matcher, h) });
    }));
  }
  return out;
}

// 等价于在 Codex 里「信任这个项目」+ 在 /hooks 里信任这几个 hook 的 config.toml 片段。只给出文本，不写用户的全局配置
function trustSnippet(projectDir) {
  const lit = s => (s.includes("'") ? JSON.stringify(s) : `'${s}'`);
  const lines = [`[projects.${lit(path.resolve(projectDir))}]`, 'trust_level = "trusted"', ''];
  for (const t of trustEntries(projectDir)) lines.push(`[hooks.state.${lit(t.key)}]`, `trusted_hash = "${t.hash}"`, '');
  return lines.join('\n');
}

module.exports = { installCodex, uninstallCodex, mergeHooks, removeHooks, hookCommand, hookHash, trustEntries, trustSnippet, EVENTS };
