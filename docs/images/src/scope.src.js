// 例子：一个小镇游戏的需求树，AI 改 shop_door.gd 时收到哪几块的规则。和 README 里那段需求树.md 是同一个例子
const T = EN ? {
  title: 'Example: what the AI gets when it edits shop_door.gd',
  N: { P: 'Town game', R1: 'Shops', R2: 'Roads & lamps', R3: 'Saving', R11: 'Shop door & hours', R12: 'Shelves' },
  files: { P: 'every file', R1: 'game/shops/**', R11: 'shop_door.gd' },
  notSent: 'not sent',
  legOn: 'Covers the file being edited: its rules are sent', legOff: 'Covers other files: not sent this time',
  file: 'game/shops/shop_door.gd', editing: 'the AI is editing this file',
  box: 'Rules the AI gets',
  rules: [['Town game', 'Comments in English'], ['Shops', 'Shopkeepers stay inside their shop'], ['Shop door & hours', 'Opening hours come only from ShopHours']],
  foot: ['Rules for roads, saving and shelves are not sent.', 'They arrive when the AI edits those files.'],
} : {
  title: '例子：AI 改 shop_door.gd 时，收到哪些规则',
  N: { P: '小镇游戏', R1: '店铺', R2: '道路与路灯', R3: '存档', R11: '店门与营业时间', R12: '货架' },
  files: { P: '所有文件', R1: 'game/shops/**', R11: 'shop_door.gd' },
  notSent: '不送',
  legOn: '管着正在改的文件：规则送到', legOff: '管别的文件：这次不送',
  file: 'game/shops/shop_door.gd', editing: 'AI 正在改这个文件',
  box: 'AI 收到的规则',
  rules: [['小镇游戏', '注释用中文'], ['店铺', '店员只在店里出现'], ['店门与营业时间', '营业时间只从 ShopHours 读']],
  foot: ['道路、存档、货架的规则这次不送，', 'AI 改到那些文件时才送。'],
};
sketch(800, 470, g => {
  const { C } = g;
  g.text(24, 30, T.title, { size: 21, weight: 700 });

  // 左：树。实线、绿色的是管 shop_door.gd 的那一路
  const N = {
    P: { x: 120, y: 96, on: true }, R1: { x: 40, y: 196, on: true }, R2: { x: 226, y: 196 }, R3: { x: 366, y: 196 },
    R11: { x: 24, y: 306, on: true }, R12: { x: 214, y: 306 },
  };
  for (const k in N) { N[k].t = T.N[k]; N[k].w = g.measure(N[k].t, 15, 700) + 22; }
  const edge = (a, b) => {
    const A = N[a], B = N[b], on = A.on && B.on;
    g.line(A.x + A.w / 2, A.y + 16, B.x + B.w / 2, B.y - 16, { stroke: on ? C.green : '#a39a8a', strokeWidth: on ? 3.2 : 1.4, strokeLineDash: on ? undefined : [6, 6] });
  };
  edge('P', 'R1'); edge('P', 'R2'); edge('P', 'R3'); edge('R1', 'R11'); edge('R1', 'R12');
  for (const k in N) {
    const n = N[k];
    g.rect(n.x, n.y - 16, n.w, 32, n.on ? { fill: C.mint, stroke: C.green, strokeWidth: 2.2 } : { fill: '#f3eee3', stroke: '#8c8374', strokeWidth: 1.2, strokeLineDash: [5, 4] });
    g.text(n.x + 11, n.y + 1, n.t, { size: 15, weight: 700, color: n.on ? C.ink : C.muted });
    // 管哪些文件：最下面一层写在框下，上面两层写在框右边（框下有连线）
    if (n.on && k === 'R11') g.text(n.x + n.w / 2, n.y + 32, T.files[k], { size: 13, color: C.green, anchor: 'middle' });
    else if (n.on) g.text(n.x + n.w + 8, n.y + 1, T.files[k], { size: 13, color: C.green });
    else g.text(n.x + n.w / 2, n.y + 32, T.notSent, { size: 13, color: C.muted, anchor: 'middle' });
  }
  g.line(24, 396, 60, 396, { stroke: C.green, strokeWidth: 3.2 });
  g.text(70, 397, T.legOn, { size: 14 });
  g.line(24, 428, 60, 428, { stroke: '#a39a8a', strokeWidth: 1.4, strokeLineDash: [6, 6] });
  g.text(70, 429, T.legOff, { size: 14, color: C.muted });

  // 右：正在改的文件 → 收到的规则
  g.doc(470, 58, 300, 58, { title: T.file, tsize: 15 });
  g.text(482, 100, T.editing, { size: 13, color: C.blue });
  g.arrow(620, 124, 620, 150, { color: C.green, sw: 2 });
  g.rect(454, 158, 330, 196, { fill: '#fffdf6', strokeWidth: 1.6 });
  g.text(470, 182, T.box, { size: 16, weight: 700 });
  T.rules.forEach(([from, s], i) => {
    const y = 220 + i * 44;
    g.tag(470, y - 8, EN ? 'from ' + from : '来自「' + from + '」', { size: 12, fill: [C.sky, C.mint, '#fdf1cf'][i] });
    g.text(476, y + 16, s, { size: 15 });
  });
  T.foot.forEach((s, i) => g.text(470, 390 + i * 24, s, { size: 14, color: C.muted }));
});
