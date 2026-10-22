'use strict';
// hook、记录员、编译、点名补规则都要用的几样小东西，只写一份
const fs = require('fs');
const os = require('os');
const path = require('path');

// 会话状态、任务文件、hook.log、recorder.log 放在系统临时目录下的 reqtree/
const tmpDir = () => path.join(os.tmpdir(), 'reqtree');

// 最上层的需求（根节点 P 一类）：它的规则全局生效
const isRoot = node => !node.parent || !node.parent.parent;

// 改文件的工具。只跟踪这几个，不跟踪 Bash（每条命令都启动一次 node 不划算）
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// 从 dir 往上找需求树，到 git 根为止（Claude Code 和 Codex 都可能在子目录里启动）
function findTreeUp(dir) {
  const { findTree } = require('./store');
  for (let d = path.resolve(dir); ;) {
    const t = findTree(d);
    if (t) return t;
    const up = path.dirname(d);
    if (up === d || fs.existsSync(path.join(d, '.git'))) return null;
    d = up;
  }
}

// 往临时目录里的日志追加一行（超过 512 KB 就换一份）。日志写不进去不能影响正事
function appendTmpLog(name, line) {
  try {
    const f = path.join(tmpDir(), name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (fs.existsSync(f) && fs.statSync(f).size > 512 * 1024) fs.renameSync(f, f + '.old');
    fs.appendFileSync(f, line.endsWith('\n') ? line : line + '\n');
  } catch {}
}

module.exports = { tmpDir, isRoot, EDIT_TOOLS, findTreeUp, appendTmpLog };
