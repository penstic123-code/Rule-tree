'use strict';
// 列出项目里的文件（相对路径，正斜杠）：git 仓库按 git（跟着 .gitignore），否则遍历，跳过依赖、构建产物和隐藏文件夹。
// 新项目按文件夹生成需求、体检查「范围一个文件都匹配不到」时用
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MAX_FILES = 50000;
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.next', 'dist', 'target', 'Library', '.godot', '.gradle']);

function listFiles(dir) {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: dir, encoding: 'utf8', windowsHide: true, maxBuffer: 256 << 20, timeout: 20000 });
  let files = r.status === 0 && typeof r.stdout === 'string' ? r.stdout.split('\0').filter(Boolean) : null;
  if (!files) {
    files = [];
    const stack = [''];
    while (stack.length && files.length < MAX_FILES) {
      const rel = stack.pop();
      let ents = [];
      try { ents = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(p); } else files.push(p);
      }
    }
  }
  return files.filter(f => !f.split('/').slice(0, -1).some(p => SKIP_DIRS.has(p))).slice(0, MAX_FILES);
}

module.exports = { listFiles };
