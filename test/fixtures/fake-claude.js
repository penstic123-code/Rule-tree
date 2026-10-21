#!/usr/bin/env node
// 测试用的假 claude：记下收到的提示词，按环境变量返回结果或报错
const fs = require('fs');
let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ input, env: !!process.env.REQTREE_RECORDER }) + '\n');
  // 模拟卡住的 claude：再开一个子进程（像 claude.cmd 背后的 node），把它的 pid 写进 FAKE_HANG，然后两个都不退出
  if (process.env.FAKE_HANG) {
    const child = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    fs.writeFileSync(process.env.FAKE_HANG, String(child.pid));
    setTimeout(() => {}, 60000);
    return;
  }
  if (process.env.FAKE_EXIT) { process.stderr.write('Not logged in'); process.exit(+process.env.FAKE_EXIT); }
  process.stdout.write(process.env.FAKE_OUT || '{"ops":[]}');
});
