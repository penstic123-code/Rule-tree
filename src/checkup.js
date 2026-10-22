'use strict';
// 体检：用户点「需求树：体检」或运行 reqtree check --fix 时做。
// 1. 确定的，直接改（不调用模型）：同一个需求里几乎一样的规则（Dice ≥ 0.7）、同一个需求里同键的规则，
//    留写在后面的那条（以最新为准），前面的删掉。记成一条改动，面板上可以撤销
// 2. 标着 🔨 很久没动的需求，变成问题（不调用模型）
// 3. 拿不准的：没写键、意思可能冲突的规则（上级和下级、或同一需求里说法不一样），调一次小模型，变成问题让用户选。
//    只在用户主动体检时调用；问题和记录员的问题放在一起（.reqtree/questions.jsonl），只是默认做法没有先写进树
// 4. 设置 reqtree.memoryMode 为 dedupe（默认）时，Claude Code 自动记忆里和需求树各有一份的规则，问删哪份（src/memory.js）
const fs = require('fs');
const path = require('path');
const store = require('./store');
const Q = require('./questions');
const { parse, walk, sameMeaning } = require('./parser');

// 体检的问题里，选项只能做这几种改动
const CHECK_OPS = new Set(['add_rule', 'replace_rule', 'remove_rule', 'override_rule']);
const MAX_CHECK_QUESTIONS = 8;

// 同一个需求里的重复：从后往前看，前面的规则和后面某条是同一件事就删掉前面的。
// 同一件事：同一个键；或者意思一样（parser.sameMeaning：几乎一样，数字、否定词也一样）、键不冲突（都没键，或者前面那条没键）。
// 前面那条有键、后面那条没键的不动：删掉有键的那条，下级覆盖它的规则就对不上了，交给模型问
function duplicateOps(text) {
  const ops = [];
  for (const n of walk(parse(text))) {
    const kept = [];
    for (let i = n.rules.length - 1; i >= 0; i--) {
      const r = n.rules[i];
      const later = kept.find(k => (r.key && k.key === r.key) || (!r.key && sameMeaning(r.text, k.text)));
      if (later) ops.push({ op: 'remove_rule', node: n.id, text: r.text, why: later.text });
      else kept.push(r);
    }
  }
  return ops;
}

// 记忆文件给模型看的样子：每个文件一行（文件名：description｜正文几句），总长不超过 MEMORY_PROMPT_CHARS
const MEMORY_PROMPT_CHARS = 8000;
function memoryForPrompt(entries) {
  const out = [];
  let size = 0;
  for (const m of entries) {
    const line = `${m.file}：${[m.description, ...m.lines.map(l => l.text)].filter(Boolean).join('｜')}`;
    if (size + line.length > MEMORY_PROMPT_CHARS) break;
    out.push(line); size += line.length;
  }
  return out.join('\n');
}

function buildCheckPrompt(tree, memory = '') {
  return `你是需求树的体检员。下面是一个项目的需求树（Markdown）：标题是需求，开头是 ID；标题下 "- " 开头的是规则，可带 [键]；下级用和上级同一个 [键] 的规则，是有意在本范围内覆盖上级（不算冲突）。

<需求树>
${tree}
</需求树>
${memory ? `
<自动记忆（AI 自己记下的笔记，每行一个文件：文件名：内容）>
${memory}
</自动记忆>
` : ''}
找出说法互相冲突、要用户拍板的规则：上级和下级（或同一个需求里）对同一件事说得不一样，又没有用同一个 [键] 写成覆盖。例：P「每章互动不超过4个」，C1「每章互动不超过5个」。下级只是更具体、并不冲突的不算；拿不准是不是冲突的不算。
每处冲突写成一个问题：text 是一句简短的问题，说清两条各是什么；options 是 2–3 种处理（label 几个字，ops 是这种处理完整的改动）。常用的：
- 下级算例外：[{"op":"remove_rule","node":"下级ID","text":"下级原文"},{"op":"override_rule","node":"下级ID","from":"上级ID","text":"上级原文","new":"下级原文"}]
- 统一用上级的：[{"op":"remove_rule","node":"下级ID","text":"下级原文"}]
- 两条都留着：[]
同一个需求里的两条冲突：留后面那条（remove_rule 前面的）、留前面那条（remove_rule 后面的）、两条都留着。
default 是最可能的那个选项的序号（从 0 起）。最多 ${MAX_CHECK_QUESTIONS} 个问题。
${memory ? `另外找出自动记忆里和需求树说的是同一件事的（哪怕措辞不同），写进 memoryDuplicates：file 是文件名，memory 是记忆里的原句，node 是需求 ID，rule 是树里的原文。\n` : ''}
只输出 JSON，不要任何别的文字；没有冲突就输出 {"questions":[]}：
{"questions":[{"text":"全局写每章互动不超过4个，C1 写不超过5个：","options":[{"label":"C1 用5（本课例外）","ops":[...]},{"label":"统一用4","ops":[...]},{"label":"两条都留着","ops":[]}],"default":0}]${memory ? ',"memoryDuplicates":[{"file":"x.md","memory":"记忆里的原句","node":"P","rule":"树里原文"}]' : ''}}`;
}

