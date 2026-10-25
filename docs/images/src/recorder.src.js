// 记录员的四步，用小镇游戏的例子（和 scope、pain 同一个）：用户改了营业时间的说法，记录员改写原来那条
const T = EN ? {
  s1: 'You state a lasting request', say: 'Don\'t hard-code the hours,\nread them from ShopHours',
  s2: 'When the turn ends, the recorder reads it',
  p2: ['Reads what you said and the AI\'s reply', 'A small model (Haiku) decides, ~6 s', 'You keep chatting, no waiting', 'Not sure? It asks you'],
  s3: 'Looks for an existing rule on the topic', doc: '需求树.md',
  lines: ['Comments in English', 'Shops open 9 to 21', 'Keepers stay inside'], found: 'Found one: rewrite it. Only add if none',
  s4: 'Rewrites that rule, no duplicate', old: 'Shops open 9 to 21', neu: 'Opening hours only from ShopHours',
  panel: 'Sidebar · Recent changes', did: 'Recorder rewrote a rule', wrong: 'Wrong? One click', undo: '↩ Undo', next: 'next turn',
} : {
  s1: '你说了一条长期要求', say: '营业时间别写死，\n从 ShopHours 读',
  s2: '这一轮结束，记录员在后台读',
  p2: ['读你这一轮的话和 AI 的回复', '小模型 Haiku 判断要不要记，约 6 秒', '你不用等，可以接着聊', '拿不准就弹出来问你'],
  s3: '先找同一件事的已有规则', doc: '需求树.md',
  lines: ['注释用中文', '营业时间 9 到 21 点', '店员只在店里出现'], found: '找到就改写；实在没有，才新加一条',
  s4: '改写这一条，不再多加一条', old: '营业时间 9 到 21 点', neu: '营业时间只从 ShopHours 读',
  panel: '侧栏 · 最近改动', did: '记录员改写了一条规则', wrong: '记错了？点一下', undo: '↩ 撤销', next: '下一轮',
};
sketch(800, 500, g => {
  const { C } = g;
  const step = (x, y, n, s) => { g.circle(x + 12, y, 26, { fill: C.gold, strokeWidth: 1.4 }); g.text(x + 12, y + 1, n, { size: 15, weight: 700, anchor: 'middle' }); g.text(x + 32, y + 1, s, { size: 17, weight: 700 }); };

  // ① 你说
  step(20, 34, '1', T.s1);
  g.person(70, 236, { scale: 0.62, hair: 'bun', shirt: C.pink, name: 'user' });
  g.bubble(108, 64, 210, 62, 92, 130, { text: T.say, size: 15 });

  g.arrow(326, 96, 418, 96, { color: C.ink });

  // ② 后台判断
  step(430, 34, '2', T.s2);
  g.robot(470, 236, { scale: 0.62, name: 'rec' });
  T.p2.forEach((s, i) => g.text(516, 96 + i * 28, s, { size: 14, color: i === 3 ? C.blue : C.ink }));

  g.arrow(770, 196, 770, 286, { color: C.ink, bend: -10 });

  // ③ 找同一件事的旧规则
  step(430, 270, '3', T.s3);
  g.doc(440, 296, 250, 132, { title: T.doc, tsize: 15 });
  T.lines.forEach((s, i) => {
    const y = 342 + i * 30;
    if (i === 1) g.rect(448, y - 12, g.measure(s, 15) + 12, 24, { fill: C.yellow, stroke: 'none' });
    g.text(454, y + 1, s, { size: 15 });
  });
  g.circle(724, 360, 36, { stroke: C.blue, strokeWidth: 2.4 });
  g.line(737, 373, 756, 394, { stroke: C.blue, strokeWidth: 4 });
  g.text(440, 454, T.found, { size: 14, color: C.green });

  g.arrow(420, 356, 352, 356, { color: C.ink });

  // ④ 改写 + 撤销
  step(20, 270, '4', T.s4);
  g.text(40, 314, T.old, { size: 15, color: C.muted });
  g.line(38, 315, 40 + g.measure(T.old, 15) + 2, 315, { stroke: C.red, strokeWidth: 1.8 });
  g.arrow(100, 328, 100, 346, { color: C.ink, sw: 1.4, head: 8 });
  g.rect(34, 348, g.measure(T.neu, 15) + 12, 26, { fill: C.mint, stroke: 'none' });
  g.text(40, 362, T.neu, { size: 15 });

  g.rect(34, 396, 300, 82, { fill: '#fffdf6', strokeWidth: 1.4 });
  g.text(48, 416, T.panel, { size: 13, weight: 700, color: C.muted });
  g.text(48, 442, T.did, { size: 15 });
  g.rect(238, 448, 82, 24, { fill: C.gray, strokeWidth: 1.2 });
  g.text(279, 461, T.undo, { size: 14, weight: 700, anchor: 'middle' });
  g.text(48, 465, T.wrong, { size: 13, color: C.muted });

  // 回到 ①
  g.arrow(372, 300, 372, 150, { color: C.muted, sw: 1.4, dash: [6, 5] });
  g.text(382, 228, T.next, { size: 13, color: C.muted });
});
