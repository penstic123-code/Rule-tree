'use strict';
// 给 Claude 插件面板用的编辑入口：只放行四种改规则的操作，走和 VS Code 扩展同一条 store 路径，
// 所以每次改动都记进改动记录、可以撤销。不依赖 VS Code。
const store = require('./store');
const { detectLang } = require('./lang');

// 面板只需要这四种；改名、删需求、改文件范围等留给 VS Code 扩展，不在这里放开
const ALLOWED = new Set(['set_status', 'add_rule', 'replace_rule', 'remove_rule']);

// 报给面板的话，跟着项目的语言走（和说明书、面板文字一致）
const TEXT = {
  zh: {
    reason: {
      'unknown-op': '不认识的操作',
      'no-node': '找不到这个需求',
      'no-rule': '这条规则已经变了，请重新看一下再改',
      'duplicate': '已经有同样的规则了',
      'same': '内容没有变化',
      'empty': '内容是空的',
      'bad-status': '不认识这个状态',
    },
    nothing: '没有可改的内容（可能已经是这样了）',
    partial: '只撤销了一部分：有的文件后来又被改过，那几处没动',
    undoFailed: '撤销没成功：这条改动已经撤销过，或者改动处后来又被改过',
    notObject: '输入不是 JSON 对象',
    noOps: '没有要做的操作',
    notAllowed: '不允许的操作：',
    sep: '；',
    source: '你',
  },
  en: {
    reason: {
      'unknown-op': 'Unknown operation',
      'no-node': 'That requirement was not found',
      'no-rule': 'That rule has changed. Look again before editing it',
      'duplicate': 'That rule already exists',
      'same': 'Nothing changed',
      'empty': 'The text is empty',
      'bad-status': 'Unknown status',
    },
    nothing: 'Nothing to change (it may already be that way)',
    partial: 'Only part of it was undone: some files were edited afterwards, and those places were left alone',
    undoFailed: 'Undo did not work: this change was already undone, or the places it touched were edited afterwards',
    notObject: 'The input is not a JSON object',
    noOps: 'No operations to run',
    notAllowed: 'Operation not allowed: ',
    sep: '; ',
    source: 'You',
  },
};

// 这次是不是没改成：把核心给的 skipped 原因翻成一句话
function whyText(skipped, t) {
  if (!skipped || !skipped.length) return t.nothing;
  return skipped.map(s => t.reason[s.reason] || String(s.reason)).join(t.sep);
}

// 输入不合规矩（不是对象、没有操作、操作不在允许列表）抛异常，命令行退出 1；操作做不成是正常结果，返回 failed/nochange
// input: { ops: Op[] } 或 { undo: id }；返回 { ok, result: 'done'|'nochange'|'partial'|'failed', message? }
async function run(dir, input) {
  const t = TEXT[detectLang(dir, 'en')];
  if (!input || typeof input !== 'object') throw new Error(t.notObject);
  if (typeof input.undo === 'string' && input.undo) {
    const r = await store.undoChangeAsync(dir, input.undo);
    if (r === 'partial') return { ok: true, result: 'partial', message: t.partial };
    if (!r) return { ok: false, result: 'failed', message: t.undoFailed };
    return { ok: true, result: 'done' };
  }
  if (!Array.isArray(input.ops) || !input.ops.length) throw new Error(t.noOps);
  const bad = input.ops.find(o => !o || !ALLOWED.has(o.op));
  if (bad) throw new Error(`${t.notAllowed}${bad && bad.op}`);
  const done = await store.commitAsync(dir, input.ops, { source: t.source });
  if (!done.length) return { ok: true, result: 'nochange', message: whyText(done.skipped, t) };
  return { ok: true, result: 'done' };
}

module.exports = { run, ALLOWED };
