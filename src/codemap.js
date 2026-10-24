'use strict';
// 代码地图：让 AI 改某块代码之前知道这块已经有什么、依赖哪些公共模块，不重复造轮子、不写冲突的代码。
// 设计见 设计-信息架构.md 第五节。用正则读结构（不装 tree-sitter、不调用模型）：
// aider 的 repo map 和 graphify 都不支持 GDScript，而 Godot 项目正是最需要这张图的。
//
// 输出（每份有字数上限，内容没变不重写，免得触发「文件已变更」通知）：
//   Claude：.claude/rules/reqtree/map-<ID>.md（和需求同样的 paths，原生按需加载）、_map.md（全局，每次加载）
//   Codex：.reqtree/map/<ID>.md、_map.md（AGENTS.md 的托管块里告诉 AI 去读）
// 命令行：node src/codemap.js map <项目目录>       重建
//         node src/codemap.js who <名字或文件> [目录]  某个名字在哪定义、谁在用；某个文件被谁用
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MAX_FILE_BYTES = 300 * 1024;
const MAX_FILES = 20000;
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.next', 'dist', 'build', 'target', 'Library', '.godot',
  '.gradle', '.reqtree', '.claude', '.codex', 'coverage', 'vendor', '.import', 'bower_components']);
const CODE_RE = /\.(gd|tscn|js|mjs|cjs|jsx|ts|tsx|py|cs|go|rs|java|kt|swift|rb|php|c|cc|cpp|h|hpp|lua|html?|vue|svelte)$/i;
// 按名字引用只认够独特的名字：太常见的（init、render）到处都是，算进去全是误报
const COMMON_NAMES = new Set(['init', 'main', 'setup', 'reset', 'start', 'stop', 'update', 'render', 'draw', 'load', 'save', 'show', 'hide',
  'open', 'close', 'clear', 'toggle', 'apply', 'build', 'create', 'remove', 'add', 'get', 'set', 'run', 'tick', 'step', 'next', 'prev',
  'handle', 'parse', 'format', 'test', 'mount', 'destroy', 'refresh', 'resize', 'enter', 'exit', 'ready', 'process', 'value', 'data']);

const MAP_CHARS = 2400;
const GLOBAL_CHARS = 1600;
const MAP_MARK = '<!-- reqtree:codemap -->';
const clip = (s, n) => { const a = [...String(s)]; return a.length > n ? a.slice(0, n - 1).join('') + '…' : String(s); };

// ---------- 列文件 ----------
function listFiles(dir) {
  let files = null;
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: dir, encoding: 'utf8', windowsHide: true, maxBuffer: 256 << 20, timeout: 20000 });
  if (r.status === 0 && typeof r.stdout === 'string') files = r.stdout.split('\0').filter(Boolean);
  if (!files) {
    files = [];
    const stack = [''];
    while (stack.length && files.length < MAX_FILES * 4) {
      const rel = stack.pop();
      let ents = [];
      try { ents = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(p); } else files.push(p);
      }
    }
  }
  // Godot 的 addons/ 多半是第三方插件
  const godot = files.some(f => /(^|\/)project\.godot$/.test(f));
  return files.filter(f => (CODE_RE.test(f) || /(^|\/)project\.godot$/.test(f)) && !/\.min\.js$/i.test(f)
    && !f.split('/').slice(0, -1).some(p => SKIP_DIRS.has(p) || (godot && p === 'addons'))).slice(0, MAX_FILES);
}

