const T = EN ? {
  md: ['## C2.1 Ch. 1', '> files: ch01-*', '- [para] …', '### C2.2', '- …'], head: 'Ch. 1', pills: ['To do', 'Doing', 'Done'], btn: '+ Add rule',
  capL: 'Nobody wants to hand-write Markdown',
  capR: 'Add rules, change status, undo: all with a click in the panel',
} : {
  md: ['## C2.1 第1章', '> 文件：ch01-*', '- [段落] …', '### C2.2', '- ……'], head: '第1章', pills: ['待做', '正在做', '完成'], btn: '+ 加规则',
  capL: '不想手写 Markdown',
  capR: '加规则、改状态、撤销，全部能在面板上点',
};
usePanel({
  capL: T.capL, capR: T.capR,
  left(g, C) {
    g.line(16, 262, 280, 262, { strokeWidth: 1.2, roughness: 1.2 });
    g.rect(122, 28, 156, 124, { fill: '#fffdf6', strokeWidth: 2 });
    T.md.forEach((s, i) => g.text(134, 48 + i * 22, s, { size: 13 }));
    g.line(200, 152, 200, 176, { strokeWidth: 2 }); g.rect(176, 176, 48, 8, { fill: C.gray });
    g.line(112, 186, 286, 186, { strokeWidth: 2 }); g.line(124, 186, 124, 262, { strokeWidth: 2 }); g.line(274, 186, 274, 262, { strokeWidth: 2 });
    g.person(62, 262, { scale: 0.72, hair: 'bun', shirt: C.pink, mood: 'worried', name: 'user' });
  },
  right(g, C) {
    g.rect(326, 26, 256, 206, { fill: '#fffdf6', strokeWidth: 1.6 });
    g.text(342, 50, T.head, { size: 17, weight: 700 });
    let x = 342;
    T.pills.forEach((p, i) => {
      const w = g.measure(p, 13) + 18;
      g.rect(x, 70, w, 24, { fill: i === 1 ? ACC_FILL : '#f3eee3', stroke: i === 1 ? ACC : '#c9bfae', strokeWidth: 1.2, roughness: 0.5 });
      g.text(x + 9, 83, p, { size: 13, weight: i === 1 ? 700 : 400 });
      x += w + 6;
    });
    [[124, 150], [150, 118]].forEach(([y, w]) => { g.circle(348, y, 6, { fill: '#8c8374', stroke: 'none' }); g.line(358, y, 358 + w, y, { stroke: '#8c8374', strokeWidth: 3, roughness: 0.6 }); });
    const bw = g.measure(T.btn, 15, 700) + 54;
    g.rect(342, 170, bw, 32, { fill: ACC_FILL, stroke: ACC, strokeWidth: 2 });
    g.text(354, 187, T.btn, { size: 15, weight: 700, color: ACC_TEXT });
    // 手指点按钮
    const hx = 342 + bw - 16, hy = 192;
    [[-14, -10], [0, -16], [14, -10]].forEach(([a, b]) => g.line(hx + a * 1.2, hy + b - 2, hx + a * 1.9, hy + b * 1.6 - 2, { stroke: ACC, strokeWidth: 1.6 }));
    g.rect(hx - 6, hy, 12, 34, { fill: '#f6dcc0', strokeWidth: 1.4 });
    g.rect(hx - 8, hy + 30, 34, 34, { fill: '#f6dcc0', strokeWidth: 1.4 });
    g.line(hx + 6, hy + 30, hx + 6, hy + 44, { strokeWidth: 1 }); g.line(hx + 16, hy + 30, hx + 16, hy + 44, { strokeWidth: 1 });
    g.rect(hx - 8, hy + 64, 34, 10, { fill: C.sky, strokeWidth: 1.2 });
  },
});
