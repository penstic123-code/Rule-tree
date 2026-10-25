'use strict';
// 用户这句话明确提到了哪些需求，以及把它们的规则写成一段补充上下文。
// 为什么要有：路径规则只在 AI 读写匹配的文件时才加载，动手之前的讨论（「第3章怎么设计」）手里还没有规则。
// 只做便宜的字面匹配，不调用模型。只看用户自己写的话：后台通知、子 agent 回报、命令输出（<task-notification> 之类开头）
// 不算；代码块、引用行不算；只看前 500 字；超过 2000 字的多半是粘贴，整句跳过。
// - 强匹配：至少 4 个字、不是「第N章」这种的标题整段出现（比较时去掉空格：「AI课」认「AI 课」）；带点的编号（C2.1）
// - 弱匹配：章号（「第3章」「第三章」「chapter 3」「ch03」↔ 标题或文件对应里的同一章号）、「第N章」这种标题、
//   短于 4 个字的标题、短编号（C2、R3，在代码和日志里太常见）
// 弱匹配只在这几种情况下给：这句话也提到了它所属的课程（顶层需求）；整棵树只有一门课；这个会话最近在这门课上干活。
// 这句话点了某门课时，别的课里的弱匹配都不给。同时匹配上级和下级时只给下级：下级那段已经带上了上级的规则。
const { walk, pathOf, findById, overrideNote } = require('./parser');

const MAX_NODES = 3;
const MAX_CHARS = 1500;
const SCAN_CHARS = 500;
const SKIP_CHARS = 2000;
const { isRoot } = require('./common');
const Docs = require('./docs');

// 不是用户打的字：Claude Code / Codex 把后台任务通知、子 agent 回报、斜杠命令和 ! 命令的输出也当成一条 prompt 送进 UserPromptSubmit
// 标记不一定在最开头：有的版本前面先加一段「[SYSTEM NOTIFICATION - NOT USER INPUT]」之类的说明（2026-10-22 审查发现），
// 所以在开头 MACHINE_SCAN 个字里找写在一行开头的标签。用户在句子中间提到这些标签（「放一个 <task-notification> 的示例」）不算
const MACHINE = /(^|\n)\s*<(task-notification|agent-message|command-|local-command|bash-)|^\[SYSTEM NOTIFICATION/;
const MACHINE_SCAN = 300;
function isMachinePrompt(prompt) {
  let s = String(prompt || '').replace(/^\s+/, '');
  for (let m; (m = s.match(/^<system-reminder>[\s\S]*?<\/system-reminder>\s*/));) s = s.slice(m[0].length);
  return MACHINE.test(s.slice(0, MACHINE_SCAN));
}
// 用来匹配的那部分：去掉代码块和引用行，只留前 SCAN_CHARS 个字
function userText(prompt) {
  const s = String(prompt || '');
  if (s.length > SKIP_CHARS || isMachinePrompt(s)) return '';
  return s.replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, ' ').split(/\r?\n/).filter(l => !/^\s*>/.test(l)).join('\n').slice(0, SCAN_CHARS);
}

const CN = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
// 「十二」「二十三」这种到 99 为止
function cnNumber(s) {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  const m = s.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? CN[m[1]] : 1) * 10 + (m[2] ? CN[m[2]] : 0);
  return s.length === 1 && s in CN ? CN[s] : null;
}
// 一段文字里提到的章号（0 不算）
function chapterNumbers(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/第\s*([0-9]+|[零一二两三四五六七八九十]{1,3})\s*[章课节篇关]/g)) { const n = cnNumber(m[1]); if (n) out.add(n); }
  for (const m of String(text).matchAll(/\b(?:chapter|ch|lesson|level)[\s._-]*0*([0-9]+)/gi)) if (+m[1]) out.add(Number(m[1]));
  return out;
}
const fileChapters = files => {
  const out = new Set();
  for (const f of files) for (const m of f.matchAll(/(?:^|[/_-])(?:ch|chapter|lesson|level)[_-]?0*([0-9]+)/gi)) if (+m[1]) out.add(Number(m[1]));
  return out;
};

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const squash = s => String(s).replace(/\s+/g, '');
const CHAPTER_TITLE = /^(第([0-9]+|[零一二两三四五六七八九十]{1,3})[章课节篇关]|(chapter|ch|lesson|level)[._-]*[0-9]+)$/i;
// 所属课程：路径上第一个不是根的节点（顶层需求）
const courseOf = n => pathOf(n).find(a => !isRoot(a));

