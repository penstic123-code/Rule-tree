const T = EN ? {
  title: 'Reorganizing a lopsided tree: before and after',
  sub: ['A copy of project A, reorganized 3 times (averages);', 'not one rule lost or reworded'],
  series: ['Before', 'After'], left: 'Project A (number of rules)',
  groups: ['At the top\n(sent with every file)', 'Received when\nediting one file'],
  src: 'Data: docs/test-log.md',
} : {
  title: '树长歪了，重新整理前后',
  sub: ['项目 A 的副本，整理 3 次取平均；规则一条没丢、原文没改'],
  series: ['整理前', '整理后'], left: '项目 A（规则条数）',
  groups: ['最顶上的规则\n（改什么都送）', '改一个文件\n收到的规则'],
  src: '数据：docs/test-log.md',
};
sketch(800, EN ? 510 : 490, g => {
  chTitle(g, T.title, T.sub);
  const series = [CH.grey, CH.green].map((s, i) => ({ ...s, name: T.series[i] }));
  const top = EN ? 122 : 100;
  chLegend(g, 24, top, series);
  g.text(70, top + 36, T.left, { size: 15, weight: 700 });
  chVBars(g, { x0: 70, x1: 776, y0: 404, y1: top + 72, max: 80, step: 20, bw: 52, gap: 10,
    groups: T.groups.map((l, i) => ({ label: '', vals: [[57, 33], [74, 55]][i] })), series });
  T.groups.forEach((l, i) => g.text(70 + 176 + i * 353, 432, l, { size: 14, weight: 700, anchor: 'middle' }));
  chSource(g, EN ? 494 : 476, T.src);
});
