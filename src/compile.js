'use strict';
// 把需求树编译成 Claude Code 原生的路径规则 .claude/rules/reqtree/<ID>.md。
// 之后由 Claude Code 自己负责加载：改到匹配的文件才加载、子 agent 和上下文压缩后同样生效、
// 会话中途改了规则会以"文件已变更"通知推给 AI。
//
// - 继承交给 glob 嵌套：C2 是 DataScience/**，C2.1 是 DataScience/ch01-*.html，改第1章时两份都会加载。
//   所以每个节点只写自己的规则，不抄上级。
// - 覆盖写成明确说明（"在本范围内以此为准，取代上级…"），否则两条矛盾时 Claude 可能任选一条。
// - 背景文档（> 文档：）不搬进来，只写一句「动手前先读」（src/docs.js）。
// - 没写文件对应的节点：沿用最近上级的范围。只有根节点的规则是全局的（不写 paths，每次都加载）；
//   其他节点一路都没有文件对应就不编译——不然某门课的规则会在做别的课时也被加载。面板和 check 会提醒。
const fs = require('fs');
const path = require('path');
const { parse, walk, pathOf } = require('./parser');
const codex = require('./targets/codex');
const Docs = require('./docs');
const { worktreesOf } = require('./common');

const OUT_DIR = path.join('.claude', 'rules', 'reqtree');
const MARK = '<!-- reqtree:generated -->';
// 生成格式的版本，写在 _index.md 里。编译的输出或说明文字变了就加 1：ensureCompiled 只比时间，
// 旧版本生成的文件可能比树还新，不看版本的话升级后会一直留着过时的说明（比如「标 🆕，等用户确认」）
const FORMAT = '<!-- reqtree:format 10 -->';

// 节点的生效范围：自己的 files，或最近上级的；都没有返回 null（全局）
function scopeOf(node) {
  for (let n = node; n && n.parent; n = n.parent) if (n.files.length) return n.files;
  return null;
}

const { isRoot } = require('./common');

// 这个节点的规则会不会自动加载给 AI：根节点全局加载；其他节点要自己或上级有文件对应。
// 编译、面板提醒、check 三处共用，免得判断不一致
const autoLoads = node => isRoot(node) || !!scopeOf(node);

// projectDir 给了才写背景文档那一句（读文档开头的用途）
function compileNode(node, treeName, projectDir) {
  const own = node.rules;
  const docLine = projectDir ? Docs.readLine(projectDir, node) : '';
  if ((!own.length && !docLine) || !autoLoads(node)) return null;
  // 带键的规则覆盖最近上级里同键的生效规则
  const overrides = new Map();
  for (const r of own) {
    if (!r.key) continue;
    for (let p = node.parent; p && p.parent; p = p.parent) {
      const hit = p.rules.find(x => x.key === r.key);
      if (hit) { overrides.set(r.line, hit); break; }
    }
  }
  const scope = scopeOf(node);
  const where = pathOf(node).map(n => `${n.id} ${n.title}`).join(' → ');
  const lines = [];
  if (scope) lines.push('---', 'paths:', ...scope.map(g => `  - ${JSON.stringify(g)}`), '---');
  lines.push(MARK, `## 需求 ${where}`, '');
  if (docLine) lines.push(docLine, '');
  for (const r of own) {
    const o = overrides.get(r.line);
    lines.push(`- ${r.text}` + (o ? `（在本范围内以此为准，取代上级 ${o.owner.id} 的「${o.text}」）` : ''));
  }
  lines.push('', `（由 ${treeName} 自动生成，不要手改；规则要改就改 ${treeName}。）`);
  return lines.join('\n') + '\n';
}

// 动手原则（config 的 principles，默认开）：不重复造轮子、遇到 bug 先找根因。借鉴 ponytail 的「阶梯」，见 设计-信息架构.md 第四节
const PRINCIPLES = '动手原则：①遇到 bug 先找根因：规则互相矛盾、架构不合理、系统之间冲突的，先解决这些，不在表面打补丁。②写新东西之前依次问：真需要吗 → 项目里已经有了吗（看代码地图，或用下面的命令查）→ 标准库或平台自带的能做吗 → 已经装的依赖能做吗 → 最后才写最少能用的代码；校验、数据安全、无障碍不省。③不要光照用户说的做：用户的新要求和项目的实际情况、以后好不好维护有冲突时，先指出问题、给出建议，用户拍板后再动手。别的事不问：已有的记录之间说法不同、做法细节、能撤销的改动，自己按最新的指令定，做完告诉用户改了什么。';

