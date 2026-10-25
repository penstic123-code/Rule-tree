sketch(800, 442, g => {
  const { C } = g;
  const OR = '#c4682a', BL = '#3f6fc4', GR = '#1f8a62';
  g.text(24, 30, '一开会话就常驻在上下文里的规则，有多少字', { size: 22, weight: 700 });
  g.text(24, 60, 'Vibelearning 项目实测，按真实字符数', { size: 14, color: C.muted });

  const x0 = 250, x1 = 730, max = 12000, sc = v => x0 + (x1 - x0) * v / max;
  const rows = [
    { l: 'CLAUDE.md', s: '每个会话、每个子 agent 都带着', v: 11230, c: OR, ang: -41 },
    { l: '需求树：常驻部分', s: '只有根节点的全局规则', v: 257, c: GR, ang: 45 },
    { l: '需求树：全部规则', s: '改到对应文件时才加载', v: 1175, c: GR, ang: 45, dash: true },
  ];
  const yTop = 100, rh = 66;
  // 网格与坐标
  for (let t = 0; t <= max; t += 3000) {
    const x = sc(t);
    g.line(x, yTop - 8, x, yTop + rows.length * rh, { stroke: '#d9d0bd', strokeWidth: 1, roughness: 0.5 });
    g.text(x, yTop + rows.length * rh + 16, t.toLocaleString('en-US'), { size: 13, color: C.muted, anchor: 'middle' });
  }
  g.line(x0, yTop - 8, x0, yTop + rows.length * rh, { strokeWidth: 1.6 });
  g.text((x0 + x1) / 2, yTop + rows.length * rh + 40, '字符数', { size: 14, color: C.muted, anchor: 'middle' });
  rows.forEach((r, i) => {
    const y = yTop + i * rh, bh = 34;
    g.text(x0 - 12, y + 10, r.l, { size: 16, weight: 700, anchor: 'end' });
    g.text(x0 - 12, y + 32, r.s, { size: 13, color: C.muted, anchor: 'end' });
    const w = Math.max(sc(r.v) - x0, 4);
    g.rect(x0, y + 4, w, bh, { fill: r.c, fillStyle: 'hachure', hachureAngle: r.ang, hachureGap: 5, fillWeight: 1.8, stroke: r.dash ? r.c : C.ink, strokeWidth: 1.4, strokeLineDash: r.dash ? [6, 4] : undefined, roughness: 1 });
    g.text(x0 + w + 10, y + 22, r.v.toLocaleString('en-US'), { size: 17, weight: 700 });
  });

  // 脚注
  g.footnote(376, ['CLAUDE.md 放通用规范，需求树放各需求自己的规则']);
  g.text(776, 424, '数据：测试数据记录.md 第五节', { size: 13, color: C.muted, anchor: 'end' });
});
