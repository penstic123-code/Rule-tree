'use strict';
// 用户这句话明确提到了哪些需求，以及把它们的规则写成一段补充上下文。
// 为什么要有：路径规则只在 AI 读写匹配的文件时才加载，动手之前的讨论（「第3章怎么设计」）手里还没有规则。
// 只做便宜的字面匹配，不调用模型：
// - 标题子串：标题至少 2 个字、整段出现在这句话里（根节点除外，根节点的规则本来就全局加载）
// - 编号：手写的 ID（C2.1、R3）作为独立的词出现
// - 章节号：「第3章」「第三章」「chapter 3」「ch03」↔ 标题里同一个章号，或文件对应里的 ch03
// 标题重名（两门课都有「第1章」）时，优先这句话里也提到了上级的；都没提就都给（最多 MAX 个）。
// 同时匹配上级和下级时只给下级：下级那段已经带上了上级的规则。
const { walk, pathOf } = require('./parser');

const MAX_NODES = 3;
const MAX_CHARS = 1500;
const isRoot = n => !n.parent || !n.parent.parent;

const CN = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
// 「十二」「二十三」这种到 99 为止
function cnNumber(s) {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  const m = s.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? CN[m[1]] : 1) * 10 + (m[2] ? CN[m[2]] : 0);
  return s.length === 1 && s in CN ? CN[s] : null;
}
// 一段文字里提到的章号
function chapterNumbers(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/第\s*([0-9]+|[零一二两三四五六七八九十]{1,3})\s*[章课节篇关]/g)) { const n = cnNumber(m[1]); if (n != null) out.add(n); }
  for (const m of String(text).matchAll(/\b(?:chapter|ch|lesson|level)[\s._-]*0*([0-9]+)/gi)) out.add(Number(m[1]));
  return out;
}
const fileChapters = files => {
  const out = new Set();
  for (const f of files) for (const m of f.matchAll(/(?:^|[/_-])(?:ch|chapter|lesson|level)[_-]?0*([0-9]+)/gi)) out.add(Number(m[1]));
  return out;
};

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function mentionedNodes(root, prompt, { max = MAX_NODES } = {}) {
  const text = String(prompt || '');
  if (!text.trim()) return [];
  const chapters = chapterNumbers(text);
  const hits = [];
  for (const n of walk(root)) {
    if (isRoot(n)) continue;
    const title = n.title.trim();
    let how = null;
    if (title.length >= 2 && text.includes(title)) how = 'title';
    else if (!n.autoId && n.id && new RegExp(`(^|[^A-Za-z0-9.])${escapeRe(n.id)}(?![A-Za-z0-9]|\\.[0-9])`).test(text)) how = 'id';
    else if (chapters.size) {
      const own = new Set([...chapterNumbers(title), ...fileChapters(n.files)]);
      if ([...own].some(c => chapters.has(c))) how = 'chapter';
    }
    if (how) hits.push({ node: n, how });
  }
  // 上级的标题（或编号）也在这句话里提到的，算更确定
  const ancestorMentioned = n => pathOf(n).slice(0, -1).some(a => !isRoot(a) && hits.some(h => h.node === a));
  let nodes = hits.map(h => h.node);
  // 同时命中上级和下级：只留下级
  nodes = nodes.filter(n => !nodes.some(o => o !== n && pathOf(o).includes(n)));
  // 重名（同一个标题或同一个章号命中多处）：有上级被提到的优先
  const sure = nodes.filter(ancestorMentioned);
  if (sure.length) {
    const sureTitles = new Set(sure.map(n => n.title));
    nodes = nodes.filter(n => sure.includes(n) || !sureTitles.has(n.title) && !hits.some(h => h.node === n && h.how === 'chapter'));
  }
  // 还有重名、上级也都没提：优先正在做（自己或上级 🔨）的那门
  const active = n => pathOf(n).some(a => a.status === 'doing');
  const groups = new Map();
  for (const n of nodes) { const k = n.title; groups.set(k, [...(groups.get(k) || []), n]); }
  nodes = nodes.filter(n => {
    const g = groups.get(n.title);
    return g.length < 2 || !g.some(active) || active(n);
  });
  return nodes.slice(0, max);
}

// 节点生效的规则（不含根节点的：根节点规则全局加载），加上它下面没写文件的子需求（它们沿用这个范围，改到这些文件时也会加载）
function overrideNote(node, rule) {
  if (!rule.key) return '';
  for (let p = node.parent; p && p.parent; p = p.parent) {
    const hit = p.rules.find(x => x.key === rule.key);
    if (hit) return `（在本范围内以此为准，取代上级 ${hit.owner.id} 的「${hit.text}」）`;
  }
  return '';
}
function renderNode(node) {
  const chain = pathOf(node);
  const lines = [`## 需求 ${chain.map(n => `${n.id} ${n.title}`).join(' → ')}`];
  const scope = chain.slice().reverse().find(n => n.files.length);
  if (scope) lines.push(`适用文件：${scope.files.join('、')}`);
  // 上级（不含根）的规则，被下级同键覆盖的不列
  const keys = new Set(node.rules.filter(r => r.key).map(r => r.key));
  for (const a of chain.slice(0, -1)) {
    if (isRoot(a)) continue;
    for (const r of a.rules) if (!(r.key && keys.has(r.key))) lines.push(`- ${r.text}（来自上级 ${a.id}）`);
  }
  const visit = (n, own) => {
    if (n.rules.length && !own) lines.push(`### ${n.id} ${n.title}`);
    for (const r of n.rules) lines.push(`- ${r.text}${overrideNote(n, r)}`);
    for (const c of n.children) if (!c.files.length) visit(c, false);
  };
  visit(node, true);
  return lines.length > (scope ? 2 : 1) ? lines.join('\n') : '';
}

// 给 hook 用：没送过的被提到的需求 → { text, ids }；sent 是 { id: 内容哈希 }（同一会话送过且内容没变的不再送）
function mentionContext(root, prompt, sent = {}, hash = s => s) {
  const blocks = [], ids = [];
  let size = 0;
  for (const n of mentionedNodes(root, prompt)) {
    const body = renderNode(n);
    if (!body || sent[n.id] === hash(body)) continue;
    if (size + body.length > MAX_CHARS && blocks.length) break;
    const cut = body.length > MAX_CHARS ? body.slice(0, MAX_CHARS) + '\n…（规则太多，其余见需求树）' : body;
    blocks.push(cut); ids.push({ id: n.id, hash: hash(body) });
    size += cut.length;
  }
  if (!blocks.length) return null;
  return { ids, text: `需求树：用户这句话提到了下面的需求，这是它们现在的规则（改到对应文件时也会自动加载）。\n\n${blocks.join('\n\n')}` };
}

module.exports = { mentionedNodes, renderNode, mentionContext, chapterNumbers, MAX_CHARS, MAX_NODES };
