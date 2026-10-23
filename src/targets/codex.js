'use strict';
// 编译目标：OpenAI Codex。
// Codex 没有按文件路径加载规则的机制：AGENTS.md 在会话开始时从项目根到当前目录读一遍（合计默认上限 32 KiB），
// 之后不再按改到的文件补充。所以分两路把规则送到 AI 手上：
// 1. 项目根 AGENTS.md 里的托管块（<!-- reqtree:begin --> … <!-- reqtree:end -->）：全局规则 + 一张「改哪些文件先读哪份规则」的索引。
//    不需要 hook，Codex 桌面版、CLI、IDE 插件都认。用户自己写在 AGENTS.md 里的内容一个字不动。
// 2. hooks/codex-hook.js（需要用户在 Codex 里信任 hook）：AI 读写到匹配的文件时，把那份规则作为 additionalContext 送过去，
//    同一份规则每个会话只送一次。
//
// 规则分组：每个有自己文件对应的需求是一个「单元」，带上它下面没有自己文件对应的子需求（它们沿用这个范围）。
// 每个单元编译成 .reqtree/rules/<ID>.md。上级的范围包住下级时，改下级的文件会匹配好几个单元——全读，
// 和 Claude Code 原生路径规则按 glob 嵌套继承是同一个意思。根节点的规则是全局的，直接写在托管块里。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parse, walk, pathOf, nodeForFile } = require('../parser');

const RULES_DIR = path.join('.reqtree', 'rules');
const MARK = '<!-- reqtree:generated -->';
// 生成格式的版本，写在 .reqtree/rules/_index.md 里；输出格式变了就加 1（同 compile.js 的 FORMAT）
const FORMAT = '<!-- reqtree:codex-format 3 -->';
const BEGIN = '<!-- reqtree:begin -->';
const END = '<!-- reqtree:end -->';
// 安装过 Codex 目标的标记，也存记录员的模型设置（用户可以手改）
const CONFIG = path.join('.reqtree', 'codex.json');
// Codex 默认只读 AGENTS.md 合计 32 KiB（project_doc_max_bytes），托管块超过这个数就提醒
const BLOCK_WARN_BYTES = 16 * 1024;
// hook 往 Codex 上下文里加的内容上限：Codex 默认 additionalContextLimit 2500 token，按 4 字节一个 token 估算
// （codex-rs/hooks/src/output_spill.rs、codex-rs/utils/string/src/truncate.rs approx_token_count），超过的存进文件、只给预览。留点余量
const CONTEXT_LIMIT = 9000;

const { isRoot, tmpDir } = require('../common');

// ---------- 分组 ----------

// 有规则的单元：[{ id, owner, globs, members[] }]；members 按树里的顺序
function units(root) {
  const out = [];
  for (const owner of walk(root)) {
    if (isRoot(owner) || !owner.files.length) continue;
    const members = [];
    const visit = n => {
      members.push(n);
      for (const c of n.children) if (!c.files.length) visit(c);
    };
    visit(owner);
    if (members.some(m => m.rules.length)) out.push({ id: owner.id, owner, globs: owner.files, members });
  }
  return out;
}

const globalRules = root => root.children.filter(isRoot).flatMap(n => n.rules.map(r => ({ node: n, rule: r })));

// 带键的规则覆盖最近上级里同键的规则（和 compile.js 的说法一致）
function overrideNote(node, rule) {
  if (!rule.key) return '';
  for (let p = node.parent; p && p.parent; p = p.parent) {
    const hit = p.rules.find(x => x.key === rule.key);
    if (hit) return `（在本范围内以此为准，取代上级 ${hit.owner.id} 的「${hit.text}」）`;
  }
  return '';
}

function renderUnit(u, treeName) {
  const lines = [MARK, `# 需求 ${pathOf(u.owner).map(n => `${n.id} ${n.title}`).join(' → ')}`,
    `适用文件：${u.globs.map(g => '`' + g + '`').join('、')}`, ''];
  for (const m of u.members) {
    if (!m.rules.length) continue;
    if (m !== u.owner) lines.push(`## ${m.id} ${m.title}`);
    for (const r of m.rules) lines.push(`- ${r.text}${overrideNote(m, r)}`);
    lines.push('');
  }
  lines.push(`（由 ${treeName} 自动生成，不要手改；规则要改就改 ${treeName}。）`);
  return lines.join('\n') + '\n';
}

