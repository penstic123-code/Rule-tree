// 图表公共件：标题、图例、出处、分组竖条、分组横条。颜色：没装/之前 = 灰，需求树 = 绿（同 use-* 的强调色）
const CH = {
  grey: { c: '#8f877a', ang: -41 }, grey2: { c: '#5f5a52', ang: 90 },
  green0: { c: '#86c7a9', ang: 45 }, green: { c: '#1f8a62', ang: 45 },
};
const fmtN = v => (typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString('en-US') : String(v)) : v);
function chTitle(g, title, sub) {
  g.text(24, 30, title, { size: 22, weight: 700 });
  [].concat(sub || []).forEach((l, i) => g.text(24, 60 + i * 22, l, { size: 14, color: g.C.muted }));
}
function chSource(g, y, s) { g.text(g.W - 24, y, s, { size: 13, color: g.C.muted, anchor: 'end' }); }
function chLegend(g, x, y, series) {
  const x00 = x;
  series.forEach(s => {
    const w = 34 + g.measure(s.name, 14) + 26;
    if (x > x00 && x + w - 26 > g.W - 24) { x = x00; y += 26; }
    g.rect(x, y - 9, 26, 18, { fill: s.c, fillStyle: 'hachure', hachureAngle: s.ang, hachureGap: 4, fillWeight: 1.6, strokeWidth: 1.2 });
    g.text(x + 34, y + 1, s.name, { size: 14 });
    x += w;
  });
  return y;
}
const chBar = (g, x, y, w, h, s) => g.rect(x, y, w, h, { fill: s.c, fillStyle: 'hachure', hachureAngle: s.ang, hachureGap: 5, fillWeight: 1.8, strokeWidth: 1.3, roughness: 1 });
// 分组竖条：groups [{label, vals}]；series [{name, c, ang}]
function chVBars(g, o) {
  const { x0, x1, y0, y1, max, step, groups, series, bw = 44, gap = 8 } = o;
  const sc = v => y0 - (y0 - y1) * v / max;
  for (let t = 0; t <= max + 1e-9; t += step) {
    g.line(x0, sc(t), x1, sc(t), { stroke: '#d9d0bd', strokeWidth: 1, roughness: 0.5 });
    g.text(x0 - 10, sc(t), fmtN(t), { size: 13, color: g.C.muted, anchor: 'end' });
  }
  g.line(x0, y0, x1, y0, { strokeWidth: 1.6 });
  if (o.yLabel) g.text(x0 - 46, (y0 + y1) / 2, o.yLabel, { size: 13, color: g.C.muted, anchor: 'middle', rot: -90 });
  const gw = (x1 - x0) / groups.length, n = series.length;
  groups.forEach((gr, i) => {
    const cx = x0 + gw * i + gw / 2;
    gr.vals.forEach((v, j) => {
      const x = cx - (bw * n + gap * (n - 1)) / 2 + j * (bw + gap);
      if (v > 0) chBar(g, x, sc(v), bw, y0 - sc(v), series[j]);
      else g.line(x + 4, y0 - 2, x + bw - 4, y0 - 2, { stroke: series[j].c, strokeWidth: 3 });
      g.text(x + bw / 2, sc(v) - 13, o.fmt ? o.fmt(v) : fmtN(v), { size: o.vsize || 14, weight: 700, anchor: 'middle' });
    });
    g.text(cx, y0 + 20, gr.label, { size: 15, weight: 700, anchor: 'middle' });
  });
}
// 分组横条：rows [{label, sub, vals}]
function chHBars(g, o) {
  const { x0, x1, yTop, max, step, rows, series, bh = 18, inner = 4, rowGap = 18 } = o;
  const sc = v => x0 + (x1 - x0) * v / max, n = series.length, rh = n * bh + (n - 1) * inner + rowGap;
  const yEnd = yTop + rows.length * rh - rowGap + 6;
  for (let t = 0; t <= max + 1e-9; t += step) {
    g.line(sc(t), yTop - 6, sc(t), yEnd, { stroke: '#d9d0bd', strokeWidth: 1, roughness: 0.5 });
    g.text(sc(t), yEnd + 14, o.tick ? o.tick(t) : fmtN(t), { size: 13, color: g.C.muted, anchor: 'middle' });
  }
  g.line(x0, yTop - 6, x0, yEnd, { strokeWidth: 1.6 });
  if (o.xLabel) g.text((x0 + x1) / 2, yEnd + 36, o.xLabel, { size: 13, color: g.C.muted, anchor: 'middle' });
  rows.forEach((r, i) => {
    const y = yTop + i * rh, mid = y + (n * bh + (n - 1) * inner) / 2;
    if (r.sub) { g.text(x0 - 12, mid - 9, r.label, { size: 15, weight: 700, anchor: 'end' }); g.text(x0 - 12, mid + 12, r.sub, { size: 12, color: g.C.muted, anchor: 'end' }); }
    else g.text(x0 - 12, mid + 1, r.label, { size: 15, weight: 700, anchor: 'end' });
    r.vals.forEach((v, j) => {
      const by = y + j * (bh + inner), w = Math.max(sc(v) - x0, 3);
      chBar(g, x0, by, w, bh, series[j]);
      g.text(x0 + w + 8, by + bh / 2 + 1, r.labels ? r.labels[j] : fmtN(v), { size: 14, weight: 700 });
    });
  });
  return yEnd;
}
