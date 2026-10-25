const T = EN ? {
  title: 'With and without RuleTree: the AI edits real files',
  sub: ['Copies of two real projects, 2 tasks each, 8 edits per setup; another model', 'counted the rules each edit broke. Short tasks that end after one file'],
  series: ['Rules in CLAUDE.md', 'RuleTree', 'RuleTree + code map'], left: 'Rules broken per edit', right: 'Rules and notes read (characters)',
  groups: ['Courses', 'Game'], fmt: v => (v ? (v / 1000).toFixed(1) + 'k' : '0'),
  src: 'Data: docs/test-log.md',
} : {
  title: '装与不装：让 AI 真改文件',
  sub: ['两个真实项目的副本，各 2 个任务，每种装法改 8 次，另一个模型逐条对照规则判违反；', '都是改一个文件就结束的短任务'],
  series: ['规则都写进 CLAUDE.md', '需求树', '需求树 + 代码地图'], left: '每次违反的规则', right: '要读的规则和说明（字）',
  groups: ['课程', '游戏'], fmt: v => (v ? (v / 10000).toFixed(1) + ' 万' : '0'),
  src: '数据：docs/test-log.md',
};
sketch(800, EN ? 486 : 470, g => {
  chTitle(g, T.title, T.sub);
  const series = [CH.grey, CH.green, CH.green0].map((s, i) => ({ ...s, name: T.series[i] }));
  const top = EN ? 122 : 122;
  chLegend(g, 24, top, series);
  g.text(70, top + 36, T.left, { size: 15, weight: 700 });
  chVBars(g, { x0: 70, x1: 400, y0: 410, y1: top + 72, max: 1.5, step: 0.5, bw: 34, gap: 6, vsize: 13,
    groups: T.groups.map((l, i) => ({ label: l, vals: [[0.88, 1.13, 0.88], [0, 0, 0.38]][i] })), series });
  g.line(440, top + 24, 440, 426, { stroke: '#d9d0bd', strokeWidth: 1.2 });
  const rw = g.measure(T.right, 15, 700);
  g.text(776 - rw, top + 36, T.right, { size: 15, weight: 700 });
  chVBars(g, { x0: 510, x1: 776, y0: 410, y1: top + 72, max: 25000, step: 5000, bw: 34, gap: 6, vsize: 12, fmt: T.fmt,
    groups: T.groups.map((l, i) => ({ label: l, vals: [[12259, 7031, 9154], [24587, 8643, 12804]][i] })), series });
  chSource(g, EN ? 470 : 456, T.src);
});
