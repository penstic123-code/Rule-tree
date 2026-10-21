'use strict';
// 新建需求时猜它对应哪些文件：按名字比对，不做拼音、翻译。
// - 「第3章」「第三章」「ch3」「Chapter 3」「第3关」→ 找 ch03-… / 03-… / level-03 这类名字
// - 英文词：标题和文件夹名拆成词（驼峰、连字符、下划线都拆开），重合越多越靠前
// - 整个名字（如 UIUX设计、DataScience）出现在标题里，算强匹配
// guessGlobs 是纯函数（单元测试用）；candidates 从磁盘列候选；suggest 两者合起来给插件用。
const fs = require('fs');
const path = require('path');

const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

// 「十三」「二十」「九十九」这类一百以内的中文数字；不认识返回 null
function cnNumber(s) {
  if (/^\d+$/.test(s)) return +s;
  const m = s.match(/^([一二两三四五六七八九])?(十)?([一二三四五六七八九])?$/);
  if (!m || (!m[2] && (!m[1] || m[3])) || !s) return null;
  if (!m[2]) return CN_DIGIT[m[1]];
  return (m[1] ? CN_DIGIT[m[1]] : 1) * 10 + (m[3] ? CN_DIGIT[m[3]] : 0);
}

// 标题里的编号：第N章/课/节/关/讲/篇、ch3、chapter 3、lesson 3、level 3
function numberOf(title) {
  const cn = title.match(/第\s*([0-9]+|[零〇一二两三四五六七八九十]+)\s*[章课节关讲篇单元]/);
  if (cn) return cnNumber(cn[1]);
  const en = title.match(/\b(?:ch|chapter|lesson|level|unit|part)[\s._-]*(\d+)\b/i);
  return en ? +en[1] : null;
}

// 拆词：驼峰、非字母数字都当分隔；只留两个字母以上的英文词（中文整体比对，见 compact）
const words = s => s.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 2 && !/^\d+$/.test(w));
// 去掉分隔符的整个名字，用来判断「名字整个出现在标题里」
const compact = s => s.toLowerCase().replace(/[\s._\-()（）·]+/g, '');

const base = p => p.split('/').pop();
const ext = name => { const m = name.match(/\.[^.]+$/); return m && !/^\./.test(name) ? m[0] : ''; };

// candidates: [{ path: '相对项目根目录、用 / 分隔', dir: 是否文件夹 }]。返回最多 3 个 glob，好的在前
function guessGlobs(title, candidates) {
  title = String(title || '');
  const n = numberOf(title);
  if (n != null) {
    // 名字以 [字母前缀][分隔]0*N 开头，后面不能紧跟数字（第1章不配 ch13）
    const re = new RegExp(`^((?:ch|chapter|lesson|level|unit|part|lv|l)?[-_ .]?0*${n})(?![0-9])([-_ .]?)`, 'i');
    const hits = candidates.map(c => ({ c, m: base(c.path).match(re) })).filter(x => x.m);
    const out = [];
    const dirHits = hits.filter(x => x.c.dir);
    for (const x of dirHits) out.push(`${x.c.path}/**`);
    // 同一个文件夹里的同号文件合成一个 glob：扩展名都一样就带上
    const byDir = new Map();
    for (const x of hits.filter(x => !x.c.dir)) {
      const dir = path.posix.dirname(x.c.path);
      const key = `${dir}\0${x.m[1] + x.m[2]}`;
      if (!byDir.has(key)) byDir.set(key, { dir, prefix: x.m[1] + x.m[2], exts: new Set() });
      byDir.get(key).exts.add(ext(base(x.c.path)));
    }
    for (const g of byDir.values()) {
      const e = g.exts.size === 1 ? [...g.exts][0] : '';
      out.push(`${g.dir === '.' ? '' : g.dir + '/'}${g.prefix}*${e}`);
    }
    return out.slice(0, 3);
  }
  const tWords = new Set(words(title));
  const tCompact = compact(title);
  const scored = [];
  for (const c of candidates) {
    const name = base(c.path);
    const whole = compact(name);
    let score = whole.length >= 2 && tCompact.includes(whole) ? 10 : 0;
    for (const w of new Set(words(name))) if (tWords.has(w)) score++;
    if (score) scored.push({ glob: c.dir ? `${c.path}/**` : c.path, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 3).map(s => s.glob);
}

// glob 里不含通配符的开头几段：DataScience/ch01-*.html → DataScience
function staticBase(glob) {
  const segs = glob.split('/');
  const out = [];
  for (const s of segs) { if (/[*?[\]{}]/.test(s)) break; out.push(s); }
  return out.length === segs.length ? null : out.join('/'); // 整个都是固定路径：是具体文件，不往里列
}

const SKIP = name => name.startsWith('.') || name === 'node_modules';

// 候选：上级有文件对应时列它范围里的一层；没有就列项目顶层的文件夹
function candidates(projectDir, parentGlobs) {
  const list = [];
  const seen = new Set();
  const add = (rel, dir) => { if (!seen.has(rel)) { seen.add(rel); list.push({ path: rel, dir }); } };
  const bases = (parentGlobs || []).length ? [...new Set(parentGlobs.map(staticBase).filter(b => b != null))] : [null];
  for (const b of bases) {
    let entries;
    try { entries = fs.readdirSync(path.join(projectDir, b || ''), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (SKIP(e.name)) continue;
      const rel = b ? `${b}/${e.name}` : e.name;
      if (e.isDirectory()) add(rel, true);
      else if (b && e.isFile()) add(rel, false);
    }
  }
  return list;
}

const suggest = (projectDir, title, parentGlobs) => guessGlobs(title, candidates(projectDir, parentGlobs));

module.exports = { guessGlobs, candidates, suggest, numberOf };
