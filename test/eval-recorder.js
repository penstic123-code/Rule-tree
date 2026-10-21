#!/usr/bin/env node
'use strict';
// 用真实的模型评测记录员：会不会改已有规则，而不是不停加相似的规则。
// 会花少量额度，所以不在 node --test 里，手动运行：node test/eval-recorder.js
const { spawn } = require('child_process');
const os = require('os');
const { buildPrompt, buildSweepPrompt, SWEEP_OPS } = require('../hooks/recorder');
const { applyOps, parse, findById, walk } = require('../src/parser');

const CLAUDE = process.env.REQTREE_CLAUDE_CMD || 'claude -p --model haiku --strict-mcp-config --no-session-persistence --setting-sources user';

const TREE = `# P 课程项目
- [段落] 段落不超过 4 行
- 每章练习题带解析

## C2 数据科学课 🔨
> 文件：DataScience/**
- 不引原话，全部自己叙述

### C2.1 第1章 🔨
> 文件：DataScience/ch01-*.html
- 开场用霍乱的故事
`;

const rulesOf = (text, id) => findById(parse(text), id).rules;
const count = text => [...text.matchAll(/^\s*-\s/gm)].length;

// 每个用例：用户的话、AI 的回复、对结果的检查（返回 null 表示通过，否则返回问题）
const CASES = [
  ['换说法重复', '练习题记得都要附上解析', '好的', (ops, t) => (count(t) > count(TREE) ? '加了一条相似的规则' : null)],
  ['修改已有规则', '第1章开头改成伦敦地图的故事吧', '好，第1章开场改用伦敦地图', (ops, t) => {
    const r = rulesOf(t, 'C2.1');
    if (r.some(x => /霍乱/.test(x.text))) return '旧规则还在';
    if (!r.some(x => /伦敦/.test(x.text))) return '没有新规则';
    return r.length === 1 ? null : '多了规则，没有改写原条';
  }],
  ['真的新规则', '以后每章结尾都加一道思考题', '好的，记下了', (ops, t) => (/思考题/.test(t) ? null : '没记下来')],
  ['一次性指令', '帮我把第1章第三段改短一点', '已改短', (ops, t) => (t === TREE ? null : `不该改树：${JSON.stringify(ops)}`)],
  ['否决规则', '段落 4 行的限制取消吧，不需要了', '好的', (ops, t) => (rulesOf(t, 'P').some(x => /4 行/.test(x.text)) ? '没有删除' : null)],
  ['子需求重复上级', '数据科学课也不要引用原话', '好的', (ops, t) => (count(t) > count(TREE) ? '重复加了上级已有的规则' : null)],
  // 某一章的内容决定是长期要求（实验一 6 次遗漏全是这一类，模型当成了一次性指令）
  ['章节内容决定（已有节点）', '第1章霍乱故事里要画出斯诺的那张地图', '好的，已经在霍乱故事里加上了斯诺地图', (ops, t) => {
    const r = rulesOf(t, 'C2.1');
    if (!r.some(x => /地图/.test(x.text))) return '没记到第1章';
    return r.some(x => /霍乱/.test(x.text)) ? null : '把原来的霍乱规则改没了';
  }],
  ['章节内容决定（没有节点）', '数据科学课第2章开头用冰淇淋销量和溺水人数的例子', '好的，第2章开场就用这个例子', (ops, t) => {
    const hit = [...walk(parse(t))].find(n => n.rules.some(x => /冰淇淋/.test(x.text)));
    if (!hit) return '没记下来';
    if (['P', 'C2', 'C2.1'].includes(hit.id)) return `挂错了地方：${hit.id}`;
    return hit.parent && hit.parent.id === 'C2' ? null : `新需求没放在数据科学课下面：${hit.id}`;
  }],
  ['章节内一次性修改', '第1章霍乱故事那段写得太啰嗦了，帮我压缩一下', '已压缩到三段', (ops, t) => (t === TREE ? null : `不该改树：${JSON.stringify(ops)}`)],
  // 子需求放宽上级规则：要在第1章用同一个 [段落] 键覆盖，不能加一条没键的（那样两条都生效、互相矛盾）
  ['子需求覆盖上级（同键）', '第1章开场可以写到6行', '好的，第1章开场段落放宽到 6 行', (ops, t) => {
    const r = rulesOf(t, 'C2.1').filter(x => /6/.test(x.text));
    if (!r.length) return '第1章没有记下 6 行';
    if (r.some(x => x.key !== '段落')) return `没用 [段落] 键覆盖：${JSON.stringify(r.map(x => [x.key, x.text]))}`;
    return rulesOf(t, 'P').some(x => x.key === '段落' && /4 行/.test(x.text)) ? null : '把全局的 4 行改掉了';
  }],
  // 在课程项目里聊的是需求树插件自己的界面（2026-10-22 真实会话里被记进了课程的根节点）：不是这个项目的需求
  ['别的工具的要求不记', '界面颜色只用来增加可读性', '好，需求树插件面板的配色我改成只用来区分层级、提高可读性', (ops, t) => (t === TREE ? null : `不该改树：${JSON.stringify(ops)}`)],
  // 真实对话回放里的主要错误：正在改第1章时顺口说的通用偏好被挂到了课程下面。第 5 项是这一轮 AI 改过的需求
  ['做第1章时说的通用偏好挂根节点', '你给我的反馈太含糊了，以后拿不准就先问清楚再动手', '好，以后拿不准先问你', (ops, t) => {
    if (rulesOf(t, 'P').some(x => /问清|先问/.test(x.text))) return null;
    const where = [...walk(parse(t))].find(n => n.rules.some(x => /问清|先问/.test(x.text)));
    return where ? `挂到了 ${where.id}` : '没记下来';
  }, ['C2.1']],
  ['做第1章时说的内容决定挂第1章', '第1章的例子都换成伦敦本地的数据', '好，第1章例子改用伦敦数据', (ops, t) => {
    if (rulesOf(t, 'C2.1').some(x => /伦敦/.test(x.text))) return null;
    const where = [...walk(parse(t))].find(n => n.rules.some(x => /伦敦/.test(x.text)));
    return where ? `挂到了 ${where.id}` : '没记下来';
  }, ['C2.1']],
];