// 做一次体检。read：读树的当前内容（插件传编辑器里的内容）；write：插件的 writeTree；
// model：false 时不调用模型；ask：调用模型的函数（测试可以换）；
// memory：自动记忆文件夹，不传就按项目找（src/memory.js），false 不查记忆（设置 reqtree.memoryMode 为 treeOnly 时）。
// 返回 { merged 删掉的重复规则, stale 新加的久未动问题, memory 新加的记忆重复问题, questions 新加的冲突问题, error 调用模型出错的说明 }
async function runCheckup(treePath, { read, write, model = true, ask, memory } = {}) {
  const rec = require('../hooks/recorder');
  const mem = require('./memory');
  const readText = read || (p => fs.readFileSync(p, 'utf8'));
  const dups = duplicateOps(readText(treePath));
  const merged = dups.length ? await store.applyChange(treePath, dups.map(({ why, ...o }) => o), { source: '你', write }) : [];
  if (merged.length) rec.log(`体检：合并重复规则 ${JSON.stringify(merged.map(o => [o.node, o.text]))}`);
  let stale = [];
  try { stale = Q.staleQuestions(treePath); } catch (e) { rec.log('久未动的问题没生成：' + e.message); }
  const result = { merged, stale, memory: [], questions: [], error: null };

  // 记忆和需求树各有一份的：先按字面（Dice ≥ 0.7）找，模型再找换了说法的。问过的（不管怎么答的）不再问
  let memDir = null;
  if (memory !== false) try { memDir = typeof memory === 'string' ? memory : mem.memoryDir(path.dirname(treePath)); } catch (e) { rec.log('找不到自动记忆：' + e.message); }
  const asked = new Set(Q.readQuestions(treePath).map(q => q.memKey).filter(Boolean));
  const askMemory = d => {
    const k = mem.memKey(d);
    if (asked.has(k)) return;
    asked.add(k);
    result.memory.push(Q.addQuestion(treePath, mem.memoryQuestion(d, memDir)));
  };
  if (memDir) try { mem.findDuplicates(readText(treePath), memDir).forEach(askMemory); } catch (e) { rec.log('查记忆重复出错：' + e.stack); }

  if (!model) return result;
  try {
    const text = readText(treePath);
    const memText = memDir ? memoryForPrompt(mem.readMemory(memDir)) : '';
    const out = await (ask || rec.askJson)(buildCheckPrompt(text, memText));
    const ctx = { root: parse(text), unmapped: [], user: '' };
    const picked = rec.pickQuestions(out && out.questions, { text, ops: [], ctx, allowed: CHECK_OPS, max: MAX_CHECK_QUESTIONS }).questions;
    // 同样的问题还开着就不再问一遍
    const open = new Set(Q.openQuestions(treePath).map(q => q.text));
    for (const q of picked) {
      if (open.has(q.text)) continue;
      result.questions.push(Q.addQuestion(treePath, { source: '体检', text: q.text, options: q.options, default: q.default, defaultApplied: false }));
    }
    if (memDir && out && Array.isArray(out.memoryDuplicates)) {
      for (const raw of out.memoryDuplicates.slice(0, MAX_CHECK_QUESTIONS)) {
        const d = mem.checkDuplicate(raw, text, memDir);
        if (d) askMemory(d); else rec.log(`体检：模型说的记忆重复对不上，丢掉：${JSON.stringify(raw)}`);
      }
    }
    rec.log(`体检：问用户 ${result.questions.length} 个冲突、${result.memory.length} 个记忆重复`);
  } catch (e) {
    result.error = e;
    rec.log('体检出错：' + e.stack);
  }
  return result;
}

module.exports = { duplicateOps, buildCheckPrompt, runCheckup, CHECK_OPS };
