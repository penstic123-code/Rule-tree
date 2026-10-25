const T = EN ? {
  title: 'A 32-turn conversation: rules missed or recorded wrong',
  sub: ['The user makes 13 lasting requests, changing their mind, cancelling some, adding exceptions.', '5 runs per setup, averaged; another model scored the result against an answer key'],
  series: ['AI keeps its own notes', 'AI keeps notes, carefully told how', 'RuleTree, earlier version', 'RuleTree, now'],
  groups: ['Missed (of 13)', 'Extra', 'Wrong'], y: 'average count',
  src: 'Data: docs/test-log.md',
} : {
  title: '一段 32 轮的对话之后，规则漏记、记错了几条？',
  sub: ['用户陆续提 13 条长期要求，中途改主意、取消、加例外；每组 5 遍取平均，另一个模型对照标准答案打分'],
  series: ['AI 自己记', 'AI 自己记（仔细交代过怎么记）', '需求树（旧版）', '需求树（现在）'],
  groups: ['漏记（共 13 条）', '多余', '记错'], y: '平均条数',
  src: '数据：docs/test-log.md',
};
sketch(800, 470, g => {
  chTitle(g, T.title, T.sub);
  const series = [CH.grey, CH.grey2, CH.green0, CH.green].map((s, i) => ({ ...s, name: T.series[i] }));
  const ly = chLegend(g, 24, EN ? 122 : 100, series);
  const vals = [[2.8, 4.2, 3.0, 0.2], [0.6, 1.0, 0, 0], [0.4, 0.4, 0, 0]];
  chVBars(g, { x0: 84, x1: 776, y0: 412, y1: ly + 46, max: 5, step: 1, bw: 38, gap: 8, fmt: v => v ? v.toFixed(1) : '0',
    groups: T.groups.map((l, i) => ({ label: l, vals: vals[i] })), series, yLabel: T.y });
  chSource(g, 456, T.src);
});
