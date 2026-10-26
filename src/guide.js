'use strict';
// 说明书 .claude/rules/ruletree/_guide.md：告诉干活的 AI 需求树怎么读、怎么记规则。不写 paths，每次都加载，保持短。
// 由工具生成：内容和 VERSION 只在这里改，hook、插件、命令行发现文件和这里不一样就重写（ensureGuide）。
const fs = require('fs');
const path = require('path');
const store = require('./store');

const VERSION = 2;
const MARK = `<!-- ruletree:guide ${VERSION}（由 RuleTree 生成，不要手改） -->`;
const DIR = '.claude/rules/ruletree';

// 读和记的规矩。entry：每次全文加载的入口文档（CLAUDE.md）
const rulesText = entry => [
  `记规则：用户提出以后都要守的要求，或在几个做法里拍板时，在这一轮结束前写进对应需求的文件：正在改的文件属于哪个需求，就写进那个需求的文件（你手上已加载的那份）；明说全项目的才写进 _root.md。一句话，用用户的意思；拍板的以「决定：」开头，连理由一起写；改了主意就改原来那条，不另加一条。下级推翻上级的规则时，在下级写新的说法，末尾注明「（在本范围内取代 R1 的「原话」）」。你踩到的、以后改这块还用得上的坑，也可以记，开头写「（AI 发现）」。写完在回复里说一句「已记到 R1.2」。用户只是提问、一次性的指令、用户没同意的你的建议，都不记。`,
  `没有合适的需求就新建一个文件「编号-标题.md」（下级编号是 上级编号.序号），照别的文件的格式写：开头 paths 写它管哪些文件（在上级的范围之内），标题行后面写「上级：」。某个需求做完了，把标题行的状态改成 ✅。`,
  '用户这次的话和规则冲突时，自己判断：和普通规则冲突，这句话是明确、具体的指令就照做，做完用一句话提一下和哪条规则不一致、要不要改规则，分不清是顺口一提还是真想破例才问一句；和「决定：」开头的规则冲突，先问（那是用户定的），用户明说破例后照做，并把例外记进对应需求。觉得「决定：」该改，也先问用户。',
  `规则、文档、记忆说法不同时，以后写的为准，把另一边改过来再告诉用户；查不出先后以这里为准。项目规则只记在这里，不写进记忆或 ${entry}；记忆只记和项目无关的事（用户本人、电脑环境、账号、外部资源）。`,
  '同一个文件属于几个需求时，几份规则都照做；冲突时以范围窄的为准。',
  '遇到 bug 先找根因：规则互相矛盾、架构不合理的，先解决这些，不在表面打补丁。用户的新要求和项目实际、以后好不好维护有冲突时，先指出问题、给出建议，用户拍板再动手。',
];

function guideText() {
  return [
    MARK,
    '## RuleTree：本项目的需求和规则',
    `${DIR}/ 里每个文件是一个需求：文件名是编号和标题（R1.2 是 R1 的下级），开头一行是标题和状态（✅完成 🔨进行中 ⏳待做 ❓待定），下面的列表项是规则，「文档：」一行是动手前要读的背景文档（长文档只读相关的节）。改到某个需求管的文件时，它的规则会自动加载；讨论某个需求、还没碰它的文件时，先读这里对应的文件；新建文件前，先读它所属需求的文件。只读和要改的文件有关的需求，不要把整个文件夹读一遍。_root.md 是全项目都要守的规则。`,
    ...rulesText('CLAUDE.md'),
  ].join('\n') + '\n';
}

const guidePath = dir => path.join(store.rulesDir(dir), '_guide.md');
// 说明书和这一版不一样（没有、旧版本、被手改）就重写。只在项目已经有规则文件时写。返回写了没有
function ensureGuide(dir) {
  if (!store.hasRules(dir)) return false;
  const want = guideText();
  let have = null;
  try { have = fs.readFileSync(guidePath(dir), 'utf8'); } catch {}
  if (have === want) return false;
  // 文件里是更新版本写的（比如别的窗口装了新插件），旧插件不要改回去，免得来回改
  const ver = have && /^<!-- ruletree:guide (\d+)/.exec(have);
  if (ver && Number(ver[1]) > VERSION) return false;
  store.atomicWrite(guidePath(dir), want);
  return true;
}

module.exports = { VERSION, MARK, DIR, rulesText, guideText, guidePath, ensureGuide };
