const T = EN ? {
  ask: 'What is it\nworking on?', tree: ['Course', 'Ch. 1', 'Ch. 2', 'Ch. 3'], live: 'AI is editing: Ch. 1',
  capL: 'No idea which requirement the AI is working on',
  capR: 'The sidebar and map show, live, which requirement the AI is editing',
} : {
  ask: '它在改什么？', tree: ['课程', '第1章', '第2章', '第3章'], live: 'AI 正在改：第1章',
  capL: '不知道 AI 正在做哪个需求',
  capR: '侧栏和导图实时显示 AI 正在改哪个需求',
};
usePanel({
  capL: T.capL, capR: T.capR,
  left(g, C) {
    g.line(16, 262, 280, 262, { strokeWidth: 1.2, roughness: 1.2 });
    g.robot(222, 262, { scale: 0.75, name: 'robot' });
    g.rect(152, 196, 128, 66, { fill: '#d8cdb8', strokeWidth: 1.8 });
    for (let r = 0; r < 3; r++) { g.line(152, 196 + 22 * (r + 1), 280, 196 + 22 * (r + 1), { strokeWidth: 1, stroke: '#8c8374' }); for (let c = 0; c < 4; c++) g.line(168 + c * 32 + (r % 2) * 16, 196 + 22 * r, 168 + c * 32 + (r % 2) * 16, 218 + 22 * r, { strokeWidth: 1, stroke: '#8c8374' }); }
    g.person(76, 262, { scale: 0.72, hair: 'bun', shirt: C.pink, pose: 'point', tiptoe: true, name: 'user' });
    g.bubble(20, 22, 124, EN ? 52 : 40, 70, 118, { text: T.ask, size: 15 });
  },
  right(g, C) {
    miniTree(g, 346, 46, [
      { lv: 0, t: T.tree[0], st: 'doing' }, { lv: 1, t: T.tree[1], st: 'doing', glow: true },
      { lv: 1, t: T.tree[2], st: 'todo' }, { lv: 1, t: T.tree[3], st: 'todo' },
    ], 44);
    const w = g.measure(T.live, 15, 700) + 24;
    g.rect(586 - w, 214, w, 34, { fill: ACC_FILL, stroke: ACC, strokeWidth: 1.8 });
    g.text(586 - w + 12, 232, T.live, { size: 15, weight: 700, color: ACC_TEXT });
    g.path(`M${586 - w / 2} 212 Q${586 - w / 2} 150 ${452} 104`, { stroke: ACC, strokeWidth: 1.6, roughness: 0.6 });
  },
});
