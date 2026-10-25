sketch(800, 480, g => {
  const { C } = g;
  g.text(24, 30, '改到哪个文件，就只带上那条路上的规则', { size: 22, weight: 700 });

  // 左：树
  const N = {
    P: { x: 150, y: 92, t: 'P 根节点', on: true },
    C1: { x: 30, y: 196, t: 'C1 AI 课' },
    C2: { x: 150, y: 196, t: 'C2 数据科学课', on: true },
    C4: { x: 300, y: 196, t: 'C4 门徒课' },
    'C2.1': { x: 92, y: 300, t: 'C2.1 第1章', on: true },
    'C2.2': { x: 232, y: 300, t: 'C2.2 第2章' },
  };
  for (const k in N) N[k].w = g.measure(N[k].t, 15, 700) + 20;
  const edge = (a, b) => {
    const A = N[a], B = N[b], on = A.on && B.on;
    g.line(A.x + A.w / 2, A.y + 16, B.x + B.w / 2, B.y - 16, { stroke: on ? C.green : '#a39a8a', strokeWidth: on ? 3.2 : 1.4, strokeLineDash: on ? undefined : [6, 6] });
  };
  edge('P', 'C1'); edge('P', 'C2'); edge('P', 'C4'); edge('C2', 'C2.1'); edge('C2', 'C2.2');
  for (const k in N) {
    const n = N[k];
    g.rect(n.x, n.y - 16, n.w, 32, n.on ? { fill: C.mint, stroke: C.green, strokeWidth: 2.2 } : { fill: '#f3eee3', stroke: '#8c8374', strokeWidth: 1.2, strokeLineDash: [5, 4] });
    g.text(n.x + 10, n.y + 1, n.t, { size: 15, weight: 700, color: n.on ? C.ink : C.muted });
    if (!n.on) g.text(n.x + n.w / 2, n.y + 32, '不加载', { size: 13, color: C.muted, anchor: 'middle' });
  }
  g.text(N.P.x + N.P.w + 10, N.P.y + 1, '全局都管', { size: 13, color: C.green });
  // 图例
  g.line(30, 392, 66, 392, { stroke: C.green, strokeWidth: 3.2 });
  g.text(76, 393, '这次加载：从根到正在改的需求', { size: 14 });
  g.line(30, 424, 66, 424, { stroke: '#a39a8a', strokeWidth: 1.4, strokeLineDash: [6, 6] });
  g.text(76, 425, '别的分支：这次用不上，不占上下文', { size: 14, color: C.muted });

  // 右：正在改的文件
  g.doc(440, 58, 248, 58, { title: 'DataScience/ch01-cholera.html', tsize: 14 });
  g.text(452, 100, 'AI 正在改这个文件', { size: 13, color: C.blue });
  g.arrow(564, 124, 564, 150, { color: C.green, sw: 2 });

  g.rect(424, 158, 360, 248, { fill: '#fffdf6', strokeWidth: 1.6 });
  g.text(440, 180, '这次 AI 带上的规则', { size: 16, weight: 700 });
  const rules = [
    ['P', '[段落] 段落不超过 4 行', 'off'],
    ['P', '语气柔和自然', ''],
    ['C2', '不引原话，全部自己叙述', ''],
    ['C2.1', '[段落] 开场段落可以到 6 行', 'win'],
    ['C2.1', '一屏之内出现悬念', ''],
  ];
  rules.forEach(([id, s, k], i) => {
    const y = 216 + i * 36;
    const tw = g.tag(440, y, id, { size: 12, fill: id === 'P' ? C.sky : id === 'C2' ? C.mint : '#fdf1cf' });
    const x = 440 + 58, w = g.measure(s, 15);
    if (k === 'win') g.rect(x - 4, y - 13, w + 8, 26, { fill: C.yellow, stroke: 'none' });
    g.text(x, y + 1, s, { size: 15, color: k === 'off' ? C.muted : C.ink });
    if (k === 'off') g.line(x - 2, y + 1, x + w + 2, y + 1, { stroke: C.red, strokeWidth: 1.8 });
  });
  g.arrow(724, 324, 724, 240, { color: C.red, sw: 1.6, bend: -18 });
  g.text(604, 393, '同一个 [段落] 键：子规则在第1章里覆盖母规则', { size: 13, color: C.red, anchor: 'middle' });
  g.text(604, 440, '改第2章时，仍然是“段落不超过 4 行”', { size: 14, color: C.muted, anchor: 'middle' });
});
