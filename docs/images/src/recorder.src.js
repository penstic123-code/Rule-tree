sketch(800, 500, g => {
  const { C } = g;
  const step = (x, y, n, s) => { g.circle(x + 12, y, 26, { fill: C.gold, strokeWidth: 1.4 }); g.text(x + 12, y + 1, n, { size: 15, weight: 700, anchor: 'middle' }); g.text(x + 32, y + 1, s, { size: 17, weight: 700 }); };

  // ① 你说
  step(20, 34, '1', '你说了一条长期要求');
  g.person(70, 236, { scale: 0.62, hair: 'bun', shirt: C.pink, name: 'user' });
  g.bubble(108, 70, 200, 50, 92, 130, { text: '以后练习题都要带解析', size: 15 });

  g.arrow(318, 96, 418, 96, { color: C.ink });

  // ② 后台判断
  step(430, 34, '2', '这一轮结束，记录员在后台读');
  g.robot(470, 236, { scale: 0.62, name: 'rec' });
  g.text(516, 96, '读你的原话和 AI 的最后回复', { size: 14 });
  g.text(516, 124, '用 Haiku 判断要不要记，约 6 秒', { size: 14 });
  g.text(516, 152, '你不用等，可以接着聊', { size: 14 });
  g.text(516, 180, '「好」「继续」这类短回复直接跳过', { size: 14, color: C.muted });

  g.arrow(770, 196, 770, 286, { color: C.ink, bend: -10 });

  // ③ 找同主题
  step(430, 270, '3', '先找同主题的已有规则');
  g.doc(440, 296, 250, 132, { title: '需求树.md', tsize: 15 });
  const lines = ['段落不超过 4 行', '每章 4–6 道练习题', '语气柔和自然'];
  lines.forEach((s, i) => {
    const y = 342 + i * 30;
    if (i === 1) g.rect(448, y - 12, g.measure(s, 15) + 12, 24, { fill: C.yellow, stroke: 'none' });
    g.text(454, y + 1, s, { size: 15 });
  });
  g.circle(724, 360, 36, { stroke: C.blue, strokeWidth: 2.4 });
  g.line(737, 373, 756, 394, { stroke: C.blue, strokeWidth: 4 });
  g.text(440, 454, '找到就改写；实在没有，才新增一条', { size: 14, color: C.green });

  g.arrow(420, 356, 352, 356, { color: C.ink });

  // ④ 改写 + 撤销
  step(20, 270, '4', '改写这一条，不再多加一条');
  g.text(40, 314, '每章 4–6 道练习题', { size: 15, color: C.muted });
  g.line(38, 315, 40 + g.measure('每章 4–6 道练习题', 15) + 2, 315, { stroke: C.red, strokeWidth: 1.8 });
  g.arrow(100, 328, 100, 346, { color: C.ink, sw: 1.4, head: 8 });
  const ns = '每章 4–6 道练习题，带解析';
  g.rect(34, 348, g.measure(ns, 15) + 12, 26, { fill: C.mint, stroke: 'none' });
  g.text(40, 362, ns, { size: 15 });

  g.rect(34, 396, 300, 82, { fill: '#fffdf6', strokeWidth: 1.4 });
  g.text(48, 416, '面板 · 最近改动', { size: 13, weight: 700, color: C.muted });
  g.text(48, 442, '记录员改写了一条规则', { size: 15 });
  g.rect(238, 448, 82, 24, { fill: C.gray, strokeWidth: 1.2 });
  g.text(279, 461, '↩ 撤销', { size: 14, weight: 700, anchor: 'middle' });
  g.text(48, 465, '记错了？点一下', { size: 13, color: C.muted });

  // 回到 ①
  g.arrow(372, 300, 372, 150, { color: C.muted, sw: 1.4, dash: [6, 5] });
  g.text(382, 228, '下一轮', { size: 13, color: C.muted });
});
