sketch(800, 540, g => {
  const { C } = g;
  const step = (x, y, n, s) => { g.circle(x + 12, y, 26, { fill: C.gold, strokeWidth: 1.4 }); g.text(x + 12, y + 1, n, { size: 15, weight: 700, anchor: 'middle' }); g.text(x + 32, y + 1, s, { size: 17, weight: 700 }); };

  // ① 对话
  step(20, 34, '1', '你在对话里说一句');
  g.person(70, 250, { scale: 0.62, hair: 'bun', shirt: C.pink, pose: 'stand', name: 'user' });
  g.bubble(112, 70, 128, 64, 92, 150, { text: '以后段落都\n别超过 4 行', size: 15 });

  g.arrow(244, 165, 282, 165, { color: C.ink });

  // ② 记录员
  step(286, 34, '2', '记录员记下来');
  g.robot(330, 250, { scale: 0.62, name: 'rec' });
  g.note(378, 92, 96, 76, { fill: C.yellow, rot: 3, text: '新规则：\n段落 ≤4 行', size: 15 });
  g.text(286, 282, '每轮结束后在后台跑，不用等', { size: 14, color: C.muted });

  g.arrow(484, 165, 516, 165, { color: C.ink });

  // ③ 需求树
  step(520, 34, '3', '写进一棵树');
  g.doc(520, 58, 268, 240, { title: '需求树.md', tsize: 16 });
  const rows = [
    { lv: 0, id: 'P', name: '项目', rule: '段落 ≤4 行', y: 106 },
    { lv: 1, id: 'C1', name: 'AI 课', rule: '例子都配图', y: 150, py: 106 },
    { lv: 1, id: 'C2', name: '数据课', rule: '不引原话', y: 194, py: 106 },
    { lv: 2, id: 'C2.1', name: '第1章', rule: '开场可到 6 行', y: 238, py: 194 },
  ];
  const nx = r => 532 + r.lv * 24;
  for (const r of rows) {
    const label = r.id + ' ' + r.name, w = g.measure(label, 14, 700) + 14;
    if (r.lv) { const px = nx({ lv: r.lv - 1 }) + 10; g.path(`M${px} ${r.py + 13} V${r.y} H${nx(r) - 1}`, { strokeWidth: 1.2, stroke: C.muted, roughness: 0.6 }); }
    g.rect(nx(r), r.y - 13, w, 26, { fill: r.lv === 0 ? C.sky : r.lv === 1 ? C.mint : '#fdf1cf', strokeWidth: 1.2, roughness: 0.6 });
    g.text(nx(r) + 7, r.y + 1, label, { size: 14, weight: 700 });
    g.text(nx(r) + w + 8, r.y + 1, r.rule, { size: 14, color: C.green });
  }
  g.text(532, 276, '母规则管全局，子规则只管一个需求', { size: 13, color: C.muted });

  g.arrow(654, 304, 654, 334, { color: C.ink });

  // ④ 编译
  step(520, 352, '4', '编译成规则文件');
  const cards = [['P.md', '所有文件'], ['C1.md', 'AI课/**'], ['C2.md', 'DataScience/**'], ['C2.1.md', '…/ch01-*']];
  cards.forEach(([n, p], i) => {
    const x = 524 + (i % 2) * 134, y = 378 + Math.floor(i / 2) * 70;
    g.doc(x, y, 124, 58, { title: n, tsize: 15 });
    g.text(x + 12, y + 42, p, { size: 13, color: C.blue });
  });
  g.text(524, 522, '放进 .claude/rules/，每份写明管哪些文件', { size: 13, color: C.muted });

  g.arrow(512, 440, 470, 440, { color: C.ink });

  // ⑤ AI 按需加载
  step(20, 352, '5', 'AI 改哪个文件，就带上哪份规则');
  g.robot(66, 520, { scale: 0.62, name: 'ai' });
  g.doc(104, 392, 150, 66, { title: 'ch01.html', tsize: 15 });
  g.text(116, 440, 'DataScience/', { size: 13, color: C.blue });
  g.text(116, 482, '↑ AI 正在改这个文件', { size: 14, color: C.muted });
  const got = [['带上', 'P、C2、C2.1 的规则', C.green, C.mint], ['不带', 'C1 的规则', C.muted, C.gray]];
  got.forEach(([t, s, col, fill], i) => {
    const y = 412 + i * 44;
    const w = g.tag(282, y, t, { fill, color: col === C.muted ? C.ink : col });
    g.text(282 + w + 8, y + 1, s, { size: 15, color: col === C.muted ? C.ink : C.ink });
  });
});
