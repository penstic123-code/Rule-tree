const T = EN ? {
  pt: 'Parent', pr: '≤ 4 lines', ct: 'Ch. 1', cr: '6-line opener', gt: 'Global', stamp: 'Wins in\nthis chapter',
  capL: 'Parent and child rules contradict each other',
  capR: 'A child rule explicitly overrides its parent, only within its own scope',
} : {
  pt: '母规则', pr: '≤4 行', ct: '第1章', cr: '开场 6 行', gt: '全局', stamp: '本章\n以此为准',
  capL: '母规则和子规则打架',
  capR: '子需求明确覆盖母规则，只在自己的范围里生效',
};
const face = (g, x, y) => { g.line(x - 16, y - 8, x - 6, y - 4, { strokeWidth: 1.8 }); g.line(x + 16, y - 8, x + 6, y - 4, { strokeWidth: 1.8 }); g.circle(x - 10, y + 2, 4, { fill: '#2b2620' }); g.circle(x + 10, y + 2, 4, { fill: '#2b2620' }); g.path(`M${x - 8} ${y + 16} Q${x} ${y + 10} ${x + 8} ${y + 16}`, { strokeWidth: 1.6, roughness: 0.4 }); };
usePanel({
  capL: T.capL, capR: T.capR,
  left(g, C) {
    g.doc(18, 70, 118, 150, { title: T.pt, tsize: 14 });
    g.text(30, 120, T.pr, { size: 17, weight: 700 });
    face(g, 77, 172);
    g.doc(162, 70, 118, 150, { title: T.ct, tsize: 14 });
    g.text(174, 120, T.cr, { size: 15, weight: 700 });
    face(g, 221, 172);
    g.path('M152 88 L140 118 L154 118 L142 150', { stroke: C.red, strokeWidth: 2.4, roughness: 0.6 });
    g.text(148, 50, '!?', { size: 22, weight: 700, anchor: 'middle' });
  },
  right(g, C) {
    g.doc(326, 40, 104, 92, { title: T.gt, tsize: 14 });
    g.text(338, 92, T.pr, { size: 16, weight: 700 });
    g.doc(448, 40, 134, 200, { title: T.ct, tsize: 14 });
    const w = g.measure(T.pr, 15);
    g.text(460, 88, T.pr, { size: 15, color: C.muted });
    g.line(458, 89, 462 + w, 89, { stroke: C.red, strokeWidth: 1.6 });
    const cw = g.measure(T.cr, 15, 700);
    g.rect(456, 108, cw + 10, 26, { fill: ACC_FILL, stroke: 'none' });
    g.text(461, 122, T.cr, { size: 15, weight: 700 });
    g.arrow(432, 92, 452, 92, { color: '#8c8374', sw: 1.2, head: 7, dash: [4, 3] });
    const grp = g.group({ transform: 'rotate(-7 515 190)' });
    g.rect(462, 164, 106, 54, { stroke: ACC, strokeWidth: 2.2, parent: grp });
    g.rect(467, 169, 96, 44, { stroke: ACC, strokeWidth: 1, parent: grp });
    g.text(515, 182, T.stamp, { size: 14, weight: 700, anchor: 'middle', color: ACC_TEXT, parent: grp });
  },
});
