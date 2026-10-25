const T = EN ? {
  bag: 'every rule', card: 'Editing Ch. 1: these 3',
  capL: 'Every rule is crammed into the context',
  capR: 'Only the rules for the file being edited come along',
} : {
  bag: '全部规则', card: '改第1章：带这 3 条',
  capL: '所有规则一股脑塞进上下文',
  capR: '改到哪个文件，才带上那个需求的规则',
};
usePanel({
  capL: T.capL, capR: T.capR,
  left(g, C) {
    g.line(16, 262, 280, 262, { strokeWidth: 1.2, roughness: 1.2 });
    [[96, 44], [124, 32], [160, 40], [194, 30], [224, 46]].forEach(([x, y]) => g.rect(x, y, 30, 44, { fill: '#fffdf6', strokeWidth: 1.2 }));
    g.path('M64 158 Q44 76 118 58 Q160 46 204 58 Q276 76 256 158 Q160 176 64 158 Z', { fill: C.gray, strokeWidth: 2 });
    g.text(160, 112, T.bag, { size: 17, weight: 700, anchor: 'middle' });
    g.path('M100 166 Q116 184 137 198', { strokeWidth: 3 }); g.path('M220 166 Q204 184 183 198', { strokeWidth: 3 });
    g.robot(160, 262, { scale: 0.75 });
    g.rect(137, 196, 7, 42, { fill: '#6b645a', stroke: 'none' }); g.rect(176, 196, 7, 42, { fill: '#6b645a', stroke: 'none' });
    [[210, 168], [222, 192], [104, 180]].forEach(([x, y]) => g.path(`M${x} ${y} Q${x + 7} ${y + 12} ${x} ${y + 15} Q${x - 7} ${y + 12} ${x} ${y}`, { fill: C.sky, strokeWidth: 1.2 }));
  },
  right(g, C) {
    g.line(320, 262, 586, 262, { strokeWidth: 1.2, roughness: 1.2 });
    g.robot(370, 262, { scale: 0.75 });
    g.rect(404, 92, 176, 132, { fill: '#fffdf6', stroke: ACC, strokeWidth: 2 });
    g.text(416, 114, T.card, { size: 13, weight: 700, color: ACC_TEXT });
    for (let k = 0; k < 3; k++) {
      const y = 148 + k * 26;
      g.circle(422, y, 9, { fill: ACC, stroke: ACC });
      g.line(434, y, 434 + [110, 84, 124][k], y, { stroke: '#8c8374', strokeWidth: 3, roughness: 0.6 });
    }
  },
});