// 全局说明：告诉 AI 这套东西怎么用。不写 paths，每次都加载，保持很短。
// opts.principles：写不写动手原则；opts.who：查名字的命令说明（代码地图生成过才有）
function compileIndex(root, treeName, opts = {}) {
  const doing = [...walk(root)].filter(n => n.status === 'doing').map(n => `${n.id} ${n.title}`);
  return [
    MARK,
    FORMAT,
    `## 需求树（${treeName}）`,
    `本项目的需求和规则统一记在 ${treeName}：标题是需求，结尾 ✅完成 🔨进行中 ⏳待做 ❓待定；标题下的列表项是规则。各需求的规则会在你改到对应文件时自动加载。`,
    doing.length ? `进行中：${doing.join('、')}。` : '',
    '用户提出的长期要求由后台记录员在每轮结束后直接写进需求树（用户可以在面板上撤销），你不用自己记；用户明确说"记下来"时可以直接改需求树。某个需求做完了，把它的状态改成 ✅。',
    '项目的需求和规则（包括某门课、某块内容怎么做、开几个 agent）只记在需求树里（后台记录员负责），不要再写进记忆（memory）或 CLAUDE.md，免得同一条规则记两处。自动记忆只记和项目内容无关的事：用户本人的情况、工具和电脑环境（本机的坑、命令注意事项）、私人信息（服务器、账号）、外部资源在哪。',
    '需求树、文档、自动记忆说法不同时，不要问用户，按后写的那边把另一边改过来，再告诉用户改了什么（需求树每条规则什么时候、谁改的，记在 .reqtree/changes.jsonl；文档看 git log 或修改时间）；查不出先后的按需求树。',
    '同一个文件属于几个需求时（比如既属于某门课，又属于「写作」这类按文件类型划分的需求），几份规则都要照做；说法冲突时以文件范围更窄的那份为准。',
    '规则里以「决定：」开头的，是用户拍板定下的做法和理由。不要自己推翻；觉得该改，先问用户。',
    opts.principles === false ? '' : PRINCIPLES,
    opts.who ? `改代码前先看代码地图（改到对应文件时自动加载）：这块已经有哪些文件、对外的函数和类、依赖的公共模块。${opts.who}` : '',
  ].filter(Boolean).join('\n') + '\n';
}

// 总目录的选项：读 .reqtree/config.json（不经过 store，免得互相 require）；代码地图建过才写查名字的命令
function indexOpts(projectDir) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(projectDir, '.reqtree', 'config.json'), 'utf8')) || {}; } catch {}
  const mapped = fs.existsSync(path.join(projectDir, '.reqtree', 'codemap.json'));
  return { principles: cfg.principles !== false, who: mapped && cfg.codeMap !== false ? require('./codemap').whoHint() : '' };
}

// 编译给哪些 AI 工具：装过 Codex（.reqtree/codex.json 或 AGENTS.md 里有托管块）就编 Codex；
// Claude Code 在没装 Codex、或已经装过 Claude 的 hook / 生成过 .claude/rules/reqtree 时编（老项目照旧）
function claudeInstalled(projectDir) {
  if (fs.existsSync(path.join(projectDir, OUT_DIR))) return true;
  for (const f of ['settings.local.json', 'settings.json']) {
    try { if (/reqtree/i.test(fs.readFileSync(path.join(projectDir, '.claude', f), 'utf8'))) return true; } catch {}
  }
  return false;
}
function targetsOf(projectDir) {
  const cx = codex.enabled(projectDir);
  return { claude: !cx || claudeInstalled(projectDir), codex: cx };
}

