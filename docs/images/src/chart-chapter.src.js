const T = EN ? {
  title: 'Rules and notes the AI reads to work on one chapter',
  sub: ['A project with six interactive web courses: rules all in CLAUDE.md and guide docs, vs. filed in the tree'],
  series: ['All in CLAUDE.md and guides', 'Filed in the tree'], x: 'characters',
  rows: ['AI', 'Data science', 'Anthropology', 'Twelve Apostles', 'Education', 'Game design'],
  src: 'Data: docs/test-log.md',
} : {
  title: '做一门课的一章，AI 要读多少字的规则和说明？',
  sub: ['一个有六门网页课程的项目：规则全写在 CLAUDE.md 和规范文档里，对比挂进需求树之后'],
  series: ['全写在 CLAUDE.md 和规范里', '挂进需求树之后'], x: '字数',
  rows: ['AI 课', '数据科学', '人类学', '十二门徒', '教育', '游戏设计'],
  src: '数据：docs/test-log.md',
};
sketch(800, 596, g => {
  chTitle(g, T.title, T.sub);
  const series = [CH.grey, CH.green].map((s, i) => ({ ...s, name: T.series[i] }));
  chLegend(g, 24, 100, series);
  const vals = [[23487, 16309], [16159, 10077], [27181, 16515], [18591, 9070], [21525, 12035], [16078, 9012]];
  chHBars(g, { x0: 160, x1: 700, yTop: 132, max: 30000, step: 5000, bh: 20, inner: 4, rowGap: 22,
    rows: T.rows.map((l, i) => ({ label: l, vals: vals[i] })), series, xLabel: T.x });
  chSource(g, 580, T.src);
});
