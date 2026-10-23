'use strict';
// Claude Code 的自动记忆（auto memory）和需求树：设置 reqtree.memoryMode
//   dedupe（默认）：留着自动记忆。体检时读这个项目的记忆文件夹，找出记忆和需求树里各有一份的规则，问用户删哪份
//   treeOnly：在项目的 .claude/settings.local.json 里写 "autoMemoryEnabled": false，关掉这个项目的自动记忆；切回 dedupe 时去掉这个键
//
// 记忆文件夹（官方文档 code.claude.com/docs/en/memory，2026-10-22 查过）：~/.claude/projects/<project>/memory/，
// <project> 由 git 仓库根目录（不在仓库里就是项目根目录）的路径得来：不是字母数字的字符都换成 -
// （例：c:\Users\张小明\Desktop\Vibelearning → c--Users-----Desktop-Vibelearning，中文名每个字也换成 -；盘符大小写跟启动时的路径走，所以按不分大小写找）。
// 设置 autoMemoryDirectory、环境变量 CLAUDE_CONFIG_DIR / CLAUDE_CODE_PROJECT_DIR_NAME 会改变位置，这里也认。
// 里面是 MEMORY.md（索引，每条一行）和每条记忆一个 .md 文件（开头 --- 之间是 name、description 等，后面是正文）。
//
// 删记忆之前先把文件备份到项目的 .reqtree/memory-backup/，改动记进 changes.jsonl，面板上可以撤销（memory_restore）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parse, walk, findById, similarity, norm, DUPLICATE } = require('./parser');

const slugOf = dir => String(dir).replace(/[^A-Za-z0-9]/g, '-');

function gitRoot(dir) {
  for (let d = path.resolve(dir); ;) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

// 读 Claude Code 的设置文件：不在返回 fallback；带 BOM 照读；解析不了就抛错（绝不能当成空对象写回去，会清掉用户的设置）
function readSettings(file, fallback = {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return fallback; }
  text = text.replace(/^\uFEFF/, '');
  if (!text.trim()) return fallback;
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`${file} 不是合法的 JSON（${e.message}），为了不弄丢里面的设置，没有改它`); }
}
const expandHome = (p, home) => (p.startsWith('~') ? path.join(home, p.slice(1)) : p);

// 这个项目的自动记忆文件夹；找不到返回 null
function memoryDir(projectDir, { env = process.env, home = os.homedir() } = {}) {
  const config = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  // autoMemoryDirectory：本地 > 项目 > 用户
  for (const f of [path.join(projectDir, '.claude', 'settings.local.json'), path.join(projectDir, '.claude', 'settings.json'), path.join(config, 'settings.json')]) {
    let s = null;
    try { s = readSettings(f, null); } catch {}
    if (s && typeof s.autoMemoryDirectory === 'string' && s.autoMemoryDirectory.trim()) {
      const d = path.resolve(projectDir, expandHome(s.autoMemoryDirectory.trim(), home));
      return fs.existsSync(d) ? d : null;
    }
  }
  const projects = path.join(config, 'projects');
  const names = env.CLAUDE_CODE_PROJECT_DIR_NAME ? [env.CLAUDE_CODE_PROJECT_DIR_NAME] : [slugOf(gitRoot(projectDir) || path.resolve(projectDir))];
  let list = [];
  try { list = fs.readdirSync(projects); } catch { return null; }
  for (const want of names) {
    const hit = list.find(n => n === want) || list.find(n => n.toLowerCase() === want.toLowerCase());
    if (hit && fs.existsSync(path.join(projects, hit, 'memory'))) return path.join(projects, hit, 'memory');
  }
  return null;
}

// 一条记忆文件 → { file, description, lines: [{ i 行号, text }] }。正文里有内容的行（去掉列表符号），标题行不算
const isMemFile = f => /^[^/\\]+\.md$/i.test(f) && f.toUpperCase() !== 'MEMORY.MD';
function readMemoryFile(dir, file) {
  const raw = fs.readFileSync(path.join(dir, file), 'utf8');
  const lines = raw.split(/\r?\n/);
  let start = 0, description = '';
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) {
      for (const l of lines.slice(1, end)) { const m = l.match(/^description:\s*(.+)$/); if (m) description = m[1].trim(); }
      start = end + 1;
    }
  }
  const body = [];
  for (let i = start; i < lines.length; i++) {
    const t = lines[i].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim();
    if (t && !/^#/.test(t) && [...t].length >= 4) body.push({ i, text: t });
  }
  return { file, description, lines: body };
}
function readMemory(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter(isMemFile).sort(); } catch { return []; }
  return names.map(f => { try { return readMemoryFile(dir, f); } catch { return null; } }).filter(Boolean);
}