// ---------- 每种语言的读法 ----------
// 返回 { summary 一句说明, defs [{ name, kind, line, sig, pub }], globals 全局可用的名字, members { 全局名: [成员] },
//        paths 按路径引用的（原样，之后解析）, emits / listens 发出、监听的信号 }
const blank = () => ({ summary: '', defs: [], globals: [], members: {}, paths: [], emits: [], listens: [] });
const firstText = s => (s || '').split(/\r?\n/).map(l => l.replace(/^\s*(\/\*+|\*+\/?|\/\/+|#+|"""|''')\s?/, '').replace(/\*\/\s*$/, '').trim()).find(l => l && !/^[-=*#/ ]+$/.test(l)) || '';

function readGd(text) {
  const out = blank();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    const m = lines[i].match(/^##\s?(.*)$/);
    if (m && m[1].trim()) { out.summary = m[1].trim(); break; }
    const t = lines[i].trim();
    if (t && !/^(extends|class_name|@tool|@icon|@static_unload|#)/.test(t)) break;
  }
  lines.forEach((l, i) => {
    let m;
    if ((m = l.match(/^class_name\s+([A-Za-z_]\w*)/))) { out.defs.push({ name: m[1], kind: 'class', line: i + 1, pub: true }); out.globals.push(m[1]); }
    else if ((m = l.match(/^(?:static\s+)?func\s+([A-Za-z_]\w*)\s*\(/))) out.defs.push({ name: m[1], kind: 'func', line: i + 1, sig: l.replace(/:\s*(#.*)?$/, '').trim(), pub: !m[1].startsWith('_') });
    else if ((m = l.match(/^signal\s+([A-Za-z_]\w*)/))) out.defs.push({ name: m[1], kind: 'signal', line: i + 1, sig: l.trim(), pub: true });
    else if ((m = l.match(/^extends\s+"(res:\/\/[^"]+)"/))) out.paths.push(m[1]);
    for (const p of l.matchAll(/(?:preload|load)\(\s*"(res:\/\/[^"]+)"/g)) out.paths.push(p[1]);
    for (const s of l.matchAll(/\b([A-Z]\w*)\.([a-z_]\w*)\.(emit|connect)\s*\(/g)) (s[3] === 'emit' ? out.emits : out.listens).push(`${s[1]}.${s[2]}`);
  });
  return out;
}

function readTscn(text) {
  const out = blank();
  const n = text.match(/^\[node name="([^"]+)" type="([^"]+)"/m);
  if (n) out.summary = `场景 ${n[1]}（${n[2]}）`;
  for (const m of text.matchAll(/^\[ext_resource [^\]]*path="(res:\/\/[^"]+\.(?:gd|tscn))"/gm)) out.paths.push(m[1]);
  return out;
}

// JS / TS：顶层（含立即执行函数里第一层，缩进不超过 2 个空格）的函数、类、导出；window.X = … 算全局
function readJs(text) {
  const out = blank();
  const lead = text.match(/^\s*(\/\*[\s\S]*?\*\/|(?:\s*\/\/[^\n]*\n)+)/);
  out.summary = lead ? firstText(lead[1]) : '';
  const lines = text.split(/\r?\n/);
  const defRe = [
    /^\s{0,2}export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
    /^\s{0,2}export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /^\s{0,2}export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
    /^\s{0,2}(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
    /^\s{0,2}class\s+([A-Za-z_$][\w$]*)/,
    /^\s{0,2}(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
  ];
  lines.forEach((l, i) => {
    for (const re of defRe) {
      const m = l.match(re);
      if (m) { out.defs.push({ name: m[1], kind: /class\s/.test(l) ? 'class' : 'func', line: i + 1, sig: clip(l.trim().replace(/\s*\{\s*$/, ''), 90), pub: !m[1].startsWith('_') }); break; }
    }
    for (const m of l.matchAll(/(?:require\(\s*|import\s*\(\s*|from\s+|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) out.paths.push(m[1]);
  });
  // window.X = Y：Y 是同一文件里的对象字面量时，它的键就是 X 的成员
  for (const m of text.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*|\{)/g)) {
    const g = m[1];
    if (!out.globals.includes(g)) out.globals.push(g);
    const body = m[2] === '{' ? objectBody(text, m.index + m[0].length - 1) : objectBody(text, findObject(text, m[2]));
    if (body) out.members[g] = objectKeys(body);
  }
  const me = text.match(/module\.exports\s*=\s*\{/);
  if (me) out.members.exports = objectKeys(objectBody(text, me.index + me[0].length - 1) || '');
  return out;
}
function findObject(text, name) {
  const m = new RegExp(`(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\s*=\\s*\\{`).exec(text);
  return m ? m.index + m[0].length - 1 : -1;
}
// 从 { 开始找到配对的 }，返回中间的文字（不管字符串里的括号，够用）
function objectBody(text, at) {
  if (at < 0 || text[at] !== '{') return null;
  let depth = 0;
  for (let i = at; i < text.length && i < at + 20000; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(at + 1, i);
  }
  return null;
}
// 对象字面量第一层的键：a、b: …、c() {…}
function objectKeys(body) {
  const keys = [];
  let depth = 0, cur = '';
  for (const ch of body + ',') {
    if ('{[('.includes(ch)) depth++;
    else if ('}])'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      const m = cur.replace(/\/\/[^\n]*/g, '').trim().match(/^(?:async\s+)?\*?\s*([A-Za-z_$][\w$]*)/);
      if (m && !keys.includes(m[1])) keys.push(m[1]);
      cur = '';
    } else if (depth === 0 || !'{[('.includes(ch)) cur += depth === 0 ? ch : '';
  }
  return keys;
}

function readPy(text) {
  const out = blank();
  const doc = text.match(/^\s*(?:#![^\n]*\n)?\s*(?:"""([\s\S]*?)"""|'''([\s\S]*?)'''|((?:#[^\n]*\n)+))/);
  out.summary = doc ? firstText(doc[1] || doc[2] || doc[3]) : '';
  text.split(/\r?\n/).forEach((l, i) => {
    const m = l.match(/^(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/);
    if (m) out.defs.push({ name: m[2], kind: m[1] === 'class' ? 'class' : 'func', line: i + 1, sig: clip(l.trim().replace(/:\s*$/, ''), 90), pub: !m[2].startsWith('_') });
  });
  return out;
}

function readHtml(text) {
  const out = blank();
  const t = text.match(/<title[^>]*>([^<]*)<\/title>/i);
  out.summary = t ? t[1].trim() : '';
  for (const m of text.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"'#?]+\.(?:js|mjs|css))["']/gi)) if (!/^(https?:)?\/\//.test(m[1])) out.paths.push(m[1]);
  return out;
}

// 其他语言：常见的定义关键字
function readGeneric(text) {
  const out = blank();
  const lines = text.split(/\r?\n/);
  out.summary = firstText(lines.slice(0, 6).filter(l => /^\s*(\/\/|#|\/\*|\*|--)/.test(l)).join('\n'));
  lines.forEach((l, i) => {
    const m = l.match(/^\s{0,4}(?:pub(?:\([^)]*\))?\s+|public\s+|export\s+|static\s+|async\s+|override\s+|virtual\s+|abstract\s+|sealed\s+|partial\s+|internal\s+)*(?:func|fn|def|function|class|struct|interface|enum|trait|record|object)\s+([A-Za-z_]\w*)/);
    if (m) out.defs.push({ name: m[1], kind: /class|struct|interface|enum|trait|record|object/.test(l) ? 'class' : 'func', line: i + 1, sig: clip(l.trim().replace(/\s*\{\s*$/, ''), 90), pub: !m[1].startsWith('_') && !/\bprivate\b/.test(l) });
  });
  return out;
}

const ADAPTERS = [
  [/\.gd$/i, readGd], [/\.tscn$/i, readTscn], [/\.(js|mjs|cjs|jsx|ts|tsx|vue|svelte)$/i, readJs],
  [/\.py$/i, readPy], [/\.html?$/i, readHtml], [/./, readGeneric],
];

// ---------- 建图 ----------
// 返回 { files: Map<rel, info>, refs: Map<rel, Set<引用它的 rel>>, memberUse: Map<rel, Map<成员, 用到的文件数>>, defUse: Map<名字, 文件数>, autoloads }
function build(projectDir) {
  const list = listFiles(projectDir);
  const files = new Map();
  // Godot：res:// 指 project.godot 所在的文件夹；自动加载的单例按名字全局可用
  const godotRoots = list.filter(f => /(^|\/)project\.godot$/.test(f)).map(f => path.posix.dirname(f)).map(d => (d === '.' ? '' : d));
  const autoloads = new Map(); // 文件 → 名字
  for (const r of godotRoots) {
    let t = '';
    try { t = fs.readFileSync(path.join(projectDir, r, 'project.godot'), 'utf8'); } catch {}
    const sec = t.match(/^\[autoload\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m);
    if (sec) for (const m of sec[1].matchAll(/^([A-Za-z_]\w*)\s*=\s*"\*?res:\/\/([^"]+)"/gm)) autoloads.set(path.posix.join(r, m[2]), m[1]);
  }
  const resolve = (from, p) => {
    if (p.startsWith('res://')) {
      const root = godotRoots.filter(r => !r || from.startsWith(r + '/')).sort((a, b) => b.length - a.length)[0] || '';
      return path.posix.join(root, p.slice(6));
    }
    return path.posix.normalize(path.posix.join(path.posix.dirname(from), p));
  };
  const texts = new Map();
  for (const rel of list) {
    if (/project\.godot$/.test(rel)) continue;
    let text;
    try {
      const st = fs.statSync(path.join(projectDir, rel));
      if (st.size > MAX_FILE_BYTES) continue;
      text = fs.readFileSync(path.join(projectDir, rel), 'utf8');
    } catch { continue; }
    const info = ADAPTERS.find(([re]) => re.test(rel))[1](text);
    const al = autoloads.get(rel);
    if (al) { info.globals.unshift(al); info.members[al] = info.defs.filter(d => d.pub && d.kind !== 'class').map(d => d.name); }
    info.paths = [...new Set(info.paths.map(p => resolve(rel, p)))];
    files.set(rel, info);
    texts.set(rel, text);
  }
  // JS 的相对引用常省略扩展名
  const exists = p => files.has(p) ? p : ['.js', '.ts', '.mjs', '/index.js', '/index.ts'].map(e => p + e).find(x => files.has(x)) || null;

  // 名字 → 定义它的文件。
  // 全局名（单例、class_name、window.X）：几处都定义了同一个名字（每门课各有一个 window.ILLUS）时，算到离引用处最近的那个。
  // 普通的对外名字只在「不用 import 就能互相调用」的代码里认（浏览器里直接加载的脚本、C#/Go 这类同一命名空间的语言），
  // 而且要够长、全项目只有一处定义、用法是调用（名字后面跟括号）；ES 模块、Python、GDScript 靠 import 和全局名就够了
  const globalOwners = new Map(), uniqueOwner = new Map(), defCount = new Map();
  for (const [rel, info] of files) {
    for (const g of info.globals) { if (!globalOwners.has(g)) globalOwners.set(g, []); globalOwners.get(g).push(rel); }
    for (const d of info.defs) if (d.pub && d.kind !== 'signal') defCount.set(d.name, (defCount.get(d.name) || 0) + 1);
  }
  const looseNames = rel => !/\.(gd|py|tscn)$/i.test(rel) && !(/\.(js|mjs|cjs|jsx|ts|tsx|vue|svelte)$/i.test(rel) && /^\s*(import|export)\s/m.test(texts.get(rel)));
  for (const [rel, info] of files) {
    if (!looseNames(rel)) continue;
    for (const d of info.defs) {
      if (!d.pub || d.kind === 'signal' || [...d.name].length < 6 || COMMON_NAMES.has(d.name.toLowerCase()) || defCount.get(d.name) > 1) continue;
      if (!uniqueOwner.has(d.name)) uniqueOwner.set(d.name, rel);
    }
  }
  const top = f => f.includes('/') ? f.slice(0, f.indexOf('/')) : '';
  const shared = (a, b) => { const x = a.split('/'), y = b.split('/'); let n = 0; while (n < x.length - 1 && n < y.length - 1 && x[n] === y[n]) n++; return n; };
  // 全局名只在同一种运行环境里算：Godot 的在 .gd/.tscn 之间，浏览器的 window.X 在 JS/HTML 之间、而且同一个顶层文件夹里
  // （每门课各自加载自己的脚本，别的课里出现同名的是它自己的东西）
  const family = f => /\.(gd|tscn)$/i.test(f) ? 'godot' : /\.(js|mjs|cjs|jsx|ts|tsx|vue|svelte|html?)$/i.test(f) ? 'web' : path.posix.extname(f);
  const reachable = (owner, from) => family(owner) === family(from) && (family(owner) !== 'web' || !top(owner) || top(owner) === top(from));
  const pickOwner = (name, from, member) => {
    let cands = (globalOwners.get(name) || []).filter(f => f !== from && reachable(f, from));
    if (!cands.length) return null;
    if (cands.length > 1 && member) { const has = cands.filter(f => (files.get(f).members[name] || []).includes(member)); if (has.length) cands = has; }
    if (cands.length === 1) return cands[0];
    const best = Math.max(...cands.map(f => shared(f, from)));
    const near = cands.filter(f => shared(f, from) === best);
    return near.length === 1 ? near[0] : null;
  };
  // 拿来找名字的正文：HTML 只看内联脚本（正文里的英文单词不算）
  const codeOf = rel => {
    const t = texts.get(rel);
    if (!/\.html?$/i.test(rel)) return t;
    return [...t.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n');
  };
  const refs = new Map(), memberUse = new Map(), defUse = new Map();
  const addRef = (to, from) => { if (to === from) return; if (!refs.has(to)) refs.set(to, new Set()); refs.get(to).add(from); };
  for (const [rel, info] of files) {
    for (const p of info.paths) { const t = exists(p); if (t) addRef(t, rel); }
    const code = codeOf(rel);
    if (!code) continue;
    const usedHere = new Set();
    // 名字前面不能是点或字母（ctx.stroke 里的 stroke 不算）；带一层成员（EventBus.job_finished、DS.toast）
    for (const m of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?(\s*\()?/g)) {
      const key = m[0].replace(/\s+/g, '');
      if (usedHere.has(key)) continue;
      usedHere.add(key);
      const [, head, mem, call] = m;
      // 很短的全局名（window.M）光秃秃出现多半是别的东西（SVG 路径里的 'M'），要带成员才算
      if (globalOwners.has(head) && (mem || [...head].length >= 3)) {
        const g = pickOwner(head, rel, mem);
        if (g) {
          addRef(g, rel);
          if (mem) {
            if (!memberUse.has(g)) memberUse.set(g, new Map());
            const mu = memberUse.get(g);
            mu.set(mem, (mu.get(mem) || 0) + 1);
          }
        }
      }
      const u = !mem && call && uniqueOwner.get(head);
      if (u && u !== rel && looseNames(rel) && (top(u) === top(rel) || !top(u))) { addRef(u, rel); defUse.set(head, (defUse.get(head) || 0) + 1); }
    }
  }
  return { files, refs, memberUse, defUse, autoloads };
}

// 一个文件对外的名字，按用得多的排（单例和 window.X 显示成「名字.成员」）
function exportsOf(g, rel, n = 6) {
  const info = g.files.get(rel);
  const mu = g.memberUse.get(rel);
  const names = [];
  for (const name of info.globals) {
    const mem = (info.members[name] || []).slice();
    if (!mem.length) { names.push(name); continue; }
    if (mu) mem.sort((a, b) => (mu.get(b) || 0) - (mu.get(a) || 0));
    names.push(...mem.map(m => `${name}.${m}`));
  }
  const inMembers = new Set(Object.values(info.members).flat());
  const plain = info.defs.filter(d => d.pub && !info.globals.includes(d.name) && !inMembers.has(d.name))
    .sort((a, b) => (g.defUse.get(b.name) || 0) - (g.defUse.get(a.name) || 0));
  names.push(...plain.map(d => (d.kind === 'signal' ? `信号 ${d.name}` : d.name)));
  return names.slice(0, n).join('、') + (names.length > n ? ` 等 ${names.length} 个` : '');
}

const fileLine = (g, rel, extra = '') => {
  const info = g.files.get(rel);
  const used = (g.refs.get(rel) || new Set()).size;
  const ex = exportsOf(g, rel);
  const sum = clip(info.summary, 60).replace(/[。.；;，,：:\s]+$/, '');
  return `- \`${rel}\`${extra || (used ? `（被 ${used} 个文件用）` : '')}${sum ? ` ${sum}` : ''}${ex ? `${sum ? '。' : ' '}对外：${ex}` : ''}`;
};
const fits = (lines, max) => { let n = 0; return lines.filter(l => (n += [...l].length + 1) <= max); };

const whoHint = () => {
  const home = process.env.REQTREE_HOME || path.join(os.homedir(), '.reqtree');
  const cli = path.join(home, 'runtime', 'src', 'codemap.js');
  const rel = path.relative(os.homedir(), cli);
  const shown = !rel.startsWith('..') && !path.isAbsolute(rel) ? `~/${rel.split(path.sep).join('/')}` : cli.split(path.sep).join('/');
  return `查某个名字在哪定义、谁在用：\`node ${shown} who 名字\`（也可以是文件路径）。`;
};

// 一个需求的地图：范围里的文件按被引用次数排，列这块依赖的外部模块和收发的信号。范围里没有任何对外定义（只有页面、文档）就不出地图。
// shown：上级地图已经列过的文件，不再重复
function renderNode(g, node, scope, shown = new Set()) {
  const { globToRegExp } = require('./parser');
  const res = scope.map(globToRegExp);
  const inScope = [...g.files.keys()].filter(f => res.some(re => re.test(f)));
  if (!inScope.some(f => g.files.get(f).defs.some(d => d.pub) || g.files.get(f).globals.length)) return null;
  const inSet = new Set(inScope);
  const score = f => (g.refs.get(f) || new Set()).size;
  const mods = inScope.filter(f => !shown.has(f) && (score(f) || g.files.get(f).defs.some(d => d.pub)))
    .sort((a, b) => score(b) - score(a) || g.files.get(b).defs.length - g.files.get(a).defs.length);
  // 外部依赖：被这块的文件引用、本身不在这块里的
  const ext = new Map();
  for (const [to, from] of g.refs) {
    if (inSet.has(to) || shown.has(to)) continue;
    const n = [...from].filter(f => inSet.has(f)).length;
    if (n) ext.set(to, n);
  }
  const deps = [...ext].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  const emits = new Set(), listens = new Set();
  for (const f of inScope) { g.files.get(f).emits.forEach(s => emits.add(s)); g.files.get(f).listens.forEach(s => listens.add(s)); }
  if (!mods.length && !deps.length) return null;
  const lines = [];
  if (mods.length) lines.push('这块已有的代码（按被引用的次数排）：', ...fits(mods.slice(0, 14).map(f => fileLine(g, f)), MAP_CHARS * 0.55));
  if (deps.length) lines.push('', '这块用到的外部模块：', ...fits(deps.slice(0, 8).map(f => fileLine(g, f, `（这块有 ${ext.get(f)} 个文件用）`)), MAP_CHARS * 0.3));
  const sig = (label, set) => set.size ? `${label}：${[...set].slice(0, 12).join('、')}${set.size > 12 ? ` 等 ${set.size} 个` : ''}` : '';
  const s = [sig('发出的信号', emits), sig('监听的信号', listens)].filter(Boolean);
  if (s.length) lines.push('', ...s.map(x => clip(x, 400)));
  return { text: lines.join('\n'), files: mods.slice(0, 14).concat(deps.slice(0, 8)) };
}

// 全局地图：Godot 的自动加载单例（全局可用，最该先复用）；hubs 时再加上没被任何需求覆盖的文件里最常被引用的。
// 需求树已经按内容分好、各块有自己的地图时不列 hubs：剩下没覆盖的多半是旧版、备份，每次都加载反而是噪音
function renderGlobal(g, covered, { hubs = true } = {}) {
  const score = f => (g.refs.get(f) || new Set()).size;
  const lines = [];
  if (g.autoloads.size) {
    const names = [...g.autoloads].filter(([f]) => g.files.has(f)).sort((a, b) => score(b[0]) - score(a[0])).map(([, n]) => n);
    lines.push(clip(`自动加载的单例（全局可用，按使用多少排）：${names.join('、')}`, 700));
  }
  const top = hubs ? [...g.files.keys()].filter(f => !covered(f) && score(f) >= 3 && !g.autoloads.has(f)).sort((a, b) => score(b) - score(a)).slice(0, 12) : [];
  if (top.length) lines.push('', '最常被引用的模块：', ...top.map(f => fileLine(g, f)));
  return fits(lines, GLOBAL_CHARS).join('\n');
}

// ---------- 写文件 ----------
function writeIfChanged(file, text, written) {
  let old = null;
  try { old = fs.readFileSync(file, 'utf8'); } catch {}
  if (old === text) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  written.push(file);
}
function removeStale(dir, keep, removed, test) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!test(n) || keep.has(n)) continue;
    const p = path.join(dir, n);
    try { if (fs.readFileSync(p, 'utf8').includes(MAP_MARK)) { fs.unlinkSync(p); removed.push(p); } } catch {}
  }
}

// 重建项目的代码地图。返回 { written, removed, nodes 出了地图的需求, files 看了几个文件, ms }
function refresh(treePath, { targets } = {}) {
  const t0 = Date.now();
  const { parse, walk, pathOf, globToRegExp } = require('./parser');
  const { scopeOf, autoLoads, targetsOf } = require('./compile');
  const projectDir = path.dirname(treePath);
  const tg = targets || targetsOf(projectDir);
  const treeName = path.basename(treePath);
  const root = parse(fs.readFileSync(treePath, 'utf8'));
  const g = build(projectDir);
  const maps = new Map(); // id → { text, scope }
  const shownBy = new Map();
  const allScopes = [];
  for (const n of walk(root)) {
    if (!n.id || !n.files.length || !autoLoads(n)) continue;
    const scope = scopeOf(n);
    // 按文件类型横切的需求（*/js/**、*/ch*.html 这种，每个 glob 都以 * 开头）不出地图：它横跨各块内容，
    // 列出来是别的课、别的模块的东西，混在一起反而误导；这些文件在各自内容需求的地图里
    if (scope.every(s => s.startsWith('*'))) continue;
    allScopes.push(scope.map(globToRegExp));
    // 上级地图列过的文件不再列
    const shown = new Set();
    for (const p of pathOf(n).slice(0, -1)) for (const f of shownBy.get(p.id) || []) shown.add(f);
    const r = renderNode(g, n, scope, shown);
    if (!r) continue;
    shownBy.set(n.id, r.files);
    const where = pathOf(n).map(x => `${x.id} ${x.title}`).join(' → ');
    maps.set(n.id, { scope, body: `## 代码地图：${where}\n动手前先看这块已经有什么，能复用就复用，别重写一份；改被很多文件用的模块要小心牵动面。${whoHint()}\n\n${r.text}` });
  }
  const covered = f => allScopes.some(res => res.some(re => re.test(f)));
  const globalText = renderGlobal(g, covered, { hubs: maps.size === 0 });
  const foot = `\n\n（代码地图由 ${treeName} 的需求树插件按代码自动生成，代码改了会自动更新，不要手改。）\n`;
  const written = [], removed = [];
  const keepClaude = new Set(), keepCodex = new Set();
  if (tg.claude) {
    const dir = path.join(projectDir, '.claude', 'rules', 'reqtree');
    for (const [id, m] of maps) {
      const name = `map-${id}.md`;
      keepClaude.add(name);
      writeIfChanged(path.join(dir, name), ['---', 'paths:', ...m.scope.map(s => `  - ${JSON.stringify(s)}`), '---', MAP_MARK, m.body].join('\n') + foot, written);
    }
    if (globalText) { keepClaude.add('_map.md'); writeIfChanged(path.join(dir, '_map.md'), `${MAP_MARK}\n## 代码地图：全项目\n${whoHint()}\n\n${globalText}${foot}`, written); }
    removeStale(dir, keepClaude, removed, n => /^(map-.+|_map)\.md$/.test(n));
  }
  if (tg.codex) {
    const dir = path.join(projectDir, '.reqtree', 'map');
    for (const [id, m] of maps) { keepCodex.add(`${id}.md`); writeIfChanged(path.join(dir, `${id}.md`), `${MAP_MARK}\n适用文件：${m.scope.map(s => '`' + s + '`').join('、')}\n${m.body}${foot}`, written); }
    if (globalText) { keepCodex.add('_map.md'); writeIfChanged(path.join(dir, '_map.md'), `${MAP_MARK}\n## 代码地图：全项目\n${whoHint()}\n\n${globalText}${foot}`, written); }
    removeStale(dir, keepCodex, removed, n => n.endsWith('.md'));
  }
  const ms = Date.now() - t0;
  const first = !lastBuilt(treePath);
  try {
    const st = path.join(projectDir, '.reqtree', 'codemap.json');
    fs.mkdirSync(path.dirname(st), { recursive: true });
    fs.writeFileSync(st, JSON.stringify({ time: Date.now(), files: g.files.size, nodes: [...maps.keys()], ms }) + '\n');
  } catch {}
  // 第一次建：总目录要补上「查名字」的命令，重新编译一次
  if (first) try { require('./store').compileTree(treePath, { force: true, wait: false }); } catch {}
  return { written, removed, nodes: [...maps.keys()], files: g.files.size, ms };
}

// 上次重建是什么时候（没建过返回 0）
function lastBuilt(treePath) {
  try { return JSON.parse(fs.readFileSync(path.join(path.dirname(treePath), '.reqtree', 'codemap.json'), 'utf8')).time || 0; } catch { return 0; }
}

// ---------- 查名字 ----------
// 名字：在哪定义（文件:行、签名），谁在用（文件:行，信号分成发出 / 监听）；文件路径：它的说明、对外的名字、被谁用
function who(projectDir, q, { max = 40 } = {}) {
  const g = build(projectDir);
  const out = [];
  const asFile = [...g.files.keys()].find(f => f === q || f.endsWith('/' + q));
  if (asFile) {
    const info = g.files.get(asFile);
    out.push(`${asFile}${info.summary ? `：${info.summary}` : ''}`);
    const ex = exportsOf(g, asFile, 20);
    if (ex) out.push(`对外：${ex}`);
    const users = [...(g.refs.get(asFile) || [])].sort();
    out.push(users.length ? `被 ${users.length} 个文件用：` : '没有别的文件引用它。', ...users.slice(0, max).map(f => `  ${f}`));
    if (users.length > max) out.push(`  …还有 ${users.length - max} 个`);
    return out.join('\n');
  }
  const name = q.replace(/\(\)$/, '');
  const re = new RegExp(`(^|[^\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`);
  const defs = [];
  for (const [rel, info] of g.files) {
    for (const d of info.defs) if (d.name === name) defs.push(`  ${rel}:${d.line}  ${d.sig || d.kind}`);
    if (info.globals.includes(name)) defs.push(`  ${rel}  （全局名 ${name}）`);
  }
  out.push(defs.length ? `定义：\n${defs.join('\n')}` : `没找到「${name}」的定义（只认函数、类、信号、单例、window.X 这类）。`);
  const uses = [], emit = [], listen = [];
  for (const rel of g.files.keys()) {
    let lines;
    try { lines = fs.readFileSync(path.join(projectDir, rel), 'utf8').split(/\r?\n/); } catch { continue; }
    const hits = [];
    lines.forEach((l, i) => {
      if (!re.test(l)) return;
      if (/^\s*(static\s+)?(func|signal|class_name|def|class|function)\s/.test(l) && new RegExp(`\\b(func|signal|class_name|def|class|function)\\s+${name}\\b`).test(l)) return;
      if (new RegExp(`\\.${name}\\.emit\\s*\\(`).test(l)) emit.push(`  ${rel}:${i + 1}`);
      else if (new RegExp(`\\.${name}\\.connect\\s*\\(`).test(l)) listen.push(`  ${rel}:${i + 1}`);
      else hits.push(i + 1);
    });
    if (hits.length) uses.push(`  ${rel}:${hits.slice(0, 5).join(',')}${hits.length > 5 ? ` 等 ${hits.length} 处` : ''}`);
  }
  if (emit.length) out.push(`发出（emit）：\n${emit.slice(0, max).join('\n')}`);
  if (listen.length) out.push(`监听（connect）：\n${listen.slice(0, max).join('\n')}`);
  out.push(uses.length ? `用到它的地方（${uses.length} 个文件）：\n${uses.slice(0, max).join('\n')}${uses.length > max ? `\n  …还有 ${uses.length - max} 个文件` : ''}` : '没有别的地方用到它。');
  return out.join('\n');
}

module.exports = { listFiles, build, refresh, lastBuilt, who, whoHint, renderNode, renderGlobal, readGd, readJs, readPy, readHtml, readTscn, objectKeys, MAP_MARK };

if (require.main === module) {
  const [cmd, a, b] = process.argv.slice(2);
  const { findTreeUp } = require('./common');
  if (cmd === 'who' && a) {
    const dir = b ? path.resolve(b) : (() => { const t = findTreeUp(process.cwd()); return t ? path.dirname(t) : process.cwd(); })();
    console.log(who(dir, a));
  } else if (cmd === 'map') {
    const t = findTreeUp(path.resolve(a || process.cwd()));
    if (!t) { console.error('找不到需求树'); process.exit(1); }
    const r = refresh(t);
    console.log(`代码地图：看了 ${r.files} 个文件，${r.nodes.length} 个需求有地图，写了 ${r.written.length} 份，用时 ${r.ms} ms`);
  } else {
    console.log('用法：node codemap.js who <名字或文件> [项目目录] | map [项目目录]');
  }
}
