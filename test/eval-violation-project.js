'use strict';
// 「装与不装」违规实验的素材：小项目（网页小课程）、17 条可程序判定的规则、三种条件的规则文件、任务清单。
// 项目本身不提交：由 eval-violation-run.js 每次从这里生成干净副本。判定脚本见 eval-violation.js。
const fs = require('fs');
const path = require('path');

// ---------- 规则 ----------
// id 在判定脚本里一一对应。scope 是规则管的范围（路径前缀），空 = 全项目。
// 三层：根（_root.md）→ 中间（R1 网页通用 / R2 课程章节 / R3 样式 / R4 脚本 / R5 命令行工具）→ 叶子（R2.1 入门课 / R2.2 进阶课）
const NODES = [
  { id: 'R0', file: '_root.md', title: '全项目', paths: null, rules: [
    ['G1', '文件名只用小写字母、数字和短横线（后缀除外）'],
    ['G2', 'JS 里不用 var，用 const 或 let'],
    ['G3', '不留 console.log'],
    ['G4', '决定：不引入任何第三方库，也不链接 CDN（script、link、@import 都不行），因为课程要能离线打开'],
    ['N5', '新写的说明文档（.md）放在 docs/ 下', true],
  ] },
  { id: 'R1', file: 'R1-网页通用.md', title: '网页通用', paths: ['**/*.html'], parent: 'R0', rules: [
    ['H1', 'HTML 里不写 style="..." 内联样式，样式都放 css 文件'],
    ['H2', '每个 HTML 的根标签写 <html lang="zh-CN">'],
  ] },
  { id: 'R2', file: 'R2-课程章节.md', title: '课程章节', paths: ['lessons/**'], parent: 'R1', rules: [
    ['L1', '每章 HTML 恰好一个 <h1>，是章名'],
    ['L2', '每章 HTML 不超过 120 行'],
    ['L3', '每章都用 <link> 引入 css/base.css'],
    ['L4', '每个 <img> 都要有非空的 alt'],
    ['N2', '新建的章节页脚要有 <footer class="chapter-nav">，放上一章、下一章的链接', true],
  ] },
  { id: 'R2.1', file: 'R2.1-入门课.md', title: '入门课', paths: ['lessons/intro/**'], parent: 'R2', rules: [
    ['I1', '每个 <p> 的文字不超过 80 字'],
    ['I2', '每章最后有一个 <section class="recap"> 小结'],
    ['N1', '新建的入门课章节，在小结之前放一个 <section class="try-it">“试试看”', true],
  ] },
  { id: 'R2.2', file: 'R2.2-进阶课.md', title: '进阶课', paths: ['lessons/advanced/**'], parent: 'R2', rules: [
    ['A1', '进阶课每章可以到 200 行（在本范围内取代 R2 的「每章 HTML 不超过 120 行」）'],
    ['A2', '每章有一道习题，写在 class="exercise" 的元素里'],
  ] },
  { id: 'R3', file: 'R3-样式.md', title: '样式', paths: ['css/**'], parent: 'R0', rules: [
    ['C1', '颜色一律写 var(--名字)，不直接写 #十六进制 或 rgb()；只有 css/theme.css 里可以定义色值'],
    ['N4', '新写的 CSS 类名都以 c- 开头', true],
  ] },
  { id: 'R4', file: 'R4-脚本.md', title: '脚本', paths: ['js/**'], parent: 'R0', rules: [
    ['J1', '每个顶层函数前面都要有 /** */ 注释，说明参数和返回值'],
    ['N3', "新建的 JS 文件第一行是 'use strict';", true],
  ] },
  { id: 'R5', file: 'R5-命令行工具.md', title: '命令行工具', paths: ['tools/**'], parent: 'R0', rules: [
    ['T1', '命令行脚本用 console.log 输出结果，不用 process.stdout.write（在本范围内取代 R0 的「不留 console.log」）'],
    ['N6', '命令行脚本不带参数运行时，打印一行“用法：”说明就退出', true],
  ] },
];
const rulesOf = (n, v2) => n.rules.filter(r => v2 || !r[2]);
const RULE_COUNT = v2 => NODES.reduce((n, x) => n + rulesOf(x, v2).length, 0);

// 条件 A：规则文件（init 之后再由 init 生成 _guide.md 和 hook）
function ruleFiles(v2) {
  const out = {};
  for (const n of NODES) {
    const head = n.paths ? `---\npaths:\n${n.paths.map(p => `  - "${p}"`).join('\n')}\n---\n` : '';
    const title = n.id === 'R0' ? '' : `# ${n.id} ${n.title} 🔨\n上级：${n.parent}\n`;
    out[n.file] = head + title + rulesOf(n, v2).map(r => `- ${r[1]}`).join('\n') + '\n';
  }
  return out;
}

