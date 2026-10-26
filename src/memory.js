'use strict';
// Claude Code 的设置文件和自动记忆（auto memory）开关。
// 设置 ruletree.memoryMode 为 treeOnly 时，在项目的 .claude/settings.local.json 里写 "autoMemoryEnabled": false，关掉这个项目的自动记忆
// （键名见官方文档 code.claude.com/docs/en/memory）；切回默认时去掉这个键
const fs = require('fs');
const path = require('path');

// 读 Claude Code 的设置文件：不在返回 fallback；带 BOM 照读；解析不了就抛错（绝不能当成空对象写回去，会清掉用户的设置）
function readSettings(file, fallback = {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return fallback; }
  text = text.replace(/^﻿/, '');
  if (!text.trim()) return fallback;
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`${file} 不是合法的 JSON（${e.message}），为了不弄丢里面的设置，没有改它`); }
}

// enabled=false 写 "autoMemoryEnabled": false；enabled=true 去掉这个键（只去掉 false，用户自己写的 true 不动）。
// 别的设置原样保留。返回有没有改文件
function setAutoMemory(projectDir, enabled) {
  const file = path.join(projectDir, '.claude', 'settings.local.json');
  const s = readSettings(file, null);
  if (enabled) {
    if (!s || s.autoMemoryEnabled !== false) return false;
    delete s.autoMemoryEnabled;
  } else {
    if (s && s.autoMemoryEnabled === false) return false;
    const next = { ...(s || {}), autoMemoryEnabled: false };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
    return true;
  }
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
  return true;
}

module.exports = { readSettings, setAutoMemory };
