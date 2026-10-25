const T = EN ? {
  title: 'Replaying real chats: how well are the rules kept?',
  sub: ['The author\'s real conversations replayed in order (12 sessions); a stronger model wrote the answer key.', 'The two rounds drew their answer keys separately (88 and 102 rules), so compare the shares'],
  series: ['Without RuleTree', 'RuleTree, earlier version', 'RuleTree, now'], left: 'Share of the answer key', right: 'General requests filed\nunder the current part',
  groups: ['Missed', 'Recorded wrong\n(wrong place or old wording)'], pct: v => v + '%',
  src: 'Data: docs/test-log.md',
} : {
  title: '回放真实对话：规则记得怎么样？',
  sub: ['作者 12 个真实对话按时间重放给记录员，另一个更强的模型列出该记下的规则当标准答案；', '旧版和现在各列了一次（88 条、102 条），所以比百分比'],
  series: ['不装需求树', '需求树（旧版）', '需求树（现在）'], left: '占标准答案的比例', right: '通用要求被挂到\n当时在做的那块下',
  groups: ['漏记', '记错\n（挂错地方、记了旧说法）'], pct: v => v + '%',
  src: '数据：docs/test-log.md',
};
sketch(800, EN ? 500 : 486, g => {
  chTitle(g, T.title, T.sub);
  const series = [CH.grey, CH.green0, CH.green].map((s, i) => ({ ...s, name: T.series[i] }));
  const top = 122;
  chLegend(g, 24, top, series);
  g.text(70, top + 36, T.left, { size: 15, weight: 700 });
  chVBars(g, { x0: 70, x1: 470, y0: 412, y1: top + 72, max: 25, step: 5, bw: 40, gap: 8, fmt: T.pct,
    groups: T.groups.map(() => ({ label: '', vals: [] })).map((gr, i) => ({ ...gr, vals: [[19.9, 14.2, 19.6], [10.2, 15.3, 4.9]][i] })), series });
  T.groups.forEach((l, i) => g.text(70 + 100 + i * 200, 440, l, { size: 14, weight: 700, anchor: 'middle' }));
  g.line(510, top + 24, 510, 430, { stroke: '#d9d0bd', strokeWidth: 1.2 });
  T.right.split('\n').forEach((l, i) => { const w = g.measure(l, 15, 700); g.text(776 - w, top + 36 + i * 20, l, { size: 15, weight: 700 }); });
  chVBars(g, { x0: 580, x1: 776, y0: 412, y1: top + 92, max: 100, step: 25, bw: 44, gap: 10, fmt: T.pct,
    groups: [{ label: '', vals: [70, 7] }], series: series.slice(1) });
  chSource(g, EN ? 484 : 470, T.src);
});
