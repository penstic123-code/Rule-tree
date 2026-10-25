sketch(800, 540, g => {
  const { C } = g;
  const step = (x, y, n, s) => { g.circle(x + 12, y, 26, { fill: C.gold, strokeWidth: 1.4 }); g.text(x + 12, y + 1, n, { size: 15, weight: 700, anchor: 'middle' }); g.text(x + 32, y + 1, s, { size: 17, weight: 700 }); };

  // ① 对话
  step(20, 34, '1', 'You say it once in chat');
  g.person(70, 250, { scale: 0.62, hair: 'bun', shirt: C.pink, pose: 'stand', name: 'user' });
  g.bubble(108, 70, 136, 64, 92, 150, { text: 'From now on, keep\nparagraphs ≤ 4 lines', size: 14 });

  g.arrow(248, 165, 282, 165, { color: C.ink });

  // ② 记录员
  step(286, 34, '2', 'The recorder notes it');
  g.robot(330, 250, { scale: 0.62, name: 'rec' });
  g.note(376, 92, 104, 76, { fill: C.yellow, rot: 3, text: 'New rule:\nparagraphs\n≤ 4 lines', size: 14 });
  g.text(286, 276, 'Runs in the background after', { size: 14, color: C.muted });
  g.text(286, 296, 'each turn, so you never wait', { size: 14, color: C.muted });

  g.arrow(486, 165, 516, 165, { color: C.ink });

  // ③ 需求树
  step(520, 34, '3', 'It goes into one tree');
  g.doc(520, 58, 268, 240, { title: '需求树.md (the tree file)', tsize: 15 });
  const rows = [
    { lv: 0, id: 'P', name: 'Root', rule: '≤ 4 lines a paragraph', y: 106 },
    { lv: 1, id: 'C1', name: 'AI course', rule: 'Illustrate examples', y: 150, py: 106 },
    { lv: 1, id: 'C2', name: 'Data course', rule: 'No quotes', y: 194, py: 106 },
    { lv: 2, id: 'C2.1', name: 'Ch. 1', rule: 'Opening: 6 lines OK', y: 238, py: 194 },
  ];
  const nx = r => 532 + r.lv * 22;
  for (const r of rows) {
    const label = r.id + ' ' + r.name, w = g.measure(label, 14, 700) + 14;
    if (r.lv) { const px = nx({ lv: r.lv - 1 }) + 10; g.path(`M${px} ${r.py + 13} V${r.y} H${nx(r) - 1}`, { strokeWidth: 1.2, stroke: C.muted, roughness: 0.6 }); }
    g.rect(nx(r), r.y - 13, w, 26, { fill: r.lv === 0 ? C.sky : r.lv === 1 ? C.mint : '#fdf1cf', strokeWidth: 1.2, roughness: 0.6 });
    g.text(nx(r) + 7, r.y + 1, label, { size: 14, weight: 700 });
    g.text(nx(r) + w + 8, r.y + 1, r.rule, { size: 13, color: C.green });
  }
  g.text(532, 276, 'Parent rules: global. Child rules: local.', { size: 13, color: C.muted });

  g.arrow(654, 304, 654, 334, { color: C.ink });

  // ④ 编译
  step(520, 352, '4', 'Compiled into rule files');
  const cards = [['P.md', 'all files'], ['C1.md', 'AI/**'], ['C2.md', 'DataScience/**'], ['C2.1.md', '…/ch01-*']];
  cards.forEach(([n, p], i) => {
    const x = 524 + (i % 2) * 134, y = 378 + Math.floor(i / 2) * 70;
    g.doc(x, y, 124, 58, { title: n, tsize: 15 });
    g.text(x + 12, y + 42, p, { size: 13, color: C.blue });
  });
  g.text(524, 522, 'In .claude/rules/, each with its own paths', { size: 13, color: C.muted });

  g.arrow(512, 440, 470, 440, { color: C.ink });

  // ⑤ AI 按需加载
  step(20, 352, '5', 'The AI loads only the rules for the file it edits');
  g.robot(66, 520, { scale: 0.62, name: 'ai' });
  g.doc(104, 392, 150, 66, { title: 'ch01.html', tsize: 15 });
  g.text(116, 440, 'DataScience/', { size: 13, color: C.blue });
  g.text(116, 482, '↑ the file the AI is editing', { size: 14, color: C.muted });
  const got = [['Loads', 'rules from P, C2, C2.1', C.green, C.mint], ['Skips', 'rules from C1', C.muted, C.gray]];
  got.forEach(([t, s, col, fill], i) => {
    const y = 412 + i * 44;
    const w = g.tag(276, y, t, { fill, color: col === C.muted ? C.ink : col });
    g.text(276 + w + 8, y + 1, s, { size: 15 });
  });
});
