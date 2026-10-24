'use strict';
// 解析需求树 Markdown：标题 = 节点，标题下的列表项 = 规则。
// 规则可带键 [键名]，子节点用同一个键即覆盖母节点的规则。

const STATUS = {
  '✅': 'done',
  '🔨': 'doing',
  '⏳': 'todo',
  '❓': 'question',
};
const STATUS_EMOJI = Object.fromEntries(Object.entries(STATUS).map(([e, s]) => [s, e]));
// 状态的中文名（Node 端只此一份；浏览器端在 media/detail.js）
const STATUS_LABEL = { done: '完成', doing: '进行中', todo: '待做', question: '待定' };

// 需求 ID：C2、C2.1、P
const ID_SRC = '[A-Z][A-Z0-9]*(?:\\.\\d+)*';
const ID_RE = new RegExp(`^(${ID_SRC})\\s+(.+)$`);
const ID_ONLY = new RegExp(`^${ID_SRC}$`);
const RULE_RE = /^\s*[-*]\s+(.*)$/;
const KEY_RE = /^\[([^\]]+)\]\s*(.*)$/;
// 节点对应的文件：> 文件：DataScience/ch01-*.html, DataScience/css/**
const FILES_RE = /^\s*>\s*(?:文件|files)\s*[:：]\s*(.+)$/i;
// 节点的背景文档（章节表、进度、经验）：> 文档：DataScience/_CHAPTERS.md, DataScience/项目规则与经验.md
// 不搬进规则，编译时只写一句「动手前先读」，AI 改到这个需求的文件时看到
const DOCS_RE = /^\s*>\s*(?:文档|docs?)\s*[:：]\s*(.+)$/i;
// 决定：用户拍板的做法和理由，写成以「决定：」开头的规则（「Decision:」也认）。AI 要推翻先问用户
const DECISION_RE = /^(?:决定|decision)\s*[:：]/i;

function splitStatus(text) {
  let rest = text.replace(/️/g, '').trim();
  for (const [emoji, status] of Object.entries(STATUS)) {
    if (rest.endsWith(emoji)) {
      return { rest: rest.slice(0, -emoji.length).trim(), status };
    }
  }
  return { rest, status: null };
}

