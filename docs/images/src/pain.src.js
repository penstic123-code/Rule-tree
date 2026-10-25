// 痛点：同一个小镇游戏的要求散在聊天、CLAUDE.md、AI 的记忆、设计文档里（和 scope、recorder 是同一个例子）
const T = EN ? {
  title: 'Requests scattered across places, messier every week', chat: 'Chat history', more: 'hundreds more turns above…',
  msgs: [['l', 'Comments in English'], ['r', 'OK'], ['l', 'Shops open 9 to 21'], ['r', 'Got it'], ['l', '……'], ['l', 'Read hours from config'], ['r', 'OK'], ['l', '……'], ['l', 'Keepers stay inside']],
  docs: [['CLAUDE.md', [['Comments in English', 'dup'], ['Open 9 to 21', 'conf'], ['Saves in user://', '']]],
    ['AI memory', [['Hours from config', 'conf'], ['English comments', 'dup'], ['Doing shops', 'old']]],
    ['design.md', [['English comments', 'dup'], ['Keepers roam', 'old'], ['Keepers stay inside', '']]]],
  leg: ['Same request in 3 places', 'Two places disagree', 'Old wording left'], old: 'old',
  ai: 'Which rule did\nwe settle on?', aiNote: ['In a long chat the AI forgets', 'what was settled early on'], you: 'Which one\nis right?',
} : {
  title: '要求散在好几个地方，越攒越乱', chat: '聊天记录', more: '往上还有几百轮……',
  msgs: [['l', '注释用中文'], ['r', '好的'], ['l', '营业时间写死 9 到 21 点'], ['r', '收到'], ['l', '……'], ['l', '营业时间改成读配置'], ['r', '好'], ['l', '……'], ['l', '店员只在店里出现']],
  docs: [['CLAUDE.md', [['注释用中文', 'dup'], ['营业 9 到 21 点', 'conf'], ['存档放 user://', '']]],
    ['AI 的记忆', [['营业时间读配置', 'conf'], ['注释写中文', 'dup'], ['正在做店铺', 'old']]],
    ['设计文档.md', [['注释一律中文', 'dup'], ['店员可以上街', 'old'], ['店员只在店里', '']]]],
  leg: ['同一条要求抄了 3 处', '两处说法打架', '旧说法还留着'], old: '过时',
  ai: '早先定的是\n哪一条来着？', aiNote: ['对话一长，AI 就忘了', '早先定好的要求'], you: '到底以\n哪份为准？',
};
sketch(800, 490, g => {
  const { C } = g;
  g.text(26, 30, T.title, { size: 24, weight: 700 });

  // 左：聊天记录
  g.rect(22, 60, 196, 405, { fill: '#fffdf6', strokeWidth: 1.5 });
  g.text(120, 82, T.chat, { size: 17, weight: 700, anchor: 'middle' });
  g.line(34, 100, 206, 100, { strokeWidth: 1, stroke: C.muted });
  let y = 116;
  for (const [side, s] of T.msgs) {
    const w = g.measure(s, 14) + 22, h = 26;
    const x = side === 'l' ? 34 : 206 - w;
    if (s === '……') { g.text(side === 'l' ? 44 : 196, y + 12, '……', { size: 14, color: C.muted, anchor: side === 'l' ? 'start' : 'end' }); y += 30; continue; }
    g.rect(x, y, w, h, { fill: side === 'l' ? C.sky : C.gray, strokeWidth: 1, roughness: 0.6 });
    g.text(x + 11, y + 14, s, { size: 14 });
    y += 35;
  }
  g.text(120, 438, T.more, { size: 14, color: C.muted, anchor: 'middle' });

  // 上：三份文档
  const docs = T.docs.map(([t, lines], i) => ({ x: 250 + i * 183, t, lines }));
  for (const d of docs) {
    g.doc(d.x, 60, 166, 150, { title: d.t });
    d.lines.forEach(([s, k], i) => {
      const ly = 104 + i * 34, w = g.measure(s, 15);
      if (k === 'dup') g.rect(d.x + 8, ly - 12, w + 10, 24, { fill: C.yellow, stroke: 'none', roughness: 0.6 });
      if (k === 'conf') g.ellipse(d.x + 13 + w / 2, ly, w + 28, 32, { stroke: C.red, strokeWidth: 2 });
      g.text(d.x + 13, ly + 1, s, { size: 15, color: k === 'old' ? C.muted : C.ink });
      if (k === 'old') g.tag(d.x + 19 + w, ly + 1, T.old, { size: 12, fill: C.gray, color: C.muted });
    });
  }

  // 图例
  const ly = 238;
  g.rect(250, ly - 11, 30, 22, { fill: C.yellow, stroke: 'none' });
  g.text(288, ly, T.leg[0], { size: 15 });
  g.ellipse(462, ly, 30, 22, { stroke: C.red, strokeWidth: 2 });
  g.text(484, ly, T.leg[1], { size: 15, color: C.red });
  g.tag(612, ly + 1, T.old, { size: 12, fill: C.gray, color: C.muted });
  g.text(660, ly, T.leg[2], { size: 15, color: C.muted });

  // 下：AI 和人
  g.line(236, 468, 790, 468, { strokeWidth: 1.2, stroke: C.muted, roughness: 1.5 });
  g.robot(300, 468, { scale: 0.95, eyes: 'spiral' });
  g.bubble(352, 282, 140, 58, 320, 344, { text: T.ai, size: 15 });
  g.text(358, 378, T.aiNote[0], { size: 16, color: C.red, weight: 700 });
  g.text(358, 404, T.aiNote[1], { size: 16, color: C.red, weight: 700 });
  g.person(712, 468, { scale: 0.92, pose: 'head', hair: 'bun', shirt: C.pink, mood: 'worried', name: 'user' });
  g.bubble(542, 280, 122, 56, 685, 318, { text: T.you, size: 15 });
});
