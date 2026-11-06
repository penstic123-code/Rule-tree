'use strict';
// 给 Claude 插件面板用的编辑入口：只放行四种改规则的操作，走和 VS Code 扩展同一条 store 路径，
// 所以每次改动都记进改动记录、可以撤销。不依赖 VS Code。
const store = require('./store');

// 面板只需要这四种；改名、删需求、改文件范围等留给 VS Code 扩展，不在这里放开
const ALLOWED = new Set(['set_status', 'add_rule', 'replace_rule', 'remove_rule']);

const REASON = {
  'unknown-op': '不认识的操作',
  'no-node': '找不到这个需求',
};

// 这次是不是没改成：把核心给的 skipped 原因翻成一句话
function whyText(skipped) {
  if (!skipped || !skipped.length) return '没有可改的内容（可能已经是这样了）';
  return skipped.map(s => REASON[s.reason] || String(s.reason)).join('；');
}

// 输入不合规矩（不是对象、没有操作、操作不在允许列表）抛异常，命令行退出 1；操作做不成是正常结果，返回 failed/nochange
// input: { ops: Op[] } 或 { undo: id }；返回 { ok, result: 'done'|'nochange'|'partial'|'failed', message? }
async function run(dir, input) {
  if (!input || typeof input !== 'object') throw new Error('输入不是 JSON 对象');
  if (typeof input.undo === 'string' && input.undo) {
    const r = await store.undoChangeAsync(dir, input.undo);
    if (r === 'partial') return { ok: true, result: 'partial', message: '只撤销了一部分：有的文件后来又被改过，那几处没动' };
    if (!r) return { ok: false, result: 'failed', message: '撤销没成功：这条改动已经撤销过，或者改动处后来又被改过' };
    return { ok: true, result: 'done' };
  }
  if (!Array.isArray(input.ops) || !input.ops.length) throw new Error('没有要做的操作');
  const bad = input.ops.find(o => !o || !ALLOWED.has(o.op));
  if (bad) throw new Error(`不允许的操作：${bad && bad.op}`);
  const done = await store.commitAsync(dir, input.ops, { source: '你' });
  if (!done.length) return { ok: true, result: 'nochange', message: whyText(done.skipped) };
  return { ok: true, result: 'done' };
}

module.exports = { run, ALLOWED };
