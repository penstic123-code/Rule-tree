sketch(800, 490, g => {
  const { C } = g;
  g.text(26, 30, 'Rules end up everywhere, and it only gets messier', { size: 24, weight: 700 });

  // 左：聊天记录
  g.rect(22, 60, 196, 405, { fill: '#fffdf6', strokeWidth: 1.5 });
  g.text(120, 82, 'Chat history', { size: 17, weight: 700, anchor: 'middle' });
  g.line(34, 100, 206, 100, { strokeWidth: 1, stroke: C.muted });
  const msgs = [
    ['l', 'Paragraphs ≤ 4 lines'], ['r', 'OK'], ['l', 'One agent at a time'], ['r', 'Got it'],
    ['l', '……'], ['l', 'Run 2–3 in parallel'], ['r', 'Sure'], ['l', '……'], ['l', '4–6 exercises a chapter'],
  ];
  let y = 116;
  for (const [side, s] of msgs) {
    const w = g.measure(s, 14) + 22, h = 26;
    const x = side === 'l' ? 34 : 206 - w;
    if (s === '……') { g.text(side === 'l' ? 44 : 196, y + 12, '· · ·', { size: 18, color: C.muted, anchor: side === 'l' ? 'start' : 'end' }); y += 30; continue; }
    g.rect(x, y, w, h, { fill: side === 'l' ? C.sky : C.gray, strokeWidth: 1, roughness: 0.6 });
    g.text(x + 11, y + 14, s, { size: 14 });
    y += 35;
  }
  g.text(120, 438, 'Hundreds more turns above…', { size: 14, color: C.muted, anchor: 'middle' });

  // 上：三份文档
  const docs = [
    { x: 248, t: 'CLAUDE.md', lines: [['Paragraphs ≤ 4 lines', 'dup'], ['One agent at a time', 'conf'], ['3 checks per chapter', '']] },
    { x: 431, t: 'memory', lines: [['2–3 agents at once', 'conf'], ['Max 4 lines a para', 'dup'], ['Ch. 1 in progress', 'old']] },
    { x: 614, t: 'course-notes.md', lines: [['Paras: 4 lines max', 'dup'], ['5 exercises/ch.', 'old'], ['4–6 exercises/ch.', '']] },
  ];
  for (const d of docs) {
    g.doc(d.x, 60, 168, 150, { title: d.t });
    d.lines.forEach(([s, k], i) => {
      const ly = 104 + i * 34, w = g.measure(s, 15);
      if (k === 'dup') g.rect(d.x + 8, ly - 12, w + 10, 24, { fill: C.yellow, stroke: 'none', roughness: 0.6 });
      if (k === 'conf') g.ellipse(d.x + 13 + w / 2, ly, w + 32, 34, { stroke: C.red, strokeWidth: 2 });
      g.text(d.x + 13, ly + 1, s, { size: 15, color: k === 'old' ? C.muted : C.ink });
      if (k === 'old') g.tag(d.x + 19 + w, ly + 1, 'stale', { size: 12, fill: C.gray, color: C.muted });
    });
  }

  // 图例（按实际宽度依次排）
  const ly = 238;
  let lx = 248;
  g.rect(lx, ly - 11, 30, 22, { fill: C.yellow, stroke: 'none' }); lx += 38;
  g.text(lx, ly, 'Copied 3 times', { size: 15 }); lx += g.measure('Copied 3 times', 15) + 26;
  g.ellipse(lx + 15, ly, 30, 22, { stroke: C.red, strokeWidth: 2 }); lx += 38;
  g.text(lx, ly, 'Two places disagree', { size: 15, color: C.red }); lx += g.measure('Two places disagree', 15) + 26;
  lx += g.tag(lx, ly + 1, 'stale', { size: 12, fill: C.gray, color: C.muted }) + 8;
  g.text(lx, ly, 'Old, never deleted', { size: 15, color: C.muted });

  // 下：AI 和人
  g.line(236, 468, 790, 468, { strokeWidth: 1.2, stroke: C.muted, roughness: 1.5 });
  g.robot(300, 468, { scale: 0.95, eyes: 'spiral' });
  g.bubble(352, 282, 168, 58, 320, 344, { text: 'Which rule did we\nagree on earlier?', size: 15 });
  g.text(358, 378, 'In a long chat, the AI', { size: 16, color: C.red, weight: 700 });
  g.text(358, 404, 'forgets rules set early on', { size: 16, color: C.red, weight: 700 });
  g.person(712, 468, { scale: 0.92, pose: 'head', hair: 'bun', shirt: C.pink, mood: 'worried', name: 'user' });
  g.bubble(548, 280, 116, 56, 685, 318, { text: 'Which file\nis right?', size: 15 });
});