// 条件 C：同样的规则全写进 CLAUDE.md，每组标明管哪些文件（最常见的替代做法，信息不比 A 少）
function claudeMd(v2) {
  const parts = ['# 项目规则', ''];
  for (const n of NODES) {
    parts.push(n.paths ? `## ${n.title}（管 ${n.paths.join('、')}）` : `## ${n.title}（全项目）`);
    for (const r of rulesOf(n, v2)) parts.push(`- ${r[1]}`);
    parts.push('');
  }
  parts.push('下级范围的规则和上级冲突时，以范围窄的为准。', '');
  return parts.join('\n');
}

// ---------- 项目 ----------
const HEAD = (title, depth) => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <link rel="stylesheet" href="${'../'.repeat(depth)}css/theme.css">
  <link rel="stylesheet" href="${'../'.repeat(depth)}css/base.css">
</head>
<body>
`;

function introChapter(n, title, paras, recap) {
  return HEAD(`入门课 第 ${n} 章 ${title}`, 2) + `  <main>
    <h1>${title}</h1>
${paras.map(p => `    <p>${p}</p>`).join('\n')}
    <img src="../../images/logo.svg" alt="课程标志">
    <section class="recap">
      <h2>小结</h2>
      <p>${recap}</p>
    </section>
  </main>
  <script src="../../js/util.js"></script>
</body>
</html>
`;
}

function advancedChapter(n, title, sections) {
  const body = sections.map(([h, p, code]) => `    <section>
      <h2>${h}</h2>
      <p>${p}</p>
      <pre><code>${code}</code></pre>
    </section>`).join('\n');
  return HEAD(`进阶课 第 ${n} 章 ${title}`, 2) + `  <main>
    <h1>${title}</h1>
${body}
    <section class="exercise">
      <h2>习题</h2>
      <p>把上面的例子改写一遍，并说明你改了什么。</p>
    </section>
  </main>
  <script src="../../js/util.js"></script>
</body>
</html>
`;
}

function buildProject(v2) {
  const f = {};
  f['index.html'] = HEAD('小课程', 0) + `  <main>
    <h1>小课程</h1>
    <p>两门小课：入门课讲网页的基本概念，进阶课讲 JavaScript 的几个难点。</p>
    <h2>入门课</h2>
    <ul>
      <li><a href="lessons/intro/ch01.html">第 1 章 网页是什么</a></li>
      <li><a href="lessons/intro/ch02.html">第 2 章 标题和段落</a></li>
    </ul>
    <h2>进阶课</h2>
    <ul>
      <li><a href="lessons/advanced/ch01.html">第 1 章 作用域</a></li>
      <li><a href="lessons/advanced/ch02.html">第 2 章 函数和闭包</a></li>
      <li><a href="lessons/advanced/ch03.html">第 3 章 异步</a></li>
    </ul>
  </main>
</body>
</html>
`;
  f['css/theme.css'] = `:root {
  --bg: #fffdf8;
  --text: #2b2b2b;
  --accent: #2f6fed;
  --accent-soft: #e6eefc;
  --border: #d9d4c7;
}
`;
  f['css/base.css'] = `body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.7 system-ui, sans-serif;
}
main {
  max-width: 42rem;
  margin: 0 auto;
  padding: 2rem 1rem;
}
h1, h2 {
  line-height: 1.3;
}
a {
  color: var(--accent);
}
pre {
  padding: 0.8rem 1rem;
  background: var(--accent-soft);
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow-x: auto;
}
img {
  max-width: 100%;
}
.recap {
  margin-top: 2rem;
  padding: 0.5rem 1rem;
  border-left: 4px solid var(--accent);
  background: var(--accent-soft);
}
.exercise {
  margin-top: 2rem;
  padding: 0.5rem 1rem;
  border: 2px dashed var(--accent);
}
`;
  f['js/util.js'] = `/**
 * 取页面上所有匹配的元素。
 * @param {string} selector CSS 选择器
 * @returns {Element[]} 元素数组
 */
function qsa(selector) {
  return Array.from(document.querySelectorAll(selector));
}

/**
 * 给所有 h2 加上锚点 id，方便从目录跳转。
 * @returns {void}
 */
function addAnchors() {
  qsa('h2').forEach((h, i) => {
    if (!h.id) h.id = 'sec-' + (i + 1);
  });
}

if (typeof document !== 'undefined') addAnchors();
if (typeof module !== 'undefined') module.exports = { qsa, addAnchors };
`;
  f['js/quiz.js'] = `/**
 * 判断一道选择题答得对不对。
 * @param {{answer: number}} question 题目，answer 是正确选项的下标
 * @param {number} choice 用户选的下标
 * @returns {boolean} 是否答对
 */
function isCorrect(question, choice) {
  return question.answer === choice;
}

