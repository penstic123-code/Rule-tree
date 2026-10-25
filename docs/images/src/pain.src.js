sketch(800, 490, g => {
  const { C } = g;
  g.text(26, 30, '规则散在好几个地方，越攒越乱', { size: 24, weight: 700 });

  // 左：聊天记录
  g.rect(22, 60, 196, 405, { fill: '#fffdf6', strokeWidth: 1.5 });
  g.text(120, 82, '聊天记录', { size: 17, weight: 700, anchor: 'middle' });
  g.line(34, 100, 206, 100, { strokeWidth: 1, stroke: C.muted });
  const msgs = [
    ['l', '段落别超过 4 行'], ['r', '好的'], ['l', '一次只开一个 agent'], ['r', '收到'],
    ['l', '……'], ['l', '改成两三章并行吧'], ['r', '好'], ['l', '……'], ['l', '练习改成 4–6 道'],
  ];
  let y = 116;
  for (const [side, s] of msgs) {
    const w = g.measure(s, 14) + 22, h = 26;
    const x = side === 'l' ? 34 : 206 - w;
    if (s === '……') { g.text(side === 'l' ? 44 : 196, y + 12, '……', { size: 14, color: C.muted, anchor: side === 'l' ? 'start' : 'end' }); y += 30; continue; }
    g.rect(x, y, w, h, { fill: side === 'l' ? C.sky : C.gray, strokeWidth: 1, roughness: 0.6 });
    g.text(x + 11, y + 14, s, { size: 14 });
    y += 35;
  }
  g.text(120, 438, '往上还有几百轮……', { size: 14, color: C.muted, anchor: 'middle' });

  // 上：三份文档
  const docs = [
    { x: 250, t: 'CLAUDE.md', lines: [['段落不超过 4 行', 'dup'], ['一次只开一个 agent', 'conf'], ['每章三道检查', '']] },
    { x: 433, t: 'memory', lines: [['可以两三章并行', 'conf'], ['段落 ≤4 行', 'dup'], ['第 1 章制作中', 'old']] },
    { x: 616, t: '课程文档.md', lines: [['段落最多四行', 'dup'], ['每章练习 5 道', 'old'], ['每章练习 4–6 道', '']] },
  ];
  for (const d of docs) {
    g.doc(d.x, 60, 166, 150, { title: d.t });
    d.lines.forEach(([s, k], i) => {
      const ly = 104 + i * 34, w = g.measure(s, 15);
      if (k === 'dup') g.rect(d.x + 8, ly - 12, w + 10, 24, { fill: C.yellow, stroke: 'none', roughness: 0.6 });
      if (k === 'conf') g.ellipse(d.x + 13 + w / 2, ly, w + 28, 32, { stroke: C.red, strokeWidth: 2 });
      g.text(d.x + 13, ly + 1, s, { size: 15, color: k === 'old' ? C.muted : C.ink });
      if (k === 'old') g.tag(d.x + 19 + w, ly + 1, '过时', { size: 12, fill: C.gray, color: C.muted });
    });
  }

  // 图例
  const ly = 238;
  g.rect(250, ly - 11, 30, 22, { fill: C.yellow, stroke: 'none' });
  g.text(288, ly, '同一条规则抄了 3 处', { size: 15 });
  g.ellipse(462, ly, 30, 22, { stroke: C.red, strokeWidth: 2 });
  g.text(484, ly, '两处说法打架', { size: 15, color: C.red });
  g.tag(612, ly + 1, '过时', { size: 12, fill: C.gray, color: C.muted });
  g.text(660, ly, '旧说法还留着', { size: 15, color: C.muted });

  // 下：AI 和人
  g.line(236, 468, 790, 468, { strokeWidth: 1.2, stroke: C.muted, roughness: 1.5 });
  g.robot(300, 468, { scale: 0.95, eyes: 'spiral' });
  g.bubble(352, 282, 140, 58, 320, 344, { text: '早先定的规则\n是哪条来着？', size: 15 });
  g.text(358, 378, '对话一长，AI 就忘了', { size: 16, color: C.red, weight: 700 });
  g.text(358, 404, '早先定好的规则', { size: 16, color: C.red, weight: 700 });
  g.person(712, 468, { scale: 0.92, pose: 'head', hair: 'bun', shirt: C.pink, mood: 'worried', name: 'user' });
  g.bubble(542, 280, 122, 56, 685, 318, { text: '到底以\n哪份为准？', size: 15 });
});
