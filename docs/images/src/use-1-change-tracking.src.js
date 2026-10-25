const T = EN ? {
  ver: 'v7?', tree: ['Course', 'Ch. 1', 'Ch. 2', 'Ch. 3'], log: 'Recent changes', items: ['Rule rewritten ↩', 'Ch. 1 → done', 'Added Ch. 3'],
  capL: 'The requirements keep changing. What do they say now?',
  capR: 'One tree shows it all: what’s done and which rules apply. Every change is logged and can be undone.',
} : {
  ver: '第 7 版？', tree: ['课程', '第1章', '第2章', '第3章'], log: '最近改动', items: ['改写规则 ↩', '第1章 完成', '加了第3章'],
  capL: '需求改了又改，现在到底是什么样？',
  capR: '一棵树看全貌：做到哪一步、哪版规则在生效；每次改动都有记录，能撤销',
};
usePanel({
  capL: T.capL, capR: T.capR,
  left(g, C) {
    g.line(16, 262, 280, 262, { strokeWidth: 1.2, roughness: 1.2 });
    for (let i = 0; i < 4; i++) g.doc(120 + i * 9, 40 + i * 16, 132, 150, {});
    const x = 147, y = 88;
    g.text(x + 12, y + 22, T.ver, { size: 16, weight: 700 });
    for (let k = 0; k < 4; k++) {
      const ly = y + 52 + k * 22, w = 70 + (k % 2) * 30;
      g.line(x + 12, ly, x + 12 + w, ly, { strokeWidth: 2, roughness: 1.5 });
      if (k !== 2) g.line(x + 8, ly - 7, x + 16 + w, ly + 7, { strokeWidth: 1.6 });
    }
    g.person(64, 262, { scale: 0.72, hair: 'bun', shirt: C.pink, mood: 'worried', name: 'user' });
    g.bubble(24, 30, 76, 42, 62, 118, { text: '？？', size: 18 });
  },
  right(g, C) {
    miniTree(g, 338, 52, [
      { lv: 0, t: T.tree[0], st: 'doing' }, { lv: 1, t: T.tree[1], st: 'done' },
      { lv: 1, t: T.tree[2], st: 'doing' }, { lv: 1, t: T.tree[3], st: 'todo' },
    ], 42);
    const tx = 462;
    g.text(tx, 46, T.log, { size: 14, weight: 700 });
    g.line(tx + 6, 66, tx + 6, 214, { stroke: '#a39a8a', strokeWidth: 1.4 });
    T.items.forEach((s, i) => {
      const y = 86 + i * 52;
      g.circle(tx + 6, y, 11, { fill: i === 0 ? ACC : '#fffdf6', stroke: ACC, strokeWidth: 1.6, roughness: 0.3 });
      g.text(tx + 18, y + 1, s, { size: 13 });
    });
  },
});
