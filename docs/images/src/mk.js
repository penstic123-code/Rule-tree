// node mk.js [--en] name1 name2 ... ：由 <name>.src.js（英文版 <name>.en.src.js）生成 html，再渲染成 out/<name>.png（英文 out/en/<name>.png），800 宽，DSF 2
// node mk.js [--en] all ：渲染全部 16 张；use ：只渲染 8 张"它有什么用"对比图
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const USE = ['use-1-change-tracking', 'use-2-one-place', 'use-3-rewrite-not-append', 'use-4-survive-compaction', 'use-5-load-on-demand', 'use-6-override', 'use-7-live-status', 'use-8-click-not-markdown', 'use-9-check'];
const ALL = ['overview', 'pain', 'idea', 'scope', 'recorder', 'chart-recorder', 'chart-confusion', 'chart-audit', 'chart-migrate', 'chart-chapter', 'chart-replay', 'chart-reorg', 'chart-effect', ...USE];
const args = process.argv.slice(2), en = args.includes('--en');
let names = args.filter(a => a !== '--en'); if (names.includes('all')) names = ALL; else if (names.includes('use')) names = USE;
const dir = __dirname, head = fs.readFileSync(path.join(dir, en ? 'head-en.txt' : 'head.txt'), 'utf8');
const outDir = path.join(dir, 'out', en ? 'en' : ''); fs.mkdirSync(outDir, { recursive: true });
for (const n of names) {
  // 英文版优先用 <name>.en.src.js；没有就用同一份源码（源码里按 EN 切换文字）
  const srcFile = en && fs.existsSync(path.join(dir, n + '.en.src.js')) ? n + '.en.src.js' : n + '.src.js';
  const html = path.join(dir, n + (en ? '.en' : '') + '.html');
  fs.writeFileSync(html, head + '<script>\n' + fs.readFileSync(path.join(dir, srcFile), 'utf8') + '\n</script></body></html>');
  const o = execFileSync('node', [path.join(dir, 'render.mjs'), html, path.join(outDir, n + '.png'), '800', '#stage', '2'], { encoding: 'utf8' });
  process.stdout.write(n + ': ' + o.replace(/^saved \S+ /, ''));
}
