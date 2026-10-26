'use strict';
// hook、命令行、插件都要用的几样小东西，只写一份
const fs = require('fs');
const os = require('os');
const path = require('path');

// hook.log 放在系统临时目录下的 ruletree/
const tmpDir = () => path.join(os.tmpdir(), 'ruletree');

// 改文件的工具。只跟踪这几个，不跟踪 Bash（每条命令都启动一次 node 不划算）
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// git worktree 是同一个项目的另一份检出：根目录下的 .git 是个文件，写着「gitdir: <主仓库>/.git/worktrees/<名字>」。
// 规则文件进 git，worktree 里有自己的一份；.ruletree/（改动记录、活动日志）不进 git，只在主仓库。dir 是 worktree 的根时返回主仓库目录，否则 null
function worktreeMain(dir) {
  let t;
  try { t = fs.readFileSync(path.join(dir, '.git'), 'utf8'); } catch { return null; }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(t);
  if (!m) return null;
  const wt = path.dirname(path.resolve(dir, m[1]));
  return path.basename(wt) === 'worktrees' && path.basename(path.dirname(wt)) === '.git' ? path.dirname(path.dirname(wt)) : null;
}

// 主仓库登记过、现在还在的 worktree 根目录
function worktreesOf(mainDir) {
  const base = path.join(mainDir, '.git', 'worktrees');
  let names;
  try { names = fs.readdirSync(base); } catch { return []; }
  const out = [];
  for (const n of names) {
    try {
      const d = path.dirname(path.resolve(fs.readFileSync(path.join(base, n, 'gitdir'), 'utf8').trim()));
      if (fs.existsSync(path.join(d, '.git'))) out.push(d);
    } catch {}
  }
  return out;
}

// 从 dir 往上找用需求树的项目，到 git 根为止（Claude Code 和 Codex 都可能在子目录里启动）；git 根是 worktree 时回主仓库
function findProjectUp(dir) {
  const { isProject } = require('./store');
  for (let d = path.resolve(dir); ;) {
    if (fs.existsSync(path.join(d, '.git'))) {
      const main = worktreeMain(d);
      if (main) return isProject(main) ? main : null;
      return isProject(d) ? d : null;
    }
    if (isProject(d)) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

// dir 在这个项目的哪份检出里：某个 worktree 的根，或者项目本身（treeDir）
function checkoutOf(treeDir, dir) {
  const { samePath } = require('./store');
  for (let d = path.resolve(dir); ;) {
    if (fs.existsSync(path.join(d, '.git'))) {
      const main = worktreeMain(d);
      return main && samePath(main, treeDir) ? d : treeDir;
    }
    const up = path.dirname(d);
    if (up === d) return treeDir;
    d = up;
  }
}

// 文件在项目里的相对路径（正斜杠）。文件在这个项目的某个 worktree 里时，按那个 worktree 的根算，需求的文件范围才对得上
const projectRel = (treeDir, file) => path.relative(checkoutOf(treeDir, path.dirname(file)), file).split(path.sep).join('/');

// 往临时目录里的日志追加一行（超过 512 KB 就换一份）。日志写不进去不能影响正事
function appendTmpLog(name, line) {
  try {
    const f = path.join(tmpDir(), name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (fs.existsSync(f) && fs.statSync(f).size > 512 * 1024) fs.renameSync(f, f + '.old');
    fs.appendFileSync(f, line.endsWith('\n') ? line : line + '\n');
  } catch {}
}

module.exports = { tmpDir, EDIT_TOOLS, findProjectUp, worktreeMain, worktreesOf, checkoutOf, projectRel, appendTmpLog };