// 一份记忆整份给模型看：{ file, type（user / feedback / project / reference，没写是 ''）, modified（YYYY-MM-DD）, mtime, description, body 正文 }
function readNote(dir, file) {
  const full = path.join(dir, file);
  const raw = fs.readFileSync(full, 'utf8').replace(/^﻿/, '');
  const lines = raw.split(/\r?\n/);
  let type = '', modified = '', description = '', start = 0;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) {
      for (const l of lines.slice(1, end)) {
        let m;
        // type: "user"、type: User 都算 user：类型决定能不能自动删，写法不同不能漏过
        if ((m = l.match(/^\s*type:\s*(\S+)/))) type = m[1].replace(/^['"]|['"]$/g, '').toLowerCase();
        else if ((m = l.match(/^\s*modified:\s*(\S+)/))) modified = m[1].slice(0, 10);
        else if ((m = l.match(/^description:\s*(.+)$/))) description = m[1].trim();
      }
      start = end + 1;
    }
  }
  const mtime = fs.statSync(full).mtimeMs;
  if (!modified) modified = new Date(mtime).toISOString().slice(0, 10);
  return { file, type, modified, mtime, description, body: lines.slice(start).join('\n').trim() };
}
function readNotes(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter(isMemFile).sort(); } catch { return []; }
  return names.map(f => { try { return readNote(dir, f); } catch { return null; } }).filter(Boolean);
}

// 这个文件是不是这个项目的一份记忆（不含 MEMORY.md 索引）：是就返回 { dir, file }。hook 用来认出 AI 这一轮写了记忆
function noteOf(projectDir, filePath) {
  const file = path.basename(filePath);
  if (!isMemFile(file)) return null;
  const dir = memoryDir(projectDir);
  if (!dir) return null;
  // ~/.claude 可能是符号链接或目录联接：两边都解析成真实路径再比
  const real = p => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const same = (a, b) => { const x = real(a), y = real(b); return process.platform === 'linux' ? x === y : x.toLowerCase() === y.toLowerCase(); };
  return same(dir, path.dirname(filePath)) ? { dir, file } : null;
}

// 记忆里的哪一句和需求树的哪条规则是同一件事（Dice ≥ 0.7）。每个（记忆文件, 规则）只取最像的一句
function findDuplicates(treeText, dir) {
  const rules = [];
  for (const n of walk(parse(treeText))) for (const r of n.rules) rules.push({ node: n.id, text: r.text });
  const out = [];
  for (const m of readMemory(dir)) {
    const texts = [...(m.description ? [m.description] : []), ...m.lines.map(l => l.text)];
    for (const r of rules) {
      let best = null, score = 0;
      for (const t of texts) { const s = similarity(t, r.text); if (s > score) { best = t; score = s; } }
      if (best && score >= DUPLICATE) out.push({ file: m.file, memory: best, node: r.node, rule: r.text });
    }
  }
  return out;
}

// 模型说是同一件事的：文件、句子、需求、规则都要对得上，否则不要
function checkDuplicate(d, treeText, dir) {
  if (!d || typeof d !== 'object' || typeof d.file !== 'string' || !isMemFile(d.file) || typeof d.memory !== 'string' || typeof d.rule !== 'string') return null;
  if (!fs.existsSync(path.join(dir, d.file))) return null;
  const m = readMemoryFile(dir, d.file);
  const texts = [...(m.description ? [m.description] : []), ...m.lines.map(l => l.text)];
  const memory = texts.find(t => t === d.memory.trim()) || texts.find(t => similarity(t, d.memory) >= 0.5);
  const node = findById(parse(treeText), d.node);
  const rule = node && (node.rules.find(r => r.text === d.rule.trim()) || node.rules.find(r => norm(r.text) === norm(d.rule)));
  return memory && rule ? { file: d.file, memory, node: node.id, rule: rule.text } : null;
}

const memKey = d => `${d.file}|${norm(d.memory)}|${d.node}|${norm(d.rule)}`;
// 记忆和需求树各有一份：问删哪份。默认建议删记忆里的（需求树是准绳），不先改
function memoryQuestion(d, dir) {
  return {
    source: '体检', kind: 'memory', memKey: memKey(d),
    text: `「${d.rule}」在记忆（${d.file}）和需求树（${d.node}）里各有一份，删哪份？`,
    t: { k: 'q.memDup', a: [d.rule, d.file, d.node] },
    options: [
      { label: '删记忆里的', t: { k: 'q.optDelMemory', a: [] }, ops: [{ op: 'memory_remove', dir, file: d.file, text: d.memory }] },
      { label: '删需求树里的', t: { k: 'q.optDelTree', a: [] }, ops: [{ op: 'remove_rule', node: d.node, text: d.rule }] },
      { label: '都留', t: { k: 'q.optKeepBoth', a: [] }, ops: [] },
    ],
    default: 0, defaultApplied: false,
  };
}

