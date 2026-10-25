// "它有什么用"对比小图：左半边麻烦（灰调），右半边需求树（一个强调色）。600×284，DSF 2 → 1200×568。
// 说明文字 capL/capR 不画进图里（放在 README 正文），源码里保留作对照
const ACC = '#1f8a62', ACC_TEXT = '#2f6f5e', ACC_FILL = '#d3eadf';
function usePanel(o) {
  sketch(600, 284, g => {
    const { C } = g;
    // 左右底色：左边略灰，右边留白
    g.rect(8, 8, 280, 268, { fill: '#efe9dc', stroke: 'none', roughness: 0.3 });
    g.rect(312, 8, 280, 268, { fill: '#fffdf6', stroke: ACC, strokeWidth: 1.2, roughness: 0.6 });
    g.muted(() => o.left(g, C));
    o.right(g, C);
    g.arrow(284, 142, 318, 142, { color: ACC, sw: 2.4, head: 11 });
  });
}
// 状态图标：done ✓ / doing 半圈 / todo 空圈
function stIcon(g, x, y, st) {
  if (st === 'done') { g.circle(x, y, 16, { fill: ACC, stroke: ACC, roughness: 0.3 }); g.path(`M${x - 4} ${y} L${x - 1} ${y + 3.5} L${x + 4.5} ${y - 3.5}`, { stroke: '#fff', strokeWidth: 2, roughness: 0.3 }); }
  else if (st === 'doing') { g.circle(x, y, 16, { stroke: ACC, strokeWidth: 2, roughness: 0.3 }); g.circle(x, y, 6, { fill: ACC, stroke: 'none', roughness: 0.2 }); }
  else g.circle(x, y, 16, { stroke: '#8c8374', strokeWidth: 1.6, roughness: 0.3 });
}
// 小树：rows = [{lv, t, st, glow}]，每行 rh 高
function miniTree(g, x, y, rows, rh = 34) {
  rows.forEach((r, i) => {
    const cy = y + i * rh, cx = x + r.lv * 20;
    if (r.lv) { const py = y + rows.slice(0, i).map((q, j) => q.lv === r.lv - 1 ? j : -1).filter(j => j >= 0).pop() * rh; g.path(`M${x + (r.lv - 1) * 20} ${py + 9} V${cy} H${cx - 9}`, { stroke: '#a39a8a', strokeWidth: 1.2, roughness: 0.5 }); }
    if (r.glow) {
      const w = g.measure(r.t, 14, 700) + 40;
      g.rect(cx - 13, cy - 14, w, 28, { fill: ACC_FILL, stroke: ACC, strokeWidth: 2 });
      g.rect(cx - 19, cy - 20, w + 12, 40, { stroke: ACC, strokeWidth: 1.2, strokeLineDash: [4, 4], roughness: 0.6 });
    }
    stIcon(g, cx, cy, r.st);
    g.text(cx + 14, cy + 1, r.t, { size: 14, weight: r.lv === 0 ? 700 : 400 });
  });
}
