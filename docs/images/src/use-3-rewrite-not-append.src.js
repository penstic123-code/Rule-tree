const T = EN ? {
  pile: ['Paras ≤ 4 lines', 'Max 4 lines a para', 'Paragraphs: 4 lines max', 'Keep paras within 4 lines', 'No para over 4 lines', 'Paras ≤ 4 lines (again)'],
  lines: ['Gentle, natural tone', '4–6 exercises a chapter'], old: 'Max 4 lines', neu: 'Paras ≤ 4 lines', undo: '↩ Undo',
  capL: 'Near-identical rules get added again and again',
  capR: 'The recorder rewrites the original instead of adding one. A wrong change is one click to undo.',
} : {
  pile: ['段落 ≤4 行', '段落最多四行', '段落不要超过 4 行', '每段别超过四行', '段落控制在 4 行内', '段落 ≤4 行（再说一次）'],
  lines: ['语气柔和自然', '每章 4–6 道练习题'], old: '段落最多四行', neu: '段落 ≤4 行', undo: '↩ 撤销',
  capL: '相似的规则加了一遍又一遍',
  capR: '记录员改写原条，不新增；记错了一键撤销',
};
usePanel({
  capL: T.capL, capR: T.capR,
  left(g, C) {
    g.doc(22, 20, 254, 248, {});
    T.pile.forEach((s, i) => {
      const y = 44 + i * 36;
      g.text(44 + (i % 2) * 8, y, s, { size: 15 });
      if (i > 0) g.text(30, y, '+', { size: 15, weight: 700 });
    });
  },
  right(g, C) {
    g.doc(326, 22, 254, 136, {});
    T.lines.forEach((s, i) => g.text(340, 48 + i * 32, s, { size: 15 }));
    const y = 116, ow = g.measure(T.old, 14);
    g.text(340, y, T.old, { size: 14, color: C.muted });
    g.line(338, y + 1, 342 + ow, y + 1, { stroke: C.red, strokeWidth: 1.6 });
    g.text(348 + ow, y + 1, '→', { size: 14 });
    const nx = 370 + ow, nw = g.measure(T.neu, 15, 700);
    g.rect(nx - 4, y - 13, nw + 8, 26, { fill: ACC_FILL, stroke: 'none' });
    g.text(nx, y + 1, T.neu, { size: 15, weight: 700 });
    // 橡皮擦 + 碎屑
    g.rect(352, 136, 30, 14, { fill: '#f3c6c0', stroke: '#8c8374', strokeWidth: 1.2 });
    [[388, 142], [394, 138], [392, 147]].forEach(([a, b]) => g.circle(a, b, 3, { fill: '#c9b8a8', stroke: 'none' }));
    // 记录员拿铅笔
    g.robot(392, 262, { scale: 0.62, name: 'rec' });
    g.poly([[416, 236], [422, 240], [nx + nw / 2 + 4, y + 18], [nx + nw / 2 - 2, y + 16]], { fill: '#f2c84b', strokeWidth: 1.2 });
    // 撤销按钮
    g.rect(474, 222, 96, 30, { fill: '#fffdf6', stroke: ACC, strokeWidth: 1.6 });
    g.text(522, 238, T.undo, { size: 15, weight: 700, anchor: 'middle', color: ACC_TEXT });
  },
});
