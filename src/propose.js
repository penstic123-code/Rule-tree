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

const STATUSES = ['done', 'doing', 'todo', 'question'];
const ID_RE = /^[A-Z][A-Z0-9]*(?:\.\d+)*$/;
const ROOT_INTRO = {
  zh: store.ROOT_INTRO,
  en: 'Rules that apply to the whole project. One file per requirement, all in this folder; renaming, merging and deleting are all fine.',
};

const parentId = id => (id.includes('.') ? id.slice(0, id.lastIndexOf('.')) : null);
// 检查路径时连 .github 这类隐藏文件夹也算（非 git 项目的遍历默认跳过它们）
const projectFiles = dir => { try { return require('./files').listFiles(dir, { dotDirs: true }); } catch { return []; } };
const matched = (globs, files) => files.filter(f => T.matchesAny(globs, f));

// 一个需求匹配到的文件里，在它自己的公共文件夹之下分属几个不同子文件夹（直接放在公共文件夹里的零散文件不算）。
// 2 个以上说明里面还有可拆的东西；平铺的 monorepo、src/ 加根目录文件都是 0 或 1，不该被挡
function subfolders(files) {
  if (!files.length) return [];
  const dirs = files.map(f => f.split('/').slice(0, -1));
  let common = dirs[0];
  for (const d of dirs) { let i = 0; while (i < common.length && i < d.length && common[i] === d[i]) i++; common = common.slice(0, i); }
  const subs = new Set();
  for (const d of dirs) if (d.length > common.length) subs.add(d[common.length]);
  return [...subs];
}

// 提案用的语言：标题和规则里含中文的条数 vs 不含中文但有字母的条数
function textLangCounts(reqs) {
  let zh = 0, en = 0;
  for (const r of reqs) for (const t of [r && r.title, ...((r && Array.isArray(r.rules)) ? r.rules : [])]) {
    if (typeof t !== 'string') continue;
    if (/[一-鿿]/.test(t)) zh++; else if (/[A-Za-z]/.test(t)) en++;
  }
  return { zh, en };
}
// 没写 lang 时从文字推：有中文且不比英文少就是 zh
function deriveLang(proposal) {
  const { zh, en } = textLangCounts(proposal.requirements || []);
  return zh > 0 && zh >= en ? 'zh' : 'en';
}

function validate(dir, proposal) {
  const problems = [];
  const reqs = proposal && Array.isArray(proposal.requirements) ? proposal.requirements : null;
  if (!reqs || !reqs.length) return { ok: false, problems: ['proposal.requirements must be a non-empty list'] };
  if (store.hasRules(dir)) problems.push('this project already has rules; setup never overwrites them (edit the rule files instead)');
  else if (store.isProject(dir)) problems.push('this project already has an old-style tree file (需求树.md or *.tree.md); run "ruletree init" to convert it instead of running setup');
  if (proposal.lang !== undefined && proposal.lang !== 'zh' && proposal.lang !== 'en') problems.push('lang must be "zh" or "en"');
  else if (proposal.lang) {
    const { zh, en } = textLangCounts(reqs);
    if ((proposal.lang === 'en' && zh > en) || (proposal.lang === 'zh' && en > zh)) problems.push(`lang is "${proposal.lang}" but most titles and rules are written in ${proposal.lang === 'en' ? 'Chinese' : 'English'}; make them agree`);
  }
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
    else if (/[\r\n]/.test(r.title)) problems.push(`${at}: title must be a single line`);
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
  // 只挂一层：只有当某个需求里面确实还有 2 个以上子文件夹可拆时才挡（R1.3：深度跟着内容走，不按顶层文件夹个数）
  if (!problems.length && reqs.every(r => !parentId(r.id))) {
    for (const r of reqs) {
      const subs = subfolders(matched(r.paths, files));
      if (subs.length > 1) {
        problems.push(`the tree has only one level, but ${r.id} ${r.title} covers ${subs.length} separate subfolders (${subs.slice(0, 4).join(', ')}); split it into sub-requirements (${r.id}.1, ${r.id}.2 ...) as deep as the content needs`);
        break;
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

// 把提案写成规则文件。调用前应已通过 validate；这里再查一遍，因为覆盖已有规则是不可恢复的
function apply(dir, proposal) {
  dir = path.resolve(dir);
  if (store.isProject(dir)) throw new Error('this project already has rules or an old-style tree file; setup never overwrites them');
  const v = validate(dir, proposal);
  if (!v.ok) throw new Error('invalid proposal:\n- ' + v.problems.join('\n- '));
  // 语言：提案写明的 > 从标题和规则里的文字推（没有规则可看，说明书也还没写）
  const lang = proposal.lang || deriveLang(proposal);
  const byId = new Map(proposal.requirements.map(r => [r.id, r]));
  const files = new Map([[T.ROOT_FILE, `# P ${path.basename(dir)}\n${ROOT_INTRO[lang]}\n`]]);
  for (const r of proposal.requirements) {
    const p = byId.get(parentId(r.id));
    let text = T.newFile({ id: r.id, title: r.title, status: r.status || null, globs: r.paths, parent: p ? { id: p.id, title: p.title } : null, lang });
    for (const rule of r.rules || []) text += `- ${rule.trim()}\n`;
    files.set(T.fileName(r.id, r.title), text);
  }
  store.replaceAll(dir, files, { source: lang === 'zh' ? '新建' : 'created' });
  const gp = guide.guidePath(dir); // 已有说明书（可能是别的版本写的）不覆盖
  let wroteGuide = false;
  if (!fs.existsSync(gp)) { store.atomicWrite(gp, guide.guideText(lang)); wroteGuide = true; } // 按选定语言写：之后的 detectLang 以它为准
  return { lang, files: [...files.keys()], guide: wroteGuide ? gp : null };
}

module.exports = { validate, apply, deriveLang, subfolders };
