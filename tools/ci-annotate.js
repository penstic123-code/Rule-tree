#!/usr/bin/env node
'use strict';
// CI 用：读 node --test 的 TAP 输出，把失败的测试写成 GitHub 的 ::error 注释。
// 注释在公开仓库里不登录也能看到（日志要登录），方便排查。用法：node tools/ci-annotate.js test-output.txt
const fs = require('fs');
const lines = fs.readFileSync(process.argv[2] || 'test-output.txt', 'utf8').split(/\r?\n/);
const esc = s => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
let shown = 0;
for (let i = 0; i < lines.length && shown < 10; i++) {
  const m = lines[i].match(/^\s*not ok \d+ - (.*)$/);
  if (!m) continue;
  const detail = [];
  for (let j = i + 1; j < lines.length && j < i + 40 && !/^\s*(not )?ok \d+/.test(lines[j]); j++) detail.push(lines[j]);
  console.log(`::error title=${esc(m[1].slice(0, 120))}::${esc(detail.join('\n').slice(0, 3000))}`);
  shown++;
}