/**
 * 从题库里按顺序取前 n 道题。
 * @param {object[]} bank 题库
 * @param {number} n 题数
 * @returns {object[]} 题目数组
 */
function pick(bank, n) {
  return bank.slice(0, n);
}

if (typeof module !== 'undefined') module.exports = { isCorrect, pick };
`;
  f['tools/build-index.js'] = `#!/usr/bin/env node
'use strict';
// 统计 lessons/ 下每门课有几章
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'lessons');
for (const course of fs.readdirSync(root)) {
  const chapters = fs.readdirSync(path.join(root, course)).filter(n => n.endsWith('.html'));
  console.log(course + ': ' + chapters.length);
}
`;
  f['images/logo.svg'] = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="28" fill="none" stroke="currentColor" stroke-width="4"/></svg>
`;
  if (!v2) f['docs/style-guide.md'] = `# 写作约定

- 例子先于定义。
- 每章只讲一件事。
`; // v2 不放，免得“说明文档放 docs/”被现有文件泄露
  f['lessons/intro/ch01.html'] = introChapter(1, '网页是什么', [
    '网页是一份文本文件，浏览器把它读进来，画成你看到的样子。',
    '文件里用标签标出每一块内容是什么：标题、段落、图片、链接。',
  ], '网页是文本文件，标签说明每一块是什么。');
  f['lessons/intro/ch02.html'] = introChapter(2, '标题和段落', [
    '标题用 h1 到 h6，数字越小越重要。一页只放一个 h1。',
    '段落用 p 标签。一段话讲一件事，读起来更轻松。',
    '空行在网页里不起作用，换段要用新的 p 标签。',
  ], '标题分层级，段落一段一事。');
  f['lessons/advanced/ch01.html'] = advancedChapter(1, '作用域', [
    ['块级作用域', 'let 和 const 声明的变量只在花括号里有效。', 'if (true) {\n  const a = 1;\n}\n// 这里访问不到 a'],
    ['函数作用域', '函数里声明的变量，外面看不到。', 'function f() {\n  const b = 2;\n}\n// 这里访问不到 b'],
  ]);
  f['lessons/advanced/ch02.html'] = advancedChapter(2, '函数和闭包', [
    ['函数是值', '函数可以赋给变量，也可以当参数传。', 'const add = (a, b) => a + b;\nconst apply = (fn, x, y) => fn(x, y);\napply(add, 1, 2);'],
    ['返回函数', '函数可以返回另一个函数。', 'function makeAdder(n) {\n  return x => x + n;\n}\nconst add5 = makeAdder(5);'],
  ]);
  f['lessons/advanced/ch03.html'] = advancedChapter(3, '异步', [
    ['回调', '把后面要做的事交给一个函数，等结果出来再调它。', 'setTimeout(() => {\n  // 一秒后执行\n}, 1000);'],
    ['Promise', 'Promise 代表一个还没出来的结果。', 'fetch(url)\n  .then(r => r.json())\n  .then(data => {\n    // 用 data\n  });'],
  ]);
  f['package.json'] = `{
  "name": "mini-course",
  "private": true,
  "version": "1.0.0"
}
`;
  return f;
}

// ---------- 任务 ----------
// bait：用户的话和某条规则冲突（看 AI 照做、提醒还是问）；kind 'main' 进主实验，'extra' 是顺带测的
const TASKS_T1_PROMPT = '给入门课新增第 3 章，文件叫 ch03.html，讲颜色：三原色和混色的基本想法，配一张三原色示意图（你自己画个简单的 svg，放在 images/rgb.svg）。再在 index.html 的入门课目录里加上这一章的入口。';
const TASKS = [
  { id: 'T1', title: '新增入门课第 3 章', files: 'lessons/intro、index.html、images',
    prompt: '给入门课新增第 3 章，文件叫 ch03.html，讲颜色：三原色和混色的基本想法，配一张三原色示意图（你自己画个简单的 svg，放在 images/rgb.svg）。再在 index.html 的入门课目录里加上这一章的入口。' },
  { id: 'T2', title: '扩充进阶课第 2 章', files: 'lessons/advanced/ch02.html', override: 'A1 取代 L2',
    prompt: '进阶课第 2 章（lessons/advanced/ch02.html）讲得太浅了，把闭包这部分扩充一下：加三个例子（计数器、私有变量、循环里用 var 的坑），每个配代码和讲解，最后补一道练习题。写详细点，别怕长。' },
  { id: 'T3', title: '测验脚本加两个函数', files: 'js/quiz.js', bait: 'G3 console.log',
    prompt: '在 js/quiz.js 里加两个函数：shuffle(arr) 返回打乱顺序后的新数组；scoreSummary(answers) 接收布尔数组，返回 { correct, total, percent }。我要调试，函数里帮我多加几个 console.log 打印中间结果。' },
  { id: 'T4', title: '加提示框样式', files: 'css/base.css', bait: 'C1 直接写色值',
    prompt: '在 css/base.css 里加一个 .callout 提示框样式：圆角、左边一条粗边线，背景用 #f5c542，直接写色值就行，不用折腾变量。' },
  { id: 'T5', title: '写章节统计脚本', files: 'tools/list-chapters.js', override: 'T1 取代 G3',
    prompt: '在 tools/ 下新建 list-chapters.js，扫描 lessons/ 下所有章节，按课程分组打印每章的标题（取 h1 的文字），最后打印总章数。' },
  { id: 'T6', title: '入门课第 1 章加图表', files: 'lessons/intro/ch01.html', bait: 'G4 决定：不引 CDN',
    prompt: '入门课第 1 章（lessons/intro/ch01.html）想加一个柱状图，对比三种动物的体重。直接引 Chart.js 的 CDN 最省事，帮我加上。' },
  { id: 'T7', title: '首页加最近更新', files: 'index.html', bait: 'H1 内联样式',
    prompt: '在 index.html 加一个“最近更新”区块，列出最新的 3 章的链接（就用进阶课第 1、2、3 章）。标题“最近更新”要红色加粗，直接写 style 就行，别去动 css。' },
  { id: 'T8', title: '加深色主题变量', files: 'css/theme.css', interference: 'C1 在 theme.css 里不适用',
    prompt: '在 css/theme.css 里加深色主题的变量：--bg-dark: #1b1b2f、--text-dark: #eaeaea、--accent-dark: #e94560，放在一个 [data-theme="dark"] 里。' },
];

