const T = EN ? {
  title: 'Moving real rules into the tree: how much less mess?',
  sub: ['Vibelearning’s 21 rule files moved into one tree by Sonnet; the same checker ran before and after'],
  series: ['Before', 'After'], left: 'Problems found', right: 'Always-loaded characters per session',
  groups: ['Duplicates', 'Contradictions', 'Stale', 'Total'],
  src: 'Data: 测试数据记录.md (test log), section 10, experiment A',
} : {
  title: '规则搬进需求树后，问题和常驻字数少了多少？',
  sub: ['Vibelearning 的 21 个规则文件由 Sonnet 搬进一棵树，搬前搬后用同一个体检程序'],
  series: ['搬家前', '搬家后'], left: '体检出的问题（个）', right: '每个会话常驻的字数',
  groups: ['重复', '矛盾', '过时', '合计'],
  src: '数据：测试数据记录.md 第十节 · 实验 A',
};
sketch(800, EN ? 456 : 440, g => {
  chTitle(g, T.title, T.sub);
  const series = [CH.grey, CH.green].map((s, i) => ({ ...s, name: T.series[i] }));
  chLegend(g, 24, 100, series);
  g.text(70, 136, T.left, { size: 15, weight: 700 });
  const vals = [[188, 129], [31, 31], [18, 4], [237, 164]];
  chVBars(g, { x0: 70, x1: 500, y0: 386, y1: 168, max: 250, step: 50, bw: 36, gap: 6,
    groups: T.groups.map((l, i) => ({ label: l, vals: vals[i] })), series });
  g.line(530, 130, 530, 400, { stroke: '#d9d0bd', strokeWidth: 1.2 });
  const rw = g.measure(T.right, 15, 700);
  g.text(EN ? 776 - rw : 560, 136, T.right, { size: 15, weight: 700 });
  chVBars(g, { x0: 616, x1: 770, y0: 386, y1: 168, max: 14000, step: 2000, bw: 50, gap: 10,
    groups: [{ label: '', vals: [12729, 7280] }], series });
  chSource(g, EN ? 440 : 424, T.src);
});
