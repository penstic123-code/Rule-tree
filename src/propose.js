'use strict';
// AI 读完项目后提出的第一棵需求树：先检查（validate），没问题再写成规则文件（apply）。
// 提案 = { lang?: 'zh'|'en', requirements: [{ id, title, status?, paths: [glob], rules?: [一句话], parent? }] }
// 检查的目的是挡住 AI 的常见失误：路径写错（匹配不到文件）、下级超出上级、只挂一层（R1.3）、覆盖已有的规则。
// rules 只收项目里本来就写明的规矩——这一点靠 skill 的指示，程序只能保证格式。
const fs = require('fs');
const path = require('path');
const store = require('./store');
const T = require('./tree');
const guide = require('./guide');
const { detectLang } = require('./lang');

const STATUSES = ['done', 'doing', 'todo', 'question'];
const SKIP_TOP = /^(node_modules|dist|build|out|target|coverage|vendor)$/i;
const ID_RE = /^[A-Z][A-Z0-9]*(?:\.\d+)*$/;
const ROOT_INTRO = {
  zh: store.ROOT_INTRO,
  en: 'Rules that apply to the whole project. One file per requirement, all in this folder; renaming, merging and deleting are all fine.',
};

const parentId = id => (id.includes('.') ? id.slice(0, id.lastIndexOf('.')) : null);
const projectFiles = dir => { try { return require('./files').listFiles(dir); } catch { return []; } };
const matched = (globs, files) => files.filter(f => T.matchesAny(globs, f));

// 项目里有几块「地方」：每个顶层文件夹算一块，根目录下的零散文件合起来算一块
function areaCount(files) {
  const areas = new Set();
  for (const f of files) {
    const i = f.indexOf('/');
    if (i < 0) areas.add('');
    else if (!f.startsWith('.') && !SKIP_TOP.test(f.slice(0, i))) areas.add(f.slice(0, i));
  }
  return areas.size;
}

function validate(dir, proposal) {
  const problems = [];
  const reqs = proposal && Array.isArray(proposal.requirements) ? proposal.requirements : null;
  if (!reqs || !reqs.length) return { ok: false, problems: ['proposal.requirements must be a non-empty list'] };
  if (store.hasRules(dir)) problems.push('this project already has rules; setup never overwrites them (edit the rule files instead)');
  if (proposal.lang !== undefined && proposal.lang !== 'zh' && proposal.lang !== 'en') problems.push('lang must be "zh" or "en"');
  const files = projectFiles(dir);
  const ids = new Set();
  const byId = new Map();
  for (const r of reqs) {
    const at = r && typeof r.id === 'string' ? r.id : '(no id)';
    if (!r || typeof r !== 'object') { problems.push('each requirement must be an object'); continue; }
    if (!ID_RE.test(at)) { problems.push(`${at}: id must look like R1 or R1.2`); continue; }
    if (ids.has(at)) { problems.push(`${at}: id is used twice`); continue; }
    ids.add(at); byId.set(at, r);
    if (typeof r.title !== 'string' || !r.title.trim()) problems.push(`${at}: title is empty`);
    if (r.status != null && !STATUSES.includes(r.status)) problems.push(`${at}: status must be one of ${STATUSES.join(', ')}`);
    if (r.rules != null && (!Array.isArray(r.rules) || r.rules.some(x => typeof x !== 'string' || !x.trim() || /[\r\n]/.test(x)))) problems.push(`${at}: rules must be single-line, non-empty strings`);
    if (!Array.isArray(r.paths) || !r.paths.length || r.paths.some(g => typeof g !== 'string' || !g.trim())) { problems.push(`${at}: paths must be a non-empty list of globs`); continue; }
    const bad = r.paths.filter(g => path.isAbsolute(g) || /^[A-Za-z]:/.test(g) || g.includes('\\') || g.split('/').includes('..'));
    if (bad.length) { problems.push(`${at}: paths must be relative to the project root, with / separators and no ..: ${bad.join(', ')}`); continue; }
    for (const g of r.paths) if (!matched([g], files).length) problems.push(`${at}: path "${g}" matches no file in the project`);
  }
  for (const r of reqs) {
    if (!r || !byId.has(r.id) || byId.get(r.id) !== r) continue;
    const want = parentId(r.id);
    if (r.parent != null && r.parent !== want) problems.push(`${r.id}: parent must be ${want || 'absent (top level)'}, because the number decides the level`);
    if (!want) continue;
    const p = byId.get(want);
    if (!p) { problems.push(`${r.id}: its parent ${want} is not in the proposal`); continue; }
    if (!Array.isArray(p.paths) || !Array.isArray(r.paths)) continue;
    const outside = matched(r.paths, files).filter(f => !T.matchesAny(p.paths, f));
    if (outside.length) problems.push(`${r.id}: paths reach outside its parent ${want} (e.g. ${outside[0]}); a child must stay inside its parent's paths`);
  }
  if (!problems.length && areaCount(files) > 1 && reqs.every(r => !parentId(r.id)))
    problems.push('the tree has only one level but the project has more than one area; split the big requirements into sub-requirements (R1.1, R1.2 ...) as deep as the content needs');
  return { ok: problems.length === 0, problems };
}

// 把提案写成规则文件。调用前应已通过 validate；这里再查一遍，因为覆盖已有规则是不可恢复的
function apply(dir, proposal) {
  dir = path.resolve(dir);
  if (store.hasRules(dir)) throw new Error('this project already has rules; setup never overwrites them');
  const v = validate(dir, proposal);
  if (!v.ok) throw new Error('invalid proposal:\n- ' + v.problems.join('\n- '));
  // 语言：提案写明的 > 项目里已有的 > 英文（这时项目里没有规则，所以只有说明书可看）
  const lang = proposal.lang || detectLang(dir, 'en');
  const byId = new Map(proposal.requirements.map(r => [r.id, r]));
  const files = new Map([[T.ROOT_FILE, `# P ${path.basename(dir)}\n${ROOT_INTRO[lang]}\n`]]);
  for (const r of proposal.requirements) {
    const p = byId.get(parentId(r.id));
    let text = T.newFile({ id: r.id, title: r.title, status: r.status || null, globs: r.paths, parent: p ? { id: p.id, title: p.title } : null, lang });
    for (const rule of r.rules || []) text += `- ${rule.trim()}\n`;
    files.set(T.fileName(r.id, r.title), text);
  }
  store.replaceAll(dir, files, { source: lang === 'zh' ? '新建' : 'created' });
  store.atomicWrite(guide.guidePath(dir), guide.guideText(lang)); // 先按选定语言写说明书：之后的 detectLang 以它为准
  return { lang, files: [...files.keys()] };
}

module.exports = { validate, apply, areaCount };