// ---------- 改记忆文件（带备份，可撤销） ----------
const INDEX = 'MEMORY.md';
const eol = f => (fs.readFileSync(f, 'utf8').includes('\r\n') ? '\r\n' : '\n');
function backup(treePath, dir, file) {
  const bdir = path.join(path.dirname(treePath), '.reqtree', 'memory-backup');
  fs.mkdirSync(bdir, { recursive: true });
  const b = path.join(bdir, `${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${file}`);
  fs.copyFileSync(path.join(dir, file), b);
  return b;
}

// memory_remove：删掉记忆里的这一句；删完正文没别的内容（或者对上的是 description）就删整个文件，连同 MEMORY.md 里指向它的那一行。
// whole: true 直接删整份（体检、记录员判断整份都已经在树里或该搬进树时用）。返回 applied（带 undo）或 null
function removeMemory(treePath, op) {
  const { dir, file, text } = op;
  if (!dir || !isMemFile(file || '') || !fs.existsSync(path.join(dir, file))) return null;
  const m = readMemoryFile(dir, file);
  const hit = op.whole ? null : (m.lines.find(l => l.text === text) || m.lines.find(l => similarity(l.text, text) >= DUPLICATE));
  const isDesc = !op.whole && !hit && m.description && (m.description === text || similarity(m.description, text) >= DUPLICATE);
  if (!op.whole && !hit && !isDesc) return null;
  const saved = backup(treePath, dir, file);
  const whole = !!op.whole || isDesc || m.lines.length <= 1;
  const undo = { op: 'memory_restore', dir, file, backup: saved };
  if (whole) {
    fs.unlinkSync(path.join(dir, file));
    const idx = path.join(dir, INDEX);
    if (fs.existsSync(idx)) {
      const lines = fs.readFileSync(idx, 'utf8').split(/\r?\n/);
      const at = lines.findIndex(l => l.includes(`](${file})`) || l.includes(`(${file})`));
      if (at >= 0) {
        undo.indexLine = lines[at]; undo.indexAt = at;
        lines.splice(at, 1);
        fs.writeFileSync(idx, lines.join(eol(idx)));
      }
    }
  } else {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    const nl = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(/\r?\n/);
    lines.splice(hit.i, 1);
    fs.writeFileSync(path.join(dir, file), lines.join(nl));
  }
  return { op: 'memory_remove', dir, file, text: hit ? hit.text : (m.description || file), wholeFile: whole, undo: [undo] };
}

// memory_restore：把备份放回去；删过索引行的，索引里没有就放回原位置
function restoreMemory(op) {
  if (!op.backup || !fs.existsSync(op.backup) || !isMemFile(op.file || '')) return false;
  fs.copyFileSync(op.backup, path.join(op.dir, op.file));
  if (op.indexLine) {
    const idx = path.join(op.dir, INDEX);
    const lines = fs.existsSync(idx) ? fs.readFileSync(idx, 'utf8').split(/\r?\n/) : [];
    if (!lines.includes(op.indexLine)) {
      const nl = fs.existsSync(idx) ? eol(idx) : '\n';
      lines.splice(Math.min(op.indexAt || 0, lines.length), 0, op.indexLine);
      fs.writeFileSync(idx, lines.join(nl));
    }
  }
  return true;
}

const isMemoryOp = o => !!o && typeof o.op === 'string' && o.op.startsWith('memory_');

// ---------- treeOnly：关掉这个项目的自动记忆 ----------
// enabled=false 写 "autoMemoryEnabled": false；enabled=true 去掉这个键（只去掉 false，用户自己写的 true 不动）。
// 别的设置原样保留。返回有没有改文件
function setAutoMemory(projectDir, enabled) {
  const file = path.join(projectDir, '.claude', 'settings.local.json');
  const s = readSettings(file, null);
  if (enabled) {
    if (!s || s.autoMemoryEnabled !== false) return false;
    delete s.autoMemoryEnabled;
  } else {
    if (s && s.autoMemoryEnabled === false) return false;
    const next = { ...(s || {}), autoMemoryEnabled: false };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
    return true;
  }
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
  return true;
}

module.exports = {
  slugOf, gitRoot, memoryDir, readMemory, readNote, readNotes, noteOf, isMemFile, findDuplicates, checkDuplicate, memKey, memoryQuestion,
  removeMemory, restoreMemory, isMemoryOp, setAutoMemory, readSettings,
};
