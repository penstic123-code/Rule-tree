sketch(800, 480, g => {
  const { C } = g;
  g.text(24, 30, 'Edit a file, and only the rules on its path come along', { size: 22, weight: 700 });

  // 左：树
  const N = {
    P: { x: 150, y: 92, t: 'P Root', on: true },
    C1: { x: 24, y: 196, t: 'C1 AI course' },
    C2: { x: 150, y: 196, t: 'C2 Data Science', on: true },
    C4: { x: 300, y: 196, t: 'C4 Apostles' },
    'C2.1': { x: 80, y: 300, t: 'C2.1 Chapter 1', on: true },
    'C2.2': { x: 232, y: 300, t: 'C2.2 Chapter 2' },
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
    if (!n.on) g.text(n.x + n.w / 2, n.y + 32, 'not loaded', { size: 13, color: C.muted, anchor: 'middle' });
  }
  g.text(N.P.x + N.P.w + 10, N.P.y + 1, 'applies everywhere', { size: 13, color: C.green });
  // 图例
  g.line(24, 392, 60, 392, { stroke: C.green, strokeWidth: 3.2 });
  g.text(70, 393, 'Loaded now: from the root down to', { size: 14 });
  g.text(70, 413, 'the item being edited', { size: 14 });
  g.line(24, 444, 60, 444, { stroke: '#a39a8a', strokeWidth: 1.4, strokeLineDash: [6, 6] });
  g.text(70, 445, 'Other branches: not needed, no context used', { size: 14, color: C.muted });

  // 右：正在改的文件
  g.doc(436, 58, 260, 58, { title: 'DataScience/ch01-cholera.html', tsize: 14 });
  g.text(448, 100, 'the file the AI is editing', { size: 13, color: C.blue });
  g.arrow(564, 124, 564, 150, { color: C.green, sw: 2 });

  g.rect(424, 158, 360, 248, { fill: '#fffdf6', strokeWidth: 1.6 });
  g.text(440, 180, 'Rules the AI gets this time', { size: 16, weight: 700 });
  const rules = [
    ['P', '[para] Paragraphs ≤ 4 lines', 'off'],
    ['P', 'Gentle, natural tone', ''],
    ['C2', 'No quotes; retell in own words', ''],
    ['C2.1', '[para] Opening paras: up to 6 lines', 'win'],
    ['C2.1', 'Build suspense within one screen', ''],
  ];
  rules.forEach(([id, s, k], i) => {
    const y = 216 + i * 36;
    g.tag(440, y, id, { size: 12, fill: id === 'P' ? C.sky : id === 'C2' ? C.mint : '#fdf1cf' });
    const x = 440 + 58, w = g.measure(s, 15);
    if (k === 'win') g.rect(x - 4, y - 13, w + 8, 26, { fill: C.yellow, stroke: 'none' });
    g.text(x, y + 1, s, { size: 15, color: k === 'off' ? C.muted : C.ink });
    if (k === 'off') g.line(x - 2, y + 1, x + w + 2, y + 1, { stroke: C.red, strokeWidth: 1.8 });
  });
  g.arrow(752, 324, 752, 240, { color: C.red, sw: 1.6, bend: -14 });
  g.text(604, 393, 'Same [para] key: the child overrides the parent in Ch. 1', { size: 13, color: C.red, anchor: 'middle' });
  g.text(604, 440, 'Editing Chapter 2? It’s still “Paragraphs ≤ 4 lines”', { size: 14, color: C.muted, anchor: 'middle' });
});