function ask(prompt) {
  return new Promise(resolve => {
    const p = spawn(CLAUDE, { shell: true, cwd: os.tmpdir(), env: { ...process.env, REQTREE_RECORDER: '1' }, windowsHide: true });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('close', () => {
      const m = out.match(/\{[\s\S]*\}/);
      try { resolve(m ? JSON.parse(m[0]).ops || [] : null); } catch { resolve(null); }
    });
    p.stdin.end(prompt);
  });
}

// 补漏用例：最近几轮的用户原话（单轮判断可能漏了其中一句），对照树补上
const SWEEP_CASES = [
  // 实验一里单轮判断漏过这句（「已经加上了」让模型当成一次性）；混着一次性指令、已记过的、短回复
  ['补漏：补上漏记的章节决定', ['第1章霍乱故事那段帮我压缩一下', '第1章霍乱故事里要画出斯诺的那张地图', '练习题记得都要附上解析', '继续'], (ops, t) => {
    if (!rulesOf(t, 'C2.1').some(x => /地图/.test(x.text))) return '没补上斯诺地图';
    return count(t) === count(TREE) + 1 ? null : `多加了：${JSON.stringify(ops)}`;
  }],
  ['补漏：都已记过或一次性，不动', ['第1章开场就用霍乱的故事', '帮我把第1章第三段改短一点', '数据科学课不要引原话', '这个配色是什么色号？'], (ops, t) => (t === TREE ? null : `不该改树：${JSON.stringify(ops)}`)],
  // 实验一 n=5 里补漏犯过的两种错：把取消的东西记成「不设思考题」、把改标题当长期规则
  ['补漏：取消了的不补成「不要 X」', ['以后每章结尾都加一道思考题', '思考题取消吧，学生负担太重'], (ops, t) => (t === TREE ? null : `不该改树：${JSON.stringify(ops)}`)],
  ['补漏：改标题是一次性', ['把第1章的标题改成「霍乱与地图」', '继续'], (ops, t) => (t === TREE ? null : `不该改树：${JSON.stringify(ops)}`)],
];

(async () => {
  const runs = Number(process.argv[2]) || 1;
  const one = (name, prompt, check, allowed) => Array.from({ length: runs }, async () => {
    let ops = await ask(prompt);
    if (!ops) return { name, ok: false, why: '模型没返回 JSON' };
    if (allowed) ops = ops.filter(o => allowed.has(o.op));
    const { text } = applyOps(TREE, ops);
    const why = check(ops, text);
    return { name, ok: !why, why, ops };
  });
  const results = await Promise.all([
    ...CASES.flatMap(([name, user, ai, check, touched = []]) => one(name, buildPrompt(TREE, [{ user, ai }], touched, []), check)),
    ...SWEEP_CASES.flatMap(([name, msgs, check]) => one(name, buildSweepPrompt(TREE, msgs), check, SWEEP_OPS)),
  ]);
  let pass = 0;
  for (const r of results) {
    if (r.ok) pass++;
    console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : '：' + r.why}  ${JSON.stringify(r.ops || [])}`);
  }
  console.log(`\n通过 ${pass}/${results.length}`);
})();