function parse(text) {
  const lines = text.split(/\r?\n/);
  const root = { id: '', title: '', level: 0, line: -1, status: null, rules: [], notes: [], files: [], docs: [], children: [], parent: null };
  const stack = [root];
  let fence = null; // 代码块的围栏字符：``` 或 ~~~，只有同一种字符才能关上
  let inComment = false;

  lines.forEach((raw, i) => {
    const fm = raw.match(/^\s*(`{3,}|~{3,})/);
    if (fm) { if (!fence) fence = fm[1][0]; else if (fm[1][0] === fence) fence = null; return; }
    if (fence) return;
    if (inComment) { if (raw.includes('-->')) inComment = false; return; }
    if (/^\s*<!--/.test(raw)) { if (!raw.includes('-->')) inComment = true; return; }

    const h = raw.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const { rest, status } = splitStatus(h[2]);
      const m = rest.match(ID_RE);
      while (stack[stack.length - 1].level >= level) stack.pop();
      const parent = stack[stack.length - 1];
      const node = {
        id: m ? m[1] : null,
        title: (m ? m[2] : rest).trim(),
        level, line: i, status,
        rules: [], notes: [], files: [], docs: [], children: [], parent,
      };
      parent.children.push(node);
      stack.push(node);
      return;
    }

    const node = stack[stack.length - 1];
    const f = raw.match(FILES_RE);
    if (f && node !== root) {
      node.files.push(...splitGlobs(f[1]));
      return;
    }
    const d = raw.match(DOCS_RE);
    if (d && node !== root) {
      for (const p of splitGlobs(d[1])) if (!node.docs.includes(p)) node.docs.push(p);
      return;
    }
    const r = raw.match(RULE_RE);
    if (r && node !== root) {
      const k = r[1].match(KEY_RE);
      const text = (k ? k[2] : r[1]).trim();
      node.rules.push({ key: k ? k[1].trim() : null, text, line: i, owner: node, decision: DECISION_RE.test(text) });
    } else if (raw.trim() && node !== root) {
      node.notes.push(raw.trim());
    }
  });

  assignIds(root);
  return root;
}

// 没写 ID 的节点按位置补一个，保证每个节点都能被引用。跳过树里任何地方已经用掉的 ID
// （手写的 C3.1…C3.5 和自动补的 C3.1 撞了，编译出的 C3.1.md 会互相覆盖）
function assignIds(root) {
  const taken = new Set();
  const collect = n => n.children.forEach(c => { if (c.id) taken.add(c.id); collect(c); });
  collect(root);
  const walk = (node, prefix) => {
    node.children.forEach((c, i) => {
      if (!c.id) {
        let k = i + 1;
        const make = () => (prefix ? `${prefix}.${k}` : `N${k}`);
        while (taken.has(make())) k++;
        c.id = make(); c.autoId = true;
        taken.add(c.id);
      }
      walk(c, c.id);
    });
  };
  walk(root, '');
}

function* walk(node) {
  for (const c of node.children) { yield c; yield* walk(c); }
}

function findById(root, id) {
  for (const n of walk(root)) if (n.id === id) return n;
  return null;
}

function pathOf(node) {
  const path = [];
  for (let n = node; n && n.parent; n = n.parent) path.unshift(n);
  return path;
}

// 从根走到节点，合并沿途规则；同键的子规则覆盖母规则
function effectiveRules(node) {
  const byKey = new Map();
  const list = [];
  for (const n of pathOf(node)) {
    for (const rule of n.rules) {
      if (rule.key && byKey.has(rule.key)) {
        const old = byKey.get(rule.key);
        const idx = list.indexOf(old);
        const entry = { ...rule, overrides: old };
        list[idx] = entry;
        byKey.set(rule.key, entry);
      } else {
        const entry = { ...rule };
        list.push(entry);
        if (rule.key) byKey.set(rule.key, entry);
      }
    }
  }
  return list;
}

function check(root) {
  const problems = [];
  const seen = new Map();
  for (const n of walk(root)) {
    if (seen.has(n.id)) problems.push({ line: n.line, msg: `ID 重复：${n.id}（另见第 ${seen.get(n.id).line + 1} 行）` });
    else seen.set(n.id, n);
    const keys = new Set();
    for (const r of n.rules) {
      if (!r.key) continue;
      if (keys.has(r.key)) problems.push({ line: r.line, msg: `${n.id} 里规则键重复：[${r.key}]` });
      keys.add(r.key);
    }
  }
  return problems;
}

// 改写标题行的状态 emoji，返回新文本
function setStatusInText(text, line, status) {
  const lines = text.split(/(\r?\n)/);
  const idx = line * 2;
  const h = lines[idx].match(/^(#{1,6}\s+)(.*)$/);
  if (!h) return text;
  const { rest } = splitStatus(h[2]);
  lines[idx] = h[1] + rest + (status ? ' ' + STATUS_EMOJI[status] : '');
  return lines.join('');
}

// ---------- 编辑操作（记录员和插件共用），都按行改文本 ----------

const lineEnding = text => (text.includes('\r\n') ? '\r\n' : '\n');

// 节点"内容"的最后一行：自己的规则、文件、备注之后，第一个子标题之前
function bodyEnd(lines, node) {
  let end = node.line;
  for (let i = node.line + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) break;
    if (lines[i].trim()) end = i;
  }
  return end;
}

// 整个子树的最后一行（根节点就是全文最后一个非空行）
function subtreeEnd(lines, node) {
  let end = Math.max(node.line, 0);
  for (let i = node.line + 1; i < lines.length; i++) {
    const h = lines[i].match(/^(#{1,6})\s/);
    if (h && h[1].length <= node.level) break;
    if (lines[i].trim()) end = i;
  }
  return end;
}

// 比较规则时忽略标点、空格和大小写，免得同一句话因为一个逗号被记两遍
const norm = s => String(s || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

// 两条规则有多像（0–1）：相邻两个字的组合按 Dice 系数算重合度，2|A∩B|/(|A|+|B|)。
// 中文没有空格分词，用字对比较稳。不用 min(|A|,|B|) 做分母：那算的是「包含度」，
// 短规则「用中文」会让「用中文写注释，但变量名用英文」得满分，被误当成重复。
function similarity(a, b) {
  const grams = s => { const t = [...norm(s)], g = new Set(); for (let i = 0; i < t.length - 1; i++) g.add(t[i] + t[i + 1]); return g; };
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return norm(a) === norm(b) ? 1 : 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return (2 * hit) / (A.size + B.size);
}
// 达到这个重合度就当作同一条规则的重复说法，记录员加的新规则直接跳过。代码只拦几乎逐字的，
// 换了说法的重复交给模型。校准：「段落都不超过 4 行」/「段落不超过 4 行」0.77、
// 「每章练习题都要带解析」/「每章练习题带解析」0.75 算重复；「开场用伦敦地图」/「开场用勇士」0.4 不算。
const DUPLICATE = 0.7;

// 新需求的 ID 自动分配：P 下面沿用兄弟们的字母（C1、C2 → C3），更深的层用 上级ID.序号（C2 → C2.3）
function nextChildId(root, parent) {
  const taken = new Set([...walk(root)].map(n => n.id));
  let make;
  if (!parent.parent || !parent.parent.parent) {
    // 兄弟们最常用的字母；一样多时取先出现的
    const count = new Map();
    for (const c of parent.children) {
      const m = c.id.match(/^([A-Z]+)\d+$/);
      if (m) count.set(m[1], (count.get(m[1]) || 0) + 1);
    }
    let L = 'R', best = 0;
    for (const [letter, k] of count) if (k > best) { L = letter; best = k; }
    make = i => `${L}${i}`;
  } else make = i => `${parent.id}.${i}`;
  for (let i = parent.children.length + 1; ; i++) if (!taken.has(make(i))) return make(i);
}

// 子需求改写上级的某条规则时，两边要用同一个键。上级那条没有键就自动起一个（界面上不显示键）。
function freeKey(root) {
  const used = new Set();
  for (const n of walk(root)) for (const r of n.rules) if (r.key) used.add(r.key);
  for (let i = 1; ; i++) if (!used.has(`改写${i}`)) return `改写${i}`;
}

// 一行规则
const ruleText = (key, text) => `- ${key ? `[${key}] ` : ''}${text.trim()}`;
// 按原文找本节点的规则：先逐字，再忽略标点
function findRule(node, text) {
  if (!node) return null;
  return node.rules.find(r => r.text === text) || node.rules.find(r => norm(r.text) === norm(text)) || null;
}

// 把节点的文件对应换成 globs：删掉原来的文件行，再写一行新的
function writeFiles(lines, node, globs) {
  for (let i = bodyEnd(lines, node); i > node.line; i--) if (FILES_RE.test(lines[i])) lines.splice(i, 1);
  if (globs.length) lines.splice(node.line + 1, 0, `> 文件：${globs.join(', ')}`);
}

// 标题行里标题文字之前的部分（# 和 ID）。手写的无编号标题用的是自动 ID，行里没有 ID
const headPrefix = node => (node.autoId ? /^(#{1,6}\s+)(.*)$/ : new RegExp(`^(#{1,6}\\s+${ID_SRC}\\s+)(.*)$`));

// 一个 op 里的文字、标题、键、文件对应都只能占一行：换行压成空格，
// 免得模型或面板传来的「好\n## X 注入」凭空多出一个需求（restore_node 的 lines 本来就是多行，不动）
const ONE_LINE_FIELDS = ['text', 'old', 'new', 'title', 'key', 'from'];
const flat = s => (typeof s === 'string' ? s.replace(/[\r\n]+/g, ' ') : s);
function oneLine(op) {
  if (!op || typeof op !== 'object') return op;
  const out = { ...op };
  for (const k of ONE_LINE_FIELDS) out[k] = flat(out[k]);
  for (const k of ONE_LINE_FIELDS) if (out[k] === undefined) delete out[k];
  if (Array.isArray(out.globs)) out.globs = out.globs.map(flat);
  return out;
}

// 字面很像，意思却可能相反或换了数：「不超过 5 道」和「不超过 3 道」重合度 0.85。
// 所以「同一条」还要数字一样、否定词一样多。数字连中文数字一起算（三道 / 五道）
const numbersOf = s => (String(s).match(/[\d零一二两三四五六七八九十百千]+(?:\.\d+)?/g) || []).join(',');
const negationsOf = s => (String(s).match(/[不别没无非勿禁]/g) || []).length;
function sameMeaning(a, b) {
  return similarity(a, b) >= DUPLICATE && numbersOf(a) === numbersOf(b) && negationsOf(a) === negationsOf(b);
}

// 模型转述旧规则时可能不逐字：在本节点里找最像的一条（≥ 0.5），而且要比第二像的明显更像，不然不知道指的是哪条。
// sameNumbers：数字不同就不算（删规则时，「不超过 3 道」不能删掉「不超过 5 道」）
function fuzzyRule(node, text, { sameNumbers = false } = {}) {
  if (!node) return null;
  const cands = node.rules
    .filter(r => !sameNumbers || numbersOf(r.text) === numbersOf(text || ''))
    .map(r => ({ r, s: similarity(r.text, text || '') })).sort((a, b) => b.s - a.s);
  if (!cands[0] || cands[0].s < 0.5) return null;
  if (cands[1] && cands[1].s === cands[0].s) return null;
  return cands[0].r;
}

// 新规则和本节点或上级的某条规则像（≥ 0.7）时怎么办：
//   意思一样（数字、否定词也一样）→ 重复，跳过
//   意思不一样 → 本节点的：以最新为准改写那条（replace_rule）；上级的：在本节点覆盖它（override_rule，两边自动补同一个键）
// 返回 'duplicate'、改写后的 op，或 null（不像，照常加）
function nearRule(node, op) {
  let best = null, score = 0;
  for (let n = node; n && n.parent; n = n.parent) {
    for (const r of n.rules) {
      if (sameMeaning(r.text, op.text)) return 'duplicate';
      const s = similarity(r.text, op.text);
      if (s > score) { best = r; score = s; }
    }
  }
  if (!best || score < DUPLICATE) return null;
  if (best.owner === node) return { op: 'replace_rule', node: node.id, old: best.text, text: op.text };
  return { op: 'override_rule', node: node.id, from: best.owner.id, text: best.text, new: op.text };
}

// ops（记录员和面板共用），都直接改成最终样子：
//   {op:'add_rule', node, key?, text, index?}  新规则。本节点已有同键规则 → 改写它（记成 replace_rule）；
//                                              和本节点或上级的规则意思一样 → 跳过；字面像但数字或否定变了 → 本节点的改写、上级的覆盖（见 nearRule）。force 时都不查
//   {op:'replace_rule', node, old, text}       改写已有规则，沿用旧的键
//   {op:'remove_rule', node, text}             删除规则（原文对不上时找本节点最像且唯一的一条）
//   {op:'add_node', parent, id?, title}        新需求；没给 id 就自动分配
//   {op:'add_files', node, globs[]}            加文件对应
//   {op:'set_files', node, globs[]}            把文件对应整个换掉（面板用）
//   {op:'set_status', node, status|null}       改状态
//   {op:'rename_node', node, title}            改名（面板用）
//   {op:'delete_node', node}                   删除需求和它下面的一切（面板用）
//   {op:'override_rule', node, from, text, new} 在子需求里改写上级 from 节点的一条规则：text 是上级原文，new 是新内容
// 下面两个只出现在撤销里（反操作），不对外：
//   {op:'restore_node', parent, before, at, lines}    放回删掉的需求：放在上级下面、原来的下一个兄弟之前
//   {op:'set_key', node, text, key}                    还原 override_rule 给上级规则自动补的键
// 返回 { text, applied[], skipped[] }。每个 applied 带 undo：能把这一步撤回去的反操作。
// 做不到的操作跳过，记进 skipped：{ op, reason }，reason 见 SKIP_REASON。
// 不改调用方传进来的 op。文字、标题、键、文件对应里的换行一律压成空格（oneLine）。
function applyOps(text, ops) {
  const nl = lineEnding(text);
  const applied = [], skipped = [];
  const queue = [...(ops || [])];
  while (queue.length) {
    const op = oneLine(queue.shift());
    const skip = reason => { skipped.push({ op, reason }); };
    if (!op || typeof op !== 'object') { skipped.push({ op, reason: 'unknown-op' }); continue; }
    const lines = text.split(/\r?\n/);
    const root = parse(text);
    const node = op.node && findById(root, op.node);
    let undo, extra = {};
    if (op.op === 'add_rule') {
      if (!node) { skip('no-node'); continue; }
      if (!op.text || !op.text.trim()) { skip('empty'); continue; }
      // 一个节点里同一个键只能有一条：本节点已有同键规则就改写它，记成 replace_rule（上级有同键是覆盖，照加）。
      // 放在查重之前：「4 行」改「5 行」字面几乎一样。force（撤销、升级还原）不走这里
      const same = !op.force && op.key && node.rules.find(r => r.key === op.key);
      if (same) {
        if (same.text === op.text.trim()) { skip('same'); continue; }
        lines[same.line] = ruleText(same.key, op.text);
        text = lines.join(nl);
        applied.push({ op: 'replace_rule', node: node.id, old: same.text, text: op.text.trim(), key: same.key,
          undo: [{ op: 'replace_rule', node: node.id, old: op.text.trim(), text: same.text, key: same.key }] });
        continue;
      }
      if (!op.force) {
        const near = nearRule(node, op);
        if (near === 'duplicate') { skip('duplicate'); continue; }
        if (near) { queue.unshift(near); continue; }
      }
      const own = node.rules;
      const at = op.index != null && own[op.index] ? own[op.index].line : bodyEnd(lines, node) + 1;
      lines.splice(at, 0, ruleText(op.key, op.text));
      undo = [{ op: 'remove_rule', node: node.id, text: op.text.trim() }];
    } else if (op.op === 'replace_rule') {
      if (!node) { skip('no-node'); continue; }
      if (!op.text || !op.text.trim()) { skip('empty'); continue; }
      const old = findRule(node, op.old) || fuzzyRule(node, op.old);
      if (!old) { skip('no-rule'); continue; }
      if (old.text === op.text.trim()) { skip('same'); continue; }
      const key = op.key || old.key;
      lines[old.line] = ruleText(key, op.text);
      undo = [{ op: 'replace_rule', node: node.id, old: op.text.trim(), text: old.text, key: old.key }];
    } else if (op.op === 'remove_rule') {
      if (!node) { skip('no-node'); continue; }
      const rule = findRule(node, op.text) || fuzzyRule(node, op.text, { sameNumbers: true });
      if (!rule) { skip('no-rule'); continue; }
      lines.splice(rule.line, 1);
      undo = [{ op: 'add_rule', node: node.id, key: rule.key, text: rule.text, index: node.rules.indexOf(rule), force: true }];
      extra = rule.text !== op.text ? { text: rule.text } : {};
    } else if (op.op === 'add_node') {
      const parent = op.parent ? findById(root, op.parent) : root.children[0];
      if (!parent) { skip('no-node'); continue; }
      if (!op.title || !op.title.trim()) { skip('empty'); continue; }
      const id = op.id || nextChildId(root, parent);
      if (findById(root, id) || !ID_ONLY.test(id)) { skip('bad-id'); continue; }
      lines.splice(subtreeEnd(lines, parent) + 1, 0, '', `${'#'.repeat(Math.min(parent.level + 1, 6))} ${id} ${op.title.trim()}`);
      extra = { id };
      undo = [{ op: 'delete_node', node: id }];
    } else if (op.op === 'add_files') {
      if (!node) { skip('no-node'); continue; }
      const globs = (op.globs || []).filter(g => g && !node.files.includes(g));
      if (!globs.length) { skip('same'); continue; }
      // 文件对应写在标题正下方
      lines.splice(node.line + 1, 0, `> 文件：${globs.join(', ')}`);
      undo = [{ op: 'set_files', node: node.id, globs: node.files }];
    } else if (op.op === 'set_files') {
      if (!node) { skip('no-node'); continue; }
      const globs = [...new Set((op.globs || []).filter(Boolean))];
      if (globs.join('\n') === node.files.join('\n')) { skip('same'); continue; }
      writeFiles(lines, node, globs);
      undo = [{ op: 'set_files', node: node.id, globs: node.files }];
    } else if (op.op === 'set_status') {
      const status = op.status || null;
      if (!node) { skip('no-node'); continue; }
      if (status && !(status in STATUS_EMOJI)) { skip('bad-status'); continue; }
      if (node.status === status) { skip('same'); continue; }
      lines[node.line] = setStatusInText(lines[node.line], 0, status);
      undo = [{ op: 'set_status', node: node.id, status: node.status }];
    } else if (op.op === 'rename_node') {
      if (!node) { skip('no-node'); continue; }
      if (!op.title || !op.title.trim()) { skip('empty'); continue; }
      if (node.title === op.title.trim()) { skip('same'); continue; }
      const h = lines[node.line].match(headPrefix(node));
      if (!h) { skip('no-node'); continue; }
      const tail = node.status ? ' ' + STATUS_EMOJI[node.status] : '';
      lines[node.line] = h[1] + op.title.trim() + tail;
      undo = [{ op: 'rename_node', node: node.id, title: node.title }];
    } else if (op.op === 'delete_node') {
      if (!node) { skip('no-node'); continue; }
      const end = subtreeEnd(lines, node);
      const start = node.line > 0 && !lines[node.line - 1].trim() ? node.line - 1 : node.line;
      const removed = lines.splice(start, end - start + 1);
      // 撤销时按「上级 + 下一个兄弟」放回，不按行号：删除之后上面可能又多了规则，行号就错了。
      // 下一个兄弟的 ID 要在删除后的树里取：没写编号的兄弟，自动 ID 会因为删除而变
      const sibs = node.parent.children;
      const next = sibs[sibs.indexOf(node) + 1];
      let before = null;
      if (next) {
        const moved = [...walk(parse(lines.join(nl)))].find(n => n.line === next.line - removed.length);
        before = moved ? moved.id : null;
      }
      undo = [{ op: 'restore_node', parent: node.parent.id, before, at: start, lines: removed }];
    } else if (op.op === 'restore_node') {
      const parent = op.parent ? findById(root, op.parent) : root;
      const next = op.before && findById(root, op.before);
      let at;
      if (parent && next && next.parent === parent) at = next.line > 0 && !lines[next.line - 1].trim() ? next.line - 1 : next.line;
      else if (parent) at = subtreeEnd(lines, parent) + 1;
      else at = Math.min(op.at, lines.length); // 上级也没了：只能按原来的行号
      lines.splice(at, 0, ...op.lines);
      undo = [];
    } else if (op.op === 'override_rule') {
      const from = findById(root, op.from);
      const base = findRule(from, op.text);
      if (!node || !from) { skip('no-node'); continue; }
      if (!base) { skip('no-rule'); continue; }
      if (!op.new || !op.new.trim()) { skip('empty'); continue; }
      let key = base.key;
      undo = [];
      if (!key) {
        key = freeKey(root);
        lines[base.line] = lines[base.line].replace(/^(\s*[-*]\s+)/, `$1[${key}] `);
        undo.push({ op: 'set_key', node: from.id, text: base.text, key: null });
      }
      // 已经改写过同一条：改那一条，不再加第二条同键的规则
      const prev = node.rules.find(r => r.key === key);
      if (prev) {
        if (prev.text === op.new.trim()) { skip('same'); continue; }
        lines[prev.line] = ruleText(key, op.new);
        undo.unshift({ op: 'replace_rule', node: node.id, old: op.new.trim(), text: prev.text, key });
      } else {
        lines.splice(bodyEnd(lines, node) + 1, 0, ruleText(key, op.new));
        undo.unshift({ op: 'remove_rule', node: node.id, text: op.new.trim() });
      }
    } else if (op.op === 'set_key') {
      const r = findRule(node, op.text);
      if (!r) { skip('no-rule'); continue; }
      if (r.key === (op.key || null)) { skip('same'); continue; }
      lines[r.line] = lines[r.line].replace(/^(\s*[-*]\s+)(?:\[[^\]]*\]\s*)?/, `$1${op.key ? `[${op.key}] ` : ''}`);
      undo = [];
    } else { skip('unknown-op'); continue; }
    text = lines.join(nl);
    applied.push({ ...op, ...extra, undo });
  }
  return { text, applied, skipped };
}
// 跳过的原因（中文，记录员的日志和状态用；界面上的提示另见 strings.js 的 x.nc.*）
const SKIP_REASON = {
  'no-node': '找不到这个需求', 'no-rule': '找不到这条规则', empty: '内容是空的', same: '和现在一样',
  duplicate: '已经有意思一样的规则', 'bad-id': '编号不合法或已被占用', 'bad-status': '状态不认识', 'unknown-op': '不认识的操作',
  'not-allowed': '记录员不许做这种改动', 'no-basis': '文件对应没有根据', blocked: '树里对应的改动没写进去，记忆先留着',
};

// 面板「打开原文」按行号跳转，但点击前文件可能被记录员改过。expect 是当时那一行的内容：
// 对得上就用原行号，对不上就按内容找最近的一处；找不到返回 -1（调用方退回原行号）。
function relocate(text, line, expect) {
  if (expect == null) return line;
  const lines = text.split(/\r?\n/);
  if (lines[line] === expect) return line;
  const hits = lines.map((l, i) => (l === expect ? i : -1)).filter(i => i >= 0);
  if (!hits.length) return -1;
  return hits.reduce((best, i) => (Math.abs(i - line) < Math.abs(best - line) ? i : best));
}

// 树太大时给记录员的精简版：所有标题都保留（方便挂新规则），
// 只有根节点、keepIds 及其祖先保留规则原文（方便删除和改写）
function outline(text, keepIds) {
  const root = parse(text);
  const keep = new Set();
  for (const id of keepIds || []) {
    const n = findById(root, id);
    if (n) pathOf(n).forEach(p => keep.add(p));
  }
  if (root.children[0]) keep.add(root.children[0]);
  const lines = text.split(/\r?\n/);
  const out = [];
  for (const n of walk(root)) {
    out.push(lines[n.line]);
    if (keep.has(n)) {
      for (let i = n.line + 1; i <= bodyEnd(lines, n); i++) if (lines[i].trim()) out.push(lines[i]);
    } else if (n.rules.length) out.push(`（${n.rules.length} 条规则未列出）`);
  }
  return out.join('\n');
}

// glob 片段 → 正则片段。支持 **、*、?、{a,b}（可嵌套；没配对的花括号按普通字符）
function globBody(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      // "**/" 匹配零或多层目录；结尾的 "**" 匹配任意
      if (glob[i + 1] === '/') { re += '(?:.*/)?'; i++; } else re += '.*';
    }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') {
      // 找配对的 }，按顶层逗号分成几个选项
      let depth = 0, j = i, parts = [], from = i + 1;
      for (; j < glob.length; j++) {
        if (glob[j] === '{') depth++;
        else if (glob[j] === '}' && --depth === 0) break;
        else if (glob[j] === ',' && depth === 1) { parts.push(glob.slice(from, j)); from = j + 1; }
      }
      if (j >= glob.length) { re += '\\{'; continue; }
      parts.push(glob.slice(from, j));
      re += `(?:${parts.map(globBody).join('|')})`;
      i = j;
    }
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return re;
}
function globToRegExp(glob) {
  // Windows 和 macOS 的文件系统默认不分大小写，Linux 区分
  return new RegExp('^' + globBody(glob) + '$', process.platform === 'win32' || process.platform === 'darwin' ? 'i' : '');
}

// 「> 文件：」一行拆成几个 glob：按逗号和空白拆，花括号里的逗号不拆（{ch18,ch19}-*.html 是一个 glob）
function splitGlobs(s) {
  const out = [];
  let cur = '', depth = 0;
  for (const c of s) {
    if (c === '{') depth++;
    else if (c === '}' && depth) depth--;
    if (!depth && /[,，\s]/.test(c)) { if (cur) out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

// 找出管这个文件的最深节点；relPath 用 / 分隔、相对于树文件所在目录
// 文件属于哪些需求：自己的文件对应匹配上的全部节点，从浅到深。按内容分的需求（某门课）和按文件类型横切的需求（「写作」）可以同时命中
function nodesForFile(root, relPath) {
  const out = [];
  for (const n of walk(root)) if (n.files.some(g => globToRegExp(g).test(relPath))) out.push(n);
  return out.sort((a, b) => a.level - b.level);
}

// 最深的那一个（面板上「AI 正在改」显示它）
function nodeForFile(root, relPath) {
  let best = null;
  for (const n of walk(root)) {
    if (n.files.some(g => globToRegExp(g).test(relPath))) {
      if (!best || n.level > best.level) best = n;
    }
  }
  return best;
}

module.exports = {
  STATUS_EMOJI, STATUS_LABEL, parse, walk, findById, pathOf, effectiveRules, check,
  DECISION_RE, nextChildId, setStatusInText, nodeForFile, nodesForFile, applyOps, outline, relocate, splitGlobs, globToRegExp,
  oneLine, norm, sameMeaning, numbersOf, SKIP_REASON,
  similarity, DUPLICATE, // 测试校准去重门槛用
};
