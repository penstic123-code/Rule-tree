#!/usr/bin/env node
'use strict';
// CI 用：读 node --test 的 TAP 输出，把失败的测试写成 GitHub 的 ::error 注释。
// 注释在公开仓库里不登录也能看到（日志要登录），方便排查。用法：node tools/ci-annotate.js test-output.txt
// GitHub 每一步最多显示 10 条 error、10 条 notice：前 10 个失败各一条 error，另用一条 notice 列出全部失败的名字和统计。
const fs = require('fs');
const file = process.argv[2] || 'test-output.txt';
const esc = s => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = s => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

let text = '';
try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
  console.log(`::error title=no test output::${esc(`读不到 ${file}：${e.message}（测试步骤可能没跑起来）`)}`);
  process.exit(0);
}
const lines = text.split(/\r?\n/);
const failed = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^\s*not ok \d+ - (.*)$/);
  if (!m) continue;
  const detail = [];
  for (let j = i + 1; j < lines.length && j < i + 60 && !/^\s*((not )?ok \d+|# Subtest:)/.test(lines[j]); j++) detail.push(lines[j]);
  failed.push({ name: m[1], detail: detail.join('\n') });
}
for (const f of failed.slice(0, 10)) console.log(`::error title=${escProp(f.name.slice(0, 120))}::${esc(f.detail.slice(0, 4000))}`);

const stats = lines.filter(l => /^# (tests|pass|fail|cancelled|skipped|todo|duration_ms) /.test(l)).join('  ');
if (failed.length) {
  console.log(`::notice title=${escProp(`${failed.length} failing`)}::${esc((stats ? stats + '\n' : '') + failed.map(f => '- ' + f.name).join('\n').slice(0, 4000))}`);
} else {
  // 没有失败的测试却走到这一步：多半是测试卡住被超时杀掉、或者没跑起来。把输出的最后几十行贴出来
  console.log(`::error title=no failing test found (timeout or crash?)::${esc((stats ? stats + '\n' : '') + lines.slice(-40).join('\n').slice(-4000))}`);
}
