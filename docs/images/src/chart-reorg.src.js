const T = EN ? {
  title: 'Reorganizing a lopsided tree: before and after',
  sub: ['Copies of two real projects, reorganized 3 times each (averages);', 'not one rule lost or reworded'],
  series: ['Before', 'After'], left: 'The game project (rules)', right: 'Information architecture score',
  groups: ['At the top\n(sent with every file)', 'Received when\nediting one file'], scores: ['Game', 'Courses'],
  src: 'Data: docs/test-log.md',
} : {
  title: '树长歪了，重新整理前后',
  sub: ['两个真实项目的副本，各整理 3 次取平均；规则一条没丢、原文没改'],
  series: ['整理前', '整理后'], left: '游戏项目（规则条数）', right: '信息架构评分',
  groups: ['最顶上的规则\n（改什么都送）', '改一个文件\n收到的规则'], scores: ['游戏', '课程'],
  src: '数据：docs/test-log.md',
};
sketch(800, EN ? 486 : 466, g => {
  chTitle(g, T.title, T.sub);
  const series = [CH.grey, CH.green].map((s, i) => ({ ...s, name: T.series[i] }));
  const top = EN ? 122 : 100;
  chLegend(g, 24, top, series);
  g.text(70, top + 36, T.left, { size: 15, weight: 700 });
  chVBars(g, { x0: 70, x1: 470, y0: 404, y1: top + 72, max: 80, step: 20, bw: 52, gap: 10,
    groups: T.groups.map((l, i) => ({ label: '', vals: [[57, 33], [74, 55]][i] })), series });
  T.groups.forEach((l, i) => g.text(70 + 100 + i * 200, 432, l, { size: 14, weight: 700, anchor: 'middle' }));
  g.line(510, top + 24, 510, 420, { stroke: '#d9d0bd', strokeWidth: 1.2 });
  const rw = g.measure(T.right, 15, 700);
  g.text(776 - rw, top + 36, T.right, { size: 15, weight: 700 });
  chVBars(g, { x0: 580, x1: 776, y0: 404, y1: top + 72, max: 100, step: 25, bw: 36, gap: 6,
    groups: T.scores.map((l, i) => ({ label: l, vals: [[62, 81], [89, 94]][i] })), series });
  chSource(g, EN ? 470 : 452, T.src);
});
