// 小红书封面：pain 图里「AI 忘了规则 / 到底以哪份为准」那一幕，按手机尺寸重画（540×650，DSF 2 → 1080 宽）
sketch(540, 650, g => {
  const { C } = g;
  g.line(10, 628, 530, 628, { strokeWidth: 1.4, stroke: C.muted, roughness: 1.5 });
  g.robot(100, 628, { scale: 2, eyes: 'spiral' });
  g.bubble(12, 196, 236, 100, 120, 318, { text: '早先定的规则\n是哪条来着？', size: 25 });
  g.text(204, 446, '对话一长，', { size: 22, color: C.red, weight: 700 });
  g.text(204, 480, 'AI 就忘了', { size: 22, color: C.red, weight: 700 });
  g.text(204, 514, '早先定好的规则', { size: 22, color: C.red, weight: 700 });
  g.person(446, 628, { scale: 1.9, pose: 'head', hair: 'bun', shirt: C.pink, mood: 'worried', name: 'user' });
  g.bubble(276, 104, 214, 100, 420, 236, { text: '到底以\n哪份为准？', size: 25 });
});
