const T = EN ? {
  title: 'Does the recorder get it right? 65 out of 65', sub: 'Real Haiku, 13 cases, 5 runs each',
  groups: [
    ['Basics · 6 cases', 'Reworded repeat: don’t add · change of mind: rewrite the original · new rule: add · one-off instruction: skip · rejected rule: delete · child repeats parent: don’t add', '30/30'],
    ['Chapter decisions · 3 cases', 'Content decisions for one chapter ×2 · a one-off edit inside a chapter', '15/15'],
    ['Catch-up review · 4 cases', 'Adds a missed rule ×1 · leaves things alone when nothing is missing ×3', '20/20'],
  ],
  src: 'Data: docs/test-log.md, section 1',
} : {
  title: '记录员判断得对不对？65 次全对', sub: '真实 Haiku，13 个用例，每个跑 5 遍',
  groups: [
    ['基本情形 · 6 个用例', '换说法重复不加 · 改主意改写原条 · 新规则才加 · 一次性指令不记 · 否决就删 · 子需求不重复上级', '30/30'],
    ['章节内容 · 3 个用例', '章节内容决定 ×2 · 章节内一次性修改', '15/15'],
    ['补漏复查 · 4 个用例', '补上漏记的要求 ×1 · 没漏时不乱改 ×3', '20/20'],
  ],
  src: '数据：docs/test-log.md 第一节',
};
sketch(800, EN ? 424 : 400, g => {
  chTitle(g, T.title, T.sub);
  let y = 104;
  const x0 = 24, x1 = 690;
  T.groups.forEach(([label, desc, val]) => {
    g.text(x0, y, label, { size: 16, weight: 700 });
    const lines = g.wrap(desc, x1 - x0, 13);
    lines.forEach((l, i) => g.text(x0, y + 22 + i * 19, l, { size: 13, color: g.C.muted }));
    const by = y + 22 + lines.length * 19 - 2;
    chBar(g, x0, by, x1 - x0, 24, CH.green);
    g.text(x1 + 10, by + 13, val, { size: 16, weight: 700 });
    y = by + 24 + 30;
  });
  chSource(g, EN ? 408 : 384, T.src);
});