// 托管块。eol 跟着用户的 AGENTS.md 走
function renderBlock(root, treeName, us) {
  const doing = [...walk(root)].filter(n => n.status === 'doing').map(n => `${n.id} ${n.title}`);
  const glob = globalRules(root);
  const lines = [
    BEGIN,
    `## 需求树（${treeName}）`,
    '',
    `本项目的需求和规则统一记在 ${treeName}：标题是需求，结尾 ✅完成 🔨进行中 ⏳待做 ❓待定；标题下的列表项是规则。这一段由需求树自动生成，不要手改；规则要改就改 ${treeName}。`,
  ];
  if (doing.length) lines.push(`进行中：${doing.join('、')}。`);
  lines.push('用户提出的长期要求由后台记录员在每轮结束后写进需求树，你不用自己记；用户明确说"记下来"时可以直接改需求树。某个需求做完了，把它的状态改成 ✅。');
  lines.push('项目的长期要求和规则只记在需求树里（后台记录员负责），不要再写进记忆（memory）或 AGENTS.md，免得同一条规则记两处。');
  if (glob.length) {
    lines.push('', '### 全局规则', '');
    for (const { node, rule } of glob) lines.push(`- ${rule.text}`);
  }
  if (us.length) {
    lines.push('', '### 按文件的规则', '',
      '动手修改或新建下面这些文件之前，先读对应的规则文件，照着做。一个文件匹配几条就读几份（范围小的那份在冲突时优先）；同一份在本次会话里读过就不用再读。', '');
    for (const u of us) {
      lines.push(`- ${u.globs.map(g => '`' + g + '`').join('、')} → \`${path.posix.join('.reqtree/rules', u.id + '.md')}\`（${u.id} ${u.owner.title}）`);
    }
  }
  lines.push(END);
  return lines.join('\n');
}