// opts.active：这个会话最近 AI 改过的需求 ID（用来判断「最近在哪门课上干活」）
function mentionedNodes(root, prompt, { max = MAX_NODES, active = [] } = {}) {
  const text = userText(prompt);
  if (!text.trim()) return [];
  const flat = squash(text);
  const chapters = chapterNumbers(text);
  const hits = [];
  for (const n of walk(root)) {
    if (isRoot(n)) continue;
    const t = squash(n.title);
    if (t.length >= 2 && flat.includes(t)) { hits.push({ node: n, how: 'title', weak: t.length < 4 || CHAPTER_TITLE.test(t) }); continue; }
    if (!n.autoId && n.id && new RegExp(`(^|[^A-Za-z0-9.])${escapeRe(n.id)}(?![A-Za-z0-9]|\\.[0-9])`).test(text)) { hits.push({ node: n, how: 'id', weak: !n.id.includes('.') && n.id.length < 4 }); continue; }
    if (chapters.size && [...chapterNumbers(n.title), ...fileChapters(n.files)].some(c => chapters.has(c))) hits.push({ node: n, how: 'chapter', weak: true });
  }
  // 这句话提到的课程：课程自己的标题出现了，或者课程里有强匹配
  const named = new Set(hits.filter(h => (h.how === 'title' && courseOf(h.node) === h.node) || !h.weak).map(h => courseOf(h.node)));
  const courses = [...walk(root)].filter(n => !isRoot(n) && courseOf(n) === n);
  // 章节直接挂在根下的项目（「第1章」「第2章」是顶层需求）算一门课
  const single = courses.filter(c => !CHAPTER_TITLE.test(squash(c.title))).length <= 1;
  const busy = new Set(active.map(id => findById(root, id)).filter(Boolean).map(courseOf));
  const keep = h => {
    if (!h.weak) return true;
    const c = courseOf(h.node);
    if (named.size) return named.has(c);
    return single || busy.has(c);
  };
  let nodes = [...new Set(hits.filter(keep).map(h => h.node))];
  // 同时命中上级和下级：只留下级
  nodes = nodes.filter(n => !nodes.some(o => o !== n && pathOf(o).includes(n)));
  return nodes.slice(0, max);
}

// 节点生效的规则（不含根节点的：根节点规则全局加载），加上它下面没写文件的子需求（它们沿用这个范围，改到这些文件时也会加载）
// projectDir 给了就带上这一路（不含根）挂的背景文档那一句
function renderNode(node, projectDir) {
  const chain = pathOf(node);
  const lines = [`## 需求 ${chain.map(n => `${n.id} ${n.title}`).join(' → ')}`];
  const scope = chain.slice().reverse().find(n => n.files.length);
  if (scope) lines.push(`适用文件：${scope.files.join('、')}`);
  const head = lines.length;
  if (projectDir) for (const a of chain) if (!isRoot(a) && a.docs.length) { const l = Docs.readLine(projectDir, a); if (l) lines.push(l); }
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
  return lines.length > head ? lines.join('\n') : '';
}

// 给 hook 用：没送过的被提到的需求 → { text, ids }；sent 是 { id: 内容哈希 }（同一会话送过且内容没变的不再送）
function mentionContext(root, prompt, sent = {}, hash = s => s, opts = {}) {
  const blocks = [], ids = [];
  let size = 0;
  for (const n of mentionedNodes(root, prompt, opts)) {
    const body = renderNode(n, opts.projectDir);
    if (!body || sent[n.id] === hash(body)) continue;
    if (size + body.length > MAX_CHARS && blocks.length) break;
    const cut = body.length > MAX_CHARS ? body.slice(0, MAX_CHARS) + '\n…（规则太多，其余见需求树）' : body;
    blocks.push(cut); ids.push({ id: n.id, hash: hash(body) });
    size += cut.length;
  }
  if (!blocks.length) return null;
  return { ids, text: `需求树：用户这句话提到了下面的需求，这是它们现在的规则（改到对应文件时也会自动加载）。\n\n${blocks.join('\n\n')}` };
}

module.exports = { mentionedNodes, renderNode, mentionContext, chapterNumbers, fileChapters, isMachinePrompt, userText, MAX_CHARS, MAX_NODES };