// 生成全部规则文件；内容没变的不重写（免得触发无谓的"文件已变更"通知）；删掉已经不存在的节点的文件。
// opts.targets = { claude, codex } 可以指定编译目标，不给就自动判断（targetsOf）。
// 返回 { written: [], removed: [], dir, targets, warnings }；Codex 的文件名带 codex: 前缀
function compile(treePath, opts = {}) {
  const projectDir = path.dirname(treePath);
  const targets = opts.targets || targetsOf(projectDir);
  const res = targets.claude ? compileClaude(treePath) : { written: [], removed: [], dir: null };
  res.targets = Object.keys(targets).filter(k => targets[k]);
  res.warnings = [];
  if (targets.codex) {
    const c = codex.compile(treePath);
    res.written.push(...c.written);
    res.removed.push(...c.removed);
    res.warnings.push(...c.warnings);
    if (!res.dir) res.dir = c.dir;
  }
  return res;
}

function compileClaude(treePath) {
  const projectDir = path.dirname(treePath);
  const treeName = path.basename(treePath);
  const dir = path.join(projectDir, OUT_DIR);
  const root = parse(fs.readFileSync(treePath, 'utf8'));
  const files = new Map([['_index.md', compileIndex(root, treeName, indexOpts(projectDir))]]);
  for (const n of walk(root)) {
    const text = compileNode(n, treeName, projectDir);
    if (text) files.set(`${n.id}.md`, text);
  }

  const res = writeRules(dir, files);
  // git worktree 里没有这些规则文件（一般不进 git），在那里干活的 AI 一条都加载不到：每个 worktree 抄一份。
  // 2026-10-25：猪猪进城记大部分活在 .claude/worktrees/ 里做，规则和记录员都没起作用
  for (const wt of worktreesOf(projectDir)) try { writeRules(path.join(wt, OUT_DIR), files); } catch {}
  return { ...res, dir };
}

function writeRules(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  const written = [], removed = [];
  for (const [name, text] of files) {
    const p = path.join(dir, name);
    let old = null;
    try { old = fs.readFileSync(p, 'utf8'); } catch {}
    if (old !== text) { fs.writeFileSync(p, text); written.push(name); }
  }
  for (const name of fs.readdirSync(dir)) {
    // 代码地图（map-*.md、_map.md）归 src/codemap.js 管
    if (!name.endsWith('.md') || files.has(name) || /^(map-.+|_map)\.md$/.test(name)) continue;
    // 只删自己生成的文件
    const p = path.join(dir, name);
    if (fs.readFileSync(p, 'utf8').includes(MARK)) { fs.unlinkSync(p); removed.push(name); }
  }
  return { written, removed };
}

// 树比编译结果新、或编译结果是旧格式时才编译（hook 每次调用它，要便宜：先比时间，时间没问题才读一个小文件）。
// 不加锁：要和写树互斥，走 store.compileTree
function ensureCompiled(treePath) {
  const projectDir = path.dirname(treePath);
  const targets = targetsOf(projectDir);
  const stamp = path.join(projectDir, OUT_DIR, '_index.md');
  const fresh = s => fs.statSync(s).mtimeMs >= fs.statSync(treePath).mtimeMs && fs.readFileSync(s, 'utf8').includes(FORMAT);
  const wtStamps = () => worktreesOf(projectDir).map(w => path.join(w, OUT_DIR, '_index.md'));
  // 新开的 worktree 里还没有规则文件，也算要编译
  const claudeStale = () => {
    try { return !fresh(stamp) || wtStamps().some(s => { try { return !fresh(s); } catch { return true; } }); }
    catch { return true; }
  };
  // 挂的文档改过：规则里写的目录和行号可能过时了，也要重编
  const docsStale = () => {
    try { return Docs.docsMtime(treePath) > fs.statSync(stamp).mtimeMs; } catch { return false; }
  };
  if (!(targets.claude && claudeStale()) && !(targets.codex && codex.stale(treePath)) && !docsStale()) return null;
  const r = compile(treePath, { targets });
  // 内容没变时也刷新时间戳，下次就不用再比
  const now = new Date();
  if (targets.claude) for (const s of [stamp, ...wtStamps()]) try { fs.utimesSync(s, now, now); } catch {}
  if (targets.codex) try { fs.utimesSync(path.join(projectDir, codex.RULES_DIR, '_index.md'), now, now); } catch {}
  return r;
}

module.exports = { compile, ensureCompiled, scopeOf, autoLoads, targetsOf, indexOpts, PRINCIPLES };