// 找托管块：标记要单独占一行（行内提到的不算），END 只在 BEGIN 后面找。
// 返回 { start, end }（end 是 END 标记之后的位置）；没有块返回 null；有 BEGIN 没有 END 返回 { broken: true }
function findBlock(text) {
  const marker = m => new RegExp(`^[ \\t]*${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'm');
  const b = marker(BEGIN).exec(text);
  if (!b) return null;
  const start = b.index + b[0].indexOf(BEGIN);
  const after = b.index + b[0].length;
  const e = marker(END).exec(text.slice(after));
  if (!e) return { broken: true };
  return { start, end: after + e.index + e[0].indexOf(END) + END.length };
}

// 把托管块放进文本：已有就原地替换，没有就加在末尾。用户的其他内容不动。
// 块不完整（用户删了结束标记）时原样返回：不知道块到哪里结束，写了会吞掉用户的内容（compile 会提醒）
function upsertBlock(text, block) {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const b = block.replace(/\r?\n/g, eol);
  const at = findBlock(text);
  if (at && at.broken) return text;
  if (at) return text.slice(0, at.start) + b + text.slice(at.end);
  if (!text.trim()) return b + eol;
  return text.replace(/\s*$/, '') + eol + eol + b + eol;
}

function removeBlock(text) {
  const at = findBlock(text);
  if (!at || at.broken) return text;
  const i = at.start, j = at.end - END.length;
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const before = text.slice(0, i).replace(/\s*$/, ''), after = text.slice(j + END.length).replace(/^\s*/, '');
  if (before && after) return before + eol + eol + after;
  return before || after ? (before || after) + (/\r?\n$/.test(after) ? '' : eol) : '';
}

// 同一目录里 AGENTS.override.md 存在时 Codex 不读 AGENTS.md，托管块要写进 override
function agentsFile(projectDir) {
  const over = path.join(projectDir, 'AGENTS.override.md');
  try { if (fs.readFileSync(over, 'utf8').trim()) return over; } catch {}
  return path.join(projectDir, 'AGENTS.md');
}

// ---------- 开关 ----------

function readConfig(projectDir) {
  try { return JSON.parse(fs.readFileSync(path.join(projectDir, CONFIG), 'utf8')) || {}; } catch { return null; }
}

// 装过 Codex 目标：有 .reqtree/codex.json，或 AGENTS.md 里已经有托管块
function enabled(projectDir) {
  if (readConfig(projectDir)) return true;
  for (const f of ['AGENTS.md', 'AGENTS.override.md']) {
    try { if (findBlock(fs.readFileSync(path.join(projectDir, f), 'utf8'))) return true; } catch {}
  }
  return false;
}

// ---------- 编译 ----------

// 返回 { written: [], removed: [], dir, agents, warnings: [] }；written/removed 里的名字带 codex: 前缀，和 Claude 的区分
function compile(treePath) {
  const projectDir = path.dirname(treePath);
  const treeName = path.basename(treePath);
  const dir = path.join(projectDir, RULES_DIR);
  const root = parse(fs.readFileSync(treePath, 'utf8'));
  const us = units(root);
  const files = new Map([['_index.md', `${MARK}\n${FORMAT}\n需求树规则（Codex）。索引在项目根的 AGENTS.md 托管块里。\n`]]);
  for (const u of us) files.set(`${u.id}.md`, renderUnit(u, treeName));

  fs.mkdirSync(dir, { recursive: true });
  const written = [], removed = [], warnings = [];
  for (const [name, text] of files) {
    const p = path.join(dir, name);
    let old = null;
    try { old = fs.readFileSync(p, 'utf8'); } catch {}
    if (old !== text) { fs.writeFileSync(p, text); written.push('codex:' + name); }
  }
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md') || files.has(name)) continue;
    const p = path.join(dir, name);
    if (fs.readFileSync(p, 'utf8').includes(MARK)) { fs.unlinkSync(p); removed.push('codex:' + name); }
  }

  const agents = agentsFile(projectDir);
  let before = '';
  try { before = fs.readFileSync(agents, 'utf8'); } catch {}
  const block = renderBlock(root, treeName, us);
  const found = findBlock(before);
  if (found && found.broken) warnings.push(`${path.basename(agents)} 里需求树的部分不完整（有开始标记 ${BEGIN}，没有结束标记 ${END}），没有更新它；补上结束标记或删掉开始标记后再编译`);
  const after = upsertBlock(before, block);
  if (after !== before) { fs.writeFileSync(agents, after); written.push('codex:' + path.basename(agents)); }
  if (Buffer.byteLength(block) > BLOCK_WARN_BYTES) warnings.push(`AGENTS.md 里需求树的部分有 ${Buffer.byteLength(block)} 字节，Codex 默认只读 AGENTS.md 合计 32 KiB，全局规则太多会被截掉`);
  return { written, removed, dir, agents, warnings };
}

const stampPath = projectDir => path.join(projectDir, RULES_DIR, '_index.md');
// 编译结果是不是比树旧（或是旧格式）
function stale(treePath) {
  const projectDir = path.dirname(treePath);
  try {
    const stamp = stampPath(projectDir);
    if (fs.statSync(stamp).mtimeMs < fs.statSync(treePath).mtimeMs) return true;
    if (!fs.readFileSync(stamp, 'utf8').includes(FORMAT)) return true;
    const at = findBlock(fs.readFileSync(agentsFile(projectDir), 'utf8'));
    return !at || !!at.broken;
  } catch { return true; }
}

// ---------- hook 用：从工具调用里找出涉及的文件 ----------

// apply_patch 的补丁文本（tool_input.command）里改了哪些文件：Add/Update/Delete File 和 Move to
function patchFiles(patch) {
  const out = [];
  for (const m of String(patch || '').matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/gm)) out.push(m[1].replace(/^(["'])(.*)\1$/, '$2'));
  return [...new Set(out)];
}

// 命令行里像文件路径的词（只用来决定送哪份规则，猜错了顶多多送或少送一份，不用于记活动）
function shellPaths(command) {
  // 引号里的整段（路径可能带空格）+ 按空白和符号切开的词；powershell -Command "…'a.html'…" 这种嵌套引号两层都能取到
  const s = String(command || '');
  const tokens = [...s.matchAll(/'([^']+)'|"([^"]+)"/g)].map(m => m[1] || m[2]).concat(s.split(/[\s"'|;&<>(),]+/));
  const out = [];
  for (let t of tokens) {
    t = t.trim().replace(/^-[A-Za-z]+[:=]/, '');
    if (!t || /\s/.test(t) && !/^[^\s]+(?: [^\s]+)*\.[A-Za-z0-9]{1,6}$/.test(t)) continue;
    if (/[\\/]/.test(t) || /\.[A-Za-z0-9]{1,6}$/.test(t)) out.push(t);
  }
  return [...new Set(out)];
}

// 命令像不像在写文件。Codex 在 Windows 上常用 PowerShell 改文件（Set-Content、WriteAllText），不走 apply_patch，
// 只认 apply_patch 会漏掉大部分改动。只看动词，不看 > 号（HTML 片段里到处是 >）
const WRITE_CMD = /\b(Set-Content|Add-Content|Out-File|WriteAll(?:Text|Bytes|Lines)|New-Item|Copy-Item|Move-Item|Rename-Item|Remove-Item|sed\s+-i|tee|cp|mv|rm|touch)\b|open\([^)]*,\s*['"][wa]/i;
const isWriteCommand = command => WRITE_CMD.test(String(command || ''));

// 绝对或相对路径 → 相对项目根、用 / 分隔；不在项目里返回 null
function relTo(projectDir, cwd, p) {
  const abs = path.resolve(cwd || projectDir, String(p).replace(/^['"]|['"]$/g, ''));
  const rel = path.relative(projectDir, abs).split(path.sep).join('/');
  return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? null : rel;
}

const matchesGlobs = (globs, rel) => !!nodeForFile({ children: [{ files: globs, children: [], level: 1 }] }, rel);

// 这些文件涉及哪些单元（按树里的顺序，上级在前）
function unitsForFiles(root, rels) {
  return units(root).filter(u => rels.some(rel => matchesGlobs(u.globs, rel)));
}

// 命令里直接读了 .reqtree/rules/<ID>.md：AI 已经照 AGENTS.md 的索引看过这份
function readRuleIds(rels) {
  return rels.map(r => (r.match(/^\.reqtree\/rules\/([^/]+)\.md$/) || [])[1]).filter(id => id && id !== '_index');
}

const hash = s => crypto.createHash('md5').update(s).digest('hex').slice(0, 12);

// ---------- 记录员用的模型命令 ----------

// 找 codex 可执行文件：PATH 上的 codex，其次 Codex 桌面版自带的（%LOCALAPPDATA%\OpenAI\Codex\bin\<哈希>\codex.exe，取最新的）
function findCodex() {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['codex'], { encoding: 'utf8', windowsHide: true });
  const onPath = r.status === 0 && (r.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (onPath && onPath.length) {
    // Windows 上优先 .cmd/.exe（where 也会列出给 bash 用的无后缀脚本）
    return onPath.find(p => /\.(cmd|exe|bat)$/i.test(p)) || onPath[0];
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const base = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    const found = [];
    try {
      for (const d of fs.readdirSync(base)) {
        const p = path.join(base, d, 'codex.exe');
        try { found.push({ p, t: fs.statSync(p).mtimeMs }); } catch {}
      }
      const top = path.join(base, 'codex.exe');
      try { found.push({ p: top, t: fs.statSync(top).mtimeMs }); } catch {}
    } catch {}
    found.sort((a, b) => b.t - a.t);
    if (found.length) return found[0].p;
  }
  return null;
}

const DEFAULT_MODEL = 'gpt-6-luna';
// 记录员调用的命令：提示词从 stdin 进，最终回复（JSON）从 stdout 出。
// 不读用户的 config.toml（不加载 MCP、插件和 notify，启动快，也不会弹用户的提醒），不存会话，只读沙箱
function recorderCommand(projectDir) {
  const cfg = readConfig(projectDir) || {};
  if (process.env.REQTREE_CODEX_RECORDER_CMD) return process.env.REQTREE_CODEX_RECORDER_CMD;
  if (cfg.recorderCmd) return cfg.recorderCmd;
  const bin = findCodex();
  if (!bin) return null;
  const model = process.env.REQTREE_CODEX_MODEL || cfg.model || DEFAULT_MODEL;
  const effort = cfg.effort || 'low';
  return `"${bin}" exec -m ${model} -c model_reasoning_effort=${effort} --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules -s read-only --color never -`;
}

// 会话状态：已经送过哪些单元（id → 内容哈希）。每个会话一个小文件
function sessionFile(projectDir, session) {
  const norm = process.platform === 'win32' ? projectDir.toLowerCase() : projectDir;
  return path.join(tmpDir(), 'codex-' + crypto.createHash('md5').update(norm + '|' + (session || '')).digest('hex') + '.json');
}

module.exports = {
  RULES_DIR, CONFIG, BEGIN, END, FORMAT, DEFAULT_MODEL, CONTEXT_LIMIT,
  units, renderUnit, renderBlock, findBlock, upsertBlock, removeBlock, agentsFile,
  readConfig, enabled, compile, stale,
  patchFiles, shellPaths, isWriteCommand, relTo, matchesGlobs, unitsForFiles, readRuleIds, hash,
  findCodex, recorderCommand, sessionFile,
};
