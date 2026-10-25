sketch(800, 506, g => {
  const { C } = g;
  const IN = { n: '同一批文件内', c: '#c4682a', ang: -41 }, X = { n: '跨文件', c: '#3f6fc4', ang: 45 };
  g.text(24, 30, '体检一个真实项目的规则文档：237 个问题', { size: 22, weight: 700 });
  g.text(24, 60, 'Vibelearning 的 CLAUDE.md、6 份课程文档、memory 等 21 个文件，共 81,810 字；Sonnet 抽出 991 条规则来查', { size: 14, color: C.muted });
  [IN, X].forEach((s, i) => {
    const x = 24 + i * 170, y = 94;
    g.rect(x, y - 9, 26, 18, { fill: s.c, fillStyle: 'hachure', hachureAngle: s.ang, hachureGap: 4, fillWeight: 1.6, strokeWidth: 1.2 });
    g.text(x + 34, y + 1, s.n, { size: 14 });
  });

  const x0 = 210, x1 = 690, max = 140, sc = v => x0 + (x1 - x0) * v / max;
  const rows = [
    { l: '重复', s: X, v: 125, note: '按组计' },
    { l: '重复', s: IN, v: 63 },
    { l: '矛盾', s: IN, v: 26 },
    { l: '过时', s: IN, v: 18 },
    { l: '矛盾', s: X, v: 5 },
  ];
  const yTop = 124, rh = 48, n = rows.length;
  for (let t = 0; t <= max; t += 20) {
    const x = sc(t);
    g.line(x, yTop - 6, x, yTop + n * rh, { stroke: '#d9d0bd', strokeWidth: 1, roughness: 0.5 });
    g.text(x, yTop + n * rh + 16, String(t), { size: 13, color: C.muted, anchor: 'middle' });
  }
  g.line(x0, yTop - 6, x0, yTop + n * rh, { strokeWidth: 1.6 });
  g.text((x0 + x1) / 2, yTop + n * rh + 40, '问题个数', { size: 14, color: C.muted, anchor: 'middle' });
  rows.forEach((r, i) => {
    const y = yTop + i * rh;
    g.text(x0 - 12, y + 22, r.s.n + ' · ' + r.l + (r.note ? '（' + r.note + '）' : ''), { size: 15, weight: 700, anchor: 'end' });
    const w = sc(r.v) - x0;
    g.rect(x0, y + 8, w, 30, { fill: r.s.c, fillStyle: 'hachure', hachureAngle: r.s.ang, hachureGap: 5, fillWeight: 1.8, strokeWidth: 1.3, roughness: 1 });
    g.text(x0 + w + 10, y + 24, String(r.v), { size: 16, weight: 700 });
  });

  g.footnote(432, ['最多的是跨文件重复：同一条规则抄在好几处，改了一处，别处还是旧的。', '237 个问题里 107 个涉及 CLAUDE.md；按严重度分，高 6 个，中 90 个，低 141 个。']);
  g.text(776, 490, '数据：测试数据记录.md 第九节 · 实验二', { size: 13, color: C.muted, anchor: 'end' });
});
