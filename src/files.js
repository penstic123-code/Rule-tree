'use strict';
// 列出项目里的文件（相对路径，正斜杠）：git 仓库按 git（跟着 .gitignore），否则遍历，跳过依赖、构建产物和隐藏文件夹。
// 新项目按文件夹生成需求、体检查「范围一个文件都匹配不到」时用
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MAX_FILES = 50000;
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.next', 'dist', 'target', 'Library', '.godot', '.gradle']);

// dotDirs: true 时遍历也进隐藏文件夹（.git 和 SKIP_DIRS 仍跳过）；只给检查路径用，其他调用方保持原样
function listFiles(dir, { dotDirs = false } = {}) {
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
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && (dotDirs || !e.name.startsWith('.'))) stack.push(p); } else files.push(p);
      }
    }
  }
  return files.filter(f => !f.split('/').slice(0, -1).some(p => SKIP_DIRS.has(p))).slice(0, MAX_FILES);
}

const git = (dir, args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 10000 });

// 当前分支名；不在 git 里或 HEAD 游离时返回 null
function gitBranch(dir) {
  const r = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const b = r.status === 0 && typeof r.stdout === 'string' ? r.stdout.trim() : '';
  return b && b !== 'HEAD' ? b : null;
}

// 规则文件夹在 git 里的状态：'tracked' 已跟踪 / 'ignored' 被 .gitignore 忽略 / 'untracked' 还没加进 git；不在 git 里返回 null
function rulesGitState(dir, rel) {
  rel = rel.replace(/\\/g, '/');
  if (git(dir, ['rev-parse', '--is-inside-work-tree']).status !== 0) return null;
  const ls = git(dir, ['ls-files', '--', rel]);
  if (ls.status === 0 && ls.stdout.trim()) return 'tracked';
  return git(dir, ['check-ignore', '-q', '--no-index', '--', rel + '/_guide.md']).status === 0 ? 'ignored' : 'untracked';
}

module.exports = { listFiles, gitBranch, rulesGitState };
