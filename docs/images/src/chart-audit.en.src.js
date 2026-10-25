sketch(800, 540, g => {
  const { C } = g;
  const IN = { n: 'Within one batch of files', short: 'Within batch', c: '#c4682a', ang: -41 }, X = { n: 'Across files', short: 'Across files', c: '#3f6fc4', ang: 45 };
  g.text(24, 30, 'A health check of a real project’s rule docs: 237 problems', { size: 22, weight: 700 });
  g.text(24, 60, 'Vibelearning’s CLAUDE.md, 6 course docs, memory and more: 21 files, 81,810 characters.', { size: 14, color: C.muted });
  g.text(24, 82, 'Sonnet pulled out 991 rules and looked for duplicates, contradictions and stale ones.', { size: 14, color: C.muted });
  let lx = 24;
  [IN, X].forEach(s => {
    const y = 116;
    g.rect(lx, y - 9, 26, 18, { fill: s.c, fillStyle: 'hachure', hachureAngle: s.ang, hachureGap: 4, fillWeight: 1.6, strokeWidth: 1.2 });
    g.text(lx + 34, y + 1, s.n, { size: 14 });
    lx += 34 + g.measure(s.n, 14) + 30;
  });

  const x0 = 262, x1 = 700, max = 140, sc = v => x0 + (x1 - x0) * v / max;
  const rows = [
    { l: 'duplicates (groups)', s: X, v: 125 },
    { l: 'duplicates', s: IN, v: 63 },
    { l: 'contradictions', s: IN, v: 26 },
    { l: 'stale', s: IN, v: 18 },
    { l: 'contradictions', s: X, v: 5 },
  ];
  const yTop = 146, rh = 48, n = rows.length;
  for (let t = 0; t <= max; t += 20) {
    const x = sc(t);
    g.line(x, yTop - 6, x, yTop + n * rh, { stroke: '#d9d0bd', strokeWidth: 1, roughness: 0.5 });
    g.text(x, yTop + n * rh + 16, String(t), { size: 13, color: C.muted, anchor: 'middle' });
  }
  g.line(x0, yTop - 6, x0, yTop + n * rh, { strokeWidth: 1.6 });
  g.text((x0 + x1) / 2, yTop + n * rh + 40, 'number of problems', { size: 14, color: C.muted, anchor: 'middle' });
  rows.forEach((r, i) => {
    const y = yTop + i * rh;
    g.text(x0 - 12, y + 22, r.s.short + ' · ' + r.l, { size: 15, weight: 700, anchor: 'end' });
    const w = sc(r.v) - x0;
    g.rect(x0, y + 8, w, 30, { fill: r.s.c, fillStyle: 'hachure', hachureAngle: r.s.ang, hachureGap: 5, fillWeight: 1.8, strokeWidth: 1.3, roughness: 1 });
    g.text(x0 + w + 10, y + 24, String(r.v), { size: 16, weight: 700 });
  });

  g.footnote(456, ['Cross-file duplicates lead: one rule copied to several places, updated in one, stale in the rest.', '107 of the 237 involve CLAUDE.md. By severity: 6 high, 90 medium, 141 low.']);
  g.text(776, 526, 'Data: 测试数据记录.md (test log), section 9, experiment 2', { size: 13, color: C.muted, anchor: 'end' });
});
