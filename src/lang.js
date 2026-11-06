'use strict';
// 一个项目用中文还是英文：说明书、体检报告、面板上的固定文字都跟着它走。
// 顺序：已有的说明书（写了就不换语言，免得来回改）→ 已有规则里大多数用的语言 → 传进来的默认语言。
// 只读文件，不创建任何东西；不引用 guide.js（guide.js 要用这里），所以自己拼说明书的路径。
const fs = require('fs');
const path = require('path');
const store = require('./store');
const T = require('./tree');

const CJK = /[一-鿿]/;

// 规则文件夹里大多数规则（列表项）用哪种语言；中英一样多或一条规则都没有返回 null
function rulesLang(dir) {
  let zh = 0, en = 0;
  for (const text of store.readFiles(dir).values()) {
    const lines = text.split(/\r?\n/);
    // 文件开头 --- 之间是 paths 列表（文件路径，不是规则），不算
    let from = 0;
    if (/^---\s*$/.test(lines[0] || '')) {
      const end = lines.findIndex((l, i) => i > 0 && /^---\s*$/.test(l));
      if (end > 0) from = end + 1;
    }
    for (const line of lines.slice(from)) {
      const m = /^\s*[-*]\s+(.+)$/.exec(line);
      if (!m) continue;
      if (CJK.test(m[1])) zh++; else if (/[A-Za-z]{2}/.test(m[1])) en++;
    }
  }
  return zh === en ? null : zh > en ? 'zh' : 'en';
}

function guideLang(dir) {
  let have = null;
  try { have = fs.readFileSync(path.join(store.rulesDir(dir), T.GUIDE_FILE || '_guide.md'), 'utf8'); } catch {}
  if (!have || !/^<!-- ruletree:guide /.test(have)) return null;
  return CJK.test(have) ? 'zh' : 'en';
}

function detectLang(dir, fallback = 'en') {
  return guideLang(dir) || rulesLang(dir) || (fallback === 'zh' ? 'zh' : 'en');
}

module.exports = { detectLang, rulesLang, guideLang };