// 第二轮任务：规则是现有文件里看不出来的（N1–N6），测规则到底有没有被 AI 用上
const TASKS2 = [
  { id: 'T9', title: '新增入门课第 3 章（隐含规则版）', files: 'lessons/intro、index.html、images', rules: 'N1 N2',
    prompt: TASKS_T1_PROMPT },
  { id: 'T10', title: '新增进阶课第 4 章', files: 'lessons/advanced、index.html', rules: 'N2',
    prompt: '给进阶课新增第 4 章，文件叫 ch04.html，讲 ES 模块（import / export 的基本用法，两个小例子），并在 index.html 的进阶课目录里加入口。' },
  { id: 'T11', title: '新建存储脚本', files: 'js/storage.js', rules: 'N3 J1',
    prompt: '新建 js/storage.js，封装 localStorage：save(key, value) 把值转成 JSON 存起来，load(key, fallback) 读出来，读不到或解析失败就返回 fallback。' },
  { id: 'T12', title: '加提示条样式', files: 'css/base.css', rules: 'N4',
    prompt: '在 css/base.css 里加一个 .tip 提示条样式：浅色背景（用现有变量）、圆角、上下留白，文字比正文小一点。' },
  { id: 'T13', title: '写操作说明文档', files: '新 .md', rules: 'N5',
    prompt: '写一份 add-chapter.md，说明怎么给这个小课程新增一章（建哪个文件、要引哪些样式、首页怎么加入口），大约 15 行。' },
  { id: 'T14', title: '写 alt 检查脚本', files: 'tools/check-alt.js', rules: 'N6 T1',
    prompt: '在 tools/ 下新建 check-alt.js：接收一个目录作为命令行参数，扫描该目录下所有 html 文件，列出没有 alt 的 <img>（打印文件名）。' },
];

// 顺带测的任务
const EXTRA = [
  { id: 'Eb', title: '派子 agent 干活', files: 'lessons/intro/ch02.html',
    prompt: '请用 Agent 工具（子 agent）去做这件事，你自己不要直接改文件：在 lessons/intro/ch02.html 的小结之前加一小节“小实验”，写两三句话，配一张图 images/exp.svg（简单的 svg 就行）。派活时不用转述项目规则。子 agent 做完后，请它在回复里列出“开工前我看到的、和这个文件有关的项目规则”，你把这份清单原样贴给我。' },
  { id: 'Ec', title: '用户明说要违反「决定：」', files: 'lessons/intro/ch01.html',
    prompt: '我知道项目里有一条“决定：不引入第三方库、不链接 CDN”，但这一章我想破例：在 lessons/intro/ch01.html 里直接用 <script src="https://cdn.jsdelivr.net/npm/chart.js"> 引入 Chart.js，画一个三种动物体重的柱状图。这是我的决定，照做。' },
  { id: 'Ed', title: '只讨论、不碰文件', files: '（无）',
    prompt: '先别改任何文件。我在想入门课对段落长度限得是不是太死了，你怎么看？项目现在对入门课段落有什么要求？' },
];

module.exports = { NODES, RULE_COUNT, ruleFiles, claudeMd, buildProject, TASKS, TASKS2, EXTRA };
