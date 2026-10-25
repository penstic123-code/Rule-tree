const T = EN ? {
  press: 'compact', after: 'after compaction', sub: 'subagent',
  capL: 'In a long chat, once the context is compacted, the AI forgets the rules',
  capR: 'Rules ride on Claude Code’s native loading, so they survive compaction and reach subagents',
} : {
  press: '压缩', after: '压缩后', sub: '子 agent',
  capL: '对话一长、上下文一压缩，AI 就忘了规则',
  capR: '规则交给 Claude Code 原生机制，压缩后、子 agent 里照样生效',
};
const ruleCard = (g, x, y, w, h, fill) => { g.rect(x, y, w, h, { fill, strokeWidth: 1.2, roughness: 0.6 }); for (let k = 1; k <= 2; k++) g.line(x + 5, y + k * h / 3, x + w - 6, y + k * h / 3, { stroke: '#8c8374', strokeWidth: 1, roughness: 0.5 }); };
usePanel({
  capL: T.capL, capR: T.capR,
  left(g, C) {
    g.line(16, 262, 280, 262, { strokeWidth: 1.2, roughness: 1.2 });
    g.robot(64, 262, { scale: 0.72, eyes: 'spiral' });
    // 被压扁的记忆盒
    g.rect(112, 120, 156, 22, { fill: '#fffdf6', strokeWidth: 1.4 });
    [118, 160, 214].forEach(x => g.rect(x, 124, 30, 12, { fill: C.yellow, strokeWidth: 1, roughness: 0.5 }));
    g.rect(104, 98, 172, 14, { fill: C.gray, strokeWidth: 1.4 });
    g.rect(104, 150, 172, 14, { fill: C.gray, strokeWidth: 1.4 });
    g.arrow(190, 52, 190, 92, { sw: 2.4 }); g.arrow(190, 210, 190, 170, { sw: 2.4 });
    g.text(204, 66, T.press, { size: 15, weight: 700 });
    [[94, 150], [102, 140], [108, 130]].forEach(([a, b], i) => g.circle(a, b, 5 + i * 2, { strokeWidth: 1 }));
    // 掉出来的规则
    ruleCard(g, 216, 186, 34, 22, C.yellow); ruleCard(g, 238, 226, 34, 22, C.yellow); ruleCard(g, 130, 220, 34, 22, C.yellow);
  },
  right(g, C) {
    g.line(320, 262, 586, 262, { strokeWidth: 1.2, roughness: 1.2 });
    g.tag(326, 30, T.after, { size: 13, fill: ACC_FILL, color: ACC_TEXT });
    [['ch01.html', 56], ['ch02.html', 140]].forEach(([n, y]) => {
      g.doc(326, y, 100, 70, { title: n, tsize: 12 });
      ruleCard(g, 404, y + 26, 46, 30, ACC_FILL);
      g.circle(427, y + 26, 9, { fill: ACC, stroke: ACC });
    });
    g.robot(496, 262, { scale: 0.7, name: 'ai' });
    ruleCard(g, 446, 210, 30, 22, ACC_FILL);
    g.robot(566, 262, { scale: 0.45, name: 'sub' });
    ruleCard(g, 536, 228, 22, 16, ACC_FILL);
    g.text(566, 182, T.sub, { size: 12, anchor: 'middle' });
  },
});
