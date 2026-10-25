const T = EN ? {
  docs: [['Chat', 'Paras ≤ 4 lines'], ['CLAUDE.md', 'Max 4 lines'], ['memory', '4 lines, tops'], ['notes.md', 'Short paras: 4']],
  tags: ['Chat', 'CLAUDE.md', 'memory', 'notes.md'], leaf: 'Paras ≤ 4 lines',
  capL: 'The same rule lives in four places. Which one counts?',
  capR: 'Every rule lives in one file, and each rule has exactly one place.',
} : {
  docs: [['聊天', '段落 ≤4 行'], ['CLAUDE.md', '段落最多四行'], ['memory', '别超过 4 行'], ['课程文档', '每段 4 行内']],
  tags: ['聊天', 'CLAUDE.md', 'memory', '课程文档'], leaf: '段落 ≤4 行',
  capL: '规则散在四处，不知道以哪份为准',
  capR: '所有规则写在一个文件里，每条只有一个位置',
};
usePanel({
  capL: T.capL, capR: T.capR,
  left(g, C) {
    T.docs.forEach(([t, r], i) => {
      const x = 20 + (i % 2) * 134, y = 24 + Math.floor(i / 2) * 124;
      g.doc(x, y, 122, 104, { title: t, tsize: 14 });
      g.text(x + 12, y + 64, r, { size: 14 });
    });
  },
  right(g, C) {
    // 树
    g.path('M572 262 C566 210 576 150 568 64', { stroke: '#7a5c3e', strokeWidth: 4, roughness: 1 });
    g.line(570, 200, 548, 226, { stroke: '#7a5c3e', strokeWidth: 2 }); g.circle(542, 232, 18, { stroke: ACC, strokeWidth: 1.4 });
    g.line(569, 96, 548, 74, { stroke: '#7a5c3e', strokeWidth: 2 }); g.circle(542, 66, 18, { stroke: ACC, strokeWidth: 1.4 });
    g.line(570, 150, 556, 136, { stroke: '#7a5c3e', strokeWidth: 2 });
    const lw = g.measure(T.leaf, 15, 700) + 22, lx = 556 - lw;
    g.rect(lx, 108, lw, 32, { fill: ACC_FILL, stroke: ACC, strokeWidth: 2 });
    g.text(lx + 11, 125, T.leaf, { size: 15, weight: 700 });
    T.tags.forEach((t, i) => {
      const y = 44 + i * 52, w = g.measure(t, 12) + 16;
      g.rect(324, y - 12, w, 24, { stroke: '#8c8374', strokeWidth: 1.2, strokeLineDash: [4, 3], roughness: 0.6 });
      g.text(332, y + 1, t, { size: 12 });
      g.arrow(324 + w + 4, y, lx - 6, 124 + (i - 1.5) * 4, { color: ACC, sw: 1.6, head: 8 });
    });
  },
});
