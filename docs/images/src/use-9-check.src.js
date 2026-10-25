const T = EN ? {
  rule: 'Rule: no debug prints', file: 'pay.gd', warn: 'Line 3 may break', warn2: '"no debug prints"',
  capL: 'The rule is written down, and the AI still slips',
  capR: 'Right after the edit, the new lines are checked and the AI is told',
} : {
  rule: '规则：不留调试输出', file: 'pay.gd', warn: '第 3 行可能违反', warn2: '「不留调试输出」',
  capL: '规则写着，AI 还是照犯',
  capR: 'AI 一改完，马上查它刚写的那几行，可能违反就告诉它',
};
const code = ['func pay(n):', '  money -= n', '  print("debug")'];
usePanel({
  capL: T.capL, capR: T.capR,
  left(g, C) {
    g.line(16, 262, 280, 262, { strokeWidth: 1.2, roughness: 1.2 });
    g.note(24, 26, 150, 40);
    g.text(36, 47, T.rule, { size: 13, weight: 700 });
    g.doc(24, 92, 158, 104);
    g.text(36, 112, T.file, { size: 12, weight: 700 });
    code.forEach((l, i) => g.text(36, 138 + i * 20, l, { size: 13 }));
    g.robot(232, 262, { scale: 0.75 });
  },
  right(g, C) {
    g.line(320, 262, 586, 262, { strokeWidth: 1.2, roughness: 1.2 });
    g.doc(330, 26, 158, 104);
    g.text(342, 46, T.file, { size: 12, weight: 700 });
    g.rect(337, 101, 140, 22, { fill: ACC_FILL, stroke: ACC, strokeWidth: 1.4, roughness: 0.5 });
    code.forEach((l, i) => g.text(342, 72 + i * 20, l, { size: 13 }));
    g.rect(426, 150, 154, 54, { fill: '#fffdf6', stroke: ACC, strokeWidth: 2 });
    g.text(438, 169, T.warn, { size: 13, weight: 700, color: ACC_TEXT });
    g.text(438, 190, T.warn2, { size: 13, color: ACC_TEXT });
    g.arrow(484, 134, 494, 148, { color: ACC, sw: 1.6, head: 7 });
    g.robot(372, 262, { scale: 0.75 });
  },
});
