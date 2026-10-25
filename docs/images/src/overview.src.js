// 首页第一张图：RuleTree 做的三件事，只讲通用流程，不放具体项目的例子（例子在 scope、recorder 里）
const T = EN ? {
  title: 'What RuleTree does',
  s1: '1  Write it down', s2: '2  Sort it', s3: '3  Hand it over',
  say: 'Keep money in cents', p1: ['After each turn, a small model', 'in the background picks out', 'requests meant to last'],
  tree: ['Whole project', 'Module A   files a/**', 'Part of A   a/x.py', 'Module B   files b/**'],
  p2: ['需求树.md, the tree: one block', 'per part of the project, listing', 'the files it covers and its rules'],
  file: 'AI edits a/x.py', got: ['Rules it gets:', 'whole project', 'module A', 'part of A'], skip: 'Module B: not sent',
  p3: ['Claude Code already hands rules', 'over by file, so new chats', 'and subagents get them too'],
  foot: 'Rules piling up? Click Check-up: merge duplicates, settle conflicts, drop stale rules, split crowded blocks. Every change can be undone.',
} : {
  title: 'RuleTree 做三件事',
  s1: '① 记下来', s2: '② 分好', s3: '③ 送到',
  say: '金额一律用整数分', p1: ['每轮对话结束，后台一个小模型', '（记录员）挑出以后都要守的', '要求，记下来'],
  tree: ['整个项目', '模块 A   管 a/**', 'A 的一部分   管 a/x.py', '模块 B   管 b/**'],
  p2: ['项目里的 需求树.md 按功能', '分成一块块，每块写明管哪些', '文件、要守哪些规则'],
  file: 'AI 改 a/x.py', got: ['收到的规则：', '整个项目的', '模块 A 的', 'A 的一部分的'], skip: '模块 B 的不送',
  p3: ['Claude Code 本来就会按文件', '把规则交给 AI，新开对话、', '派出子 agent 也照样收到'],
  foot: '规则攒多了，点「体检」：合并重复、处理矛盾、删掉过时的、太挤的块重新分。每次改动都能撤销。',
};
sketch(800, 420, g => {
  const { C } = g;
  g.text(24, 32, T.title, { size: 22, weight: 700 });
  const X = [20, 286, 552], W = 228, Y = 62, H = 280;
  [T.s1, T.s2, T.s3].forEach((s, i) => {
    g.rect(X[i], Y, W, H, { fill: '#fffdf6', strokeWidth: 1.4 });
    g.text(X[i] + 14, Y + 26, s, { size: 18, weight: 700, color: C.green });
  });
  g.arrow(X[0] + W + 4, Y + 130, X[1] - 4, Y + 130, { color: C.green, sw: 2 });
  g.arrow(X[1] + W + 4, Y + 130, X[2] - 4, Y + 130, { color: C.green, sw: 2 });

  // ① 你说一句，记录员记下
  g.bubble(X[0] + 16, Y + 48, 160, 40, X[0] + 40, Y + 104, { text: T.say, size: 15 });
  g.robot(X[0] + 176, Y + 196, { scale: 0.5 });
  T.p1.forEach((s, i) => g.text(X[0] + 14, Y + 220 + i * 21, s, { size: 14 }));

  // ② 分成一块块
  const rows = [[0, true], [1, true], [2, true], [1, false]];
  rows.forEach(([d, on], i) => {
    const x = X[1] + 16 + d * 18, y = Y + 58 + i * 34, s = T.tree[i], w = g.measure(s, 14) + 16;
    if (d) g.line(x - 10, y - 16, x - 10, y, { stroke: C.muted, strokeWidth: 1 }), g.line(x - 10, y, x, y, { stroke: C.muted, strokeWidth: 1 });
    g.rect(x, y - 13, w, 26, { fill: [C.sky, C.mint, '#fdf1cf', C.mint][i], strokeWidth: 1.1 });
    g.text(x + 8, y + 1, s, { size: 14 });
  });
  T.p2.forEach((s, i) => g.text(X[1] + 14, Y + 220 + i * 21, s, { size: 14 }));

  // ③ 改哪个文件送哪几块
  g.doc(X[2] + 14, Y + 42, 196, 40, { title: T.file, tsize: 14 });
  T.got.forEach((s, i) => g.text(X[2] + 20 + (i ? 12 : 0), Y + 104 + i * 22, (i ? '✓ ' : '') + s, { size: 14, weight: i ? 400 : 700, color: i ? C.green : C.ink }));
  g.text(X[2] + 32, Y + 192, '✗ ' + T.skip, { size: 14, color: C.muted });
  T.p3.forEach((s, i) => g.text(X[2] + 14, Y + 220 + i * 21, s, { size: 14 }));

  // 体检
  g.rect(20, 360, 760, 44, { fill: C.gray, strokeWidth: 1.2 });
  g.text(36, 383, T.foot, { size: EN ? 13 : 15 });
});
