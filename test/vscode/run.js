'use strict';
// 在真实 VS Code 里跑插件集成测试（@vscode/test-electron）。
// 下载一份独立的 VS Code 到临时目录，用独立的 --user-data-dir / --extensions-dir 启动，不碰用户自己的 VS Code。
// 跑两次：
//   main  —— 工作区一开始就有 需求树.md：测 workspaceContains 激活、命令、启用、导图、改树后重编译
//   panel —— 工作区一开始没有树：测试先包住 registerWebviewViewProvider 再触发激活，拿到 Panel，
//            测侧栏 webview 真的加载（网页发回 ready）、消息处理（加规则 / 撤销 / 删除 / 编辑器未保存时写树等）
//
// 依赖装在临时目录（不进项目）：
//   npm install --cache <S>/.npm --prefix <S> @vscode/test-electron mocha
// 运行：
//   node test/vscode/run.js [main|panel]          （S 默认见下，可用环境变量 RT_SCRATCH 指定）
// 可选环境变量：RT_VSCODE_VERSION（默认 stable）、RT_SHOT=1（panel 套件里截一张真实窗口图）
const fs = require('fs');
const os = require('os');
const path = require('path');

const S = process.env.RT_SCRATCH || path.join(os.tmpdir(), 'reqtree-vscode-it');
const { runTests } = require(path.join(S, 'node_modules', '@vscode', 'test-electron'));

// 从 VS Code 的终端（或 Claude Code）里启动时会继承 ELECTRON_RUN_AS_NODE、VSCODE_IPC_HOOK 等，
// 带着它们启动 Code.exe 会变成 node 或连到用户正在用的 VS Code，一律去掉
for (const k of Object.keys(process.env)) if (/^(VSCODE_|ELECTRON_)/i.test(k)) delete process.env[k];

const EXT = path.resolve(__dirname, '..', '..');
const RUN = Date.now().toString(36);
const HOME = path.join(S, 'reqtree-home-' + RUN); // REQTREE_HOME：hook 运行时副本装到这里，不碰 ~/.reqtree

function makeWs(name, withTree) {
  const dir = path.join(S, 'ws', `${RUN}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  if (withTree) fs.copyFileSync(path.join(EXT, 'example', '需求树.md'), path.join(dir, '需求树.md'));
  return dir;
}

// 用户真实的 ~/.reqtree：跑前跑后比一下，确认测试没动它
function snapshotRealHome() {
  const dir = path.join(os.homedir(), '.reqtree');
  const out = {};
  const walk = d => { let names = []; try { names = fs.readdirSync(d); } catch { return; }
    for (const n of names) { const p = path.join(d, n); const st = fs.statSync(p); if (st.isDirectory()) walk(p); else out[p] = st.mtimeMs + ':' + st.size; } };
  walk(dir);
  return out;
}

// 扩展宿主日志里的错误行（和本插件有关的算失败）
function hostLogErrors(userData) {
  const found = [];
  const walk = d => { let names = []; try { names = fs.readdirSync(d); } catch { return; }
    for (const n of names) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else if (/exthost.*\.log$|renderer\.log$/.test(n)) {
      for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) if (/\[error\]/i.test(line)) found.push(`${path.relative(userData, p)}: ${line}`);
    } } };
  walk(path.join(userData, 'logs'));
  return found;
}

async function runSuite(suite) {
  const ws = makeWs(suite, suite === 'main');
  const userData = path.join(S, 'user-data-' + suite);
  fs.rmSync(path.join(userData, 'logs'), { recursive: true, force: true });
  // 测试 VS Code 是英文环境；断言按中文界面写，所以固定界面语言
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({ 'reqtree.language': 'zh' }, null, 2));
  const extDir = path.join(S, 'extensions');
  fs.mkdirSync(extDir, { recursive: true });
  console.log(`\n=== ${suite}：工作区 ${ws}`);
  let err = null;
  try {
    await runTests({
      cachePath: path.join(S, '.vscode-test'),
      version: process.env.RT_VSCODE_VERSION || 'stable',
      extensionDevelopmentPath: EXT,
      extensionTestsPath: path.join(__dirname, 'suite', 'index.js'),
      extensionTestsEnv: {
        RT_SUITE: suite,
        RT_MOCHA: path.join(S, 'node_modules', 'mocha'),
        RT_WS: ws,
        RT_EXAMPLE: path.join(EXT, 'example', '需求树.md'),
        RT_SHOT: process.env.RT_SHOT ? path.join(S, 'shots') : '',
        RT_CODE_DIR: path.join(S, '.vscode-test'),
        REQTREE_HOME: HOME,
      },
      launchArgs: [ws, '--disable-extensions', `--user-data-dir=${userData}`, `--extensions-dir=${extDir}`,
        '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--disable-updates'],
    });
  } catch (e) { err = e; }
  const logErrs = hostLogErrors(userData);
  const ours = logErrs.filter(l => /reqtree|需求树|extension\.js/i.test(l));
  if (logErrs.length) console.log(`--- ${suite}：VS Code 日志里的 [error] 行（${logErrs.length}）：\n` + logErrs.slice(0, 30).join('\n'));
  if (ours.length) err = err || new Error(`日志里有 ${ours.length} 行和需求树有关的错误`);
  return err;
}

(async () => {
  const before = snapshotRealHome();
  const suites = process.argv[2] ? [process.argv[2]] : ['main', 'panel'];
  const errors = [];
  for (const s of suites) { const e = await runSuite(s); if (e) errors.push(`${s}: ${e.message || e}`); }
  const after = snapshotRealHome();
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => before[k] !== after[k]);
  if (changed.length) errors.push(`~/.reqtree 被改动了：${changed.slice(0, 5).join(', ')}`);
  else console.log('\n~/.reqtree 未被改动');
  console.log(`REQTREE_HOME（测试用）：${HOME}`);
  if (errors.length) { console.error('\n失败：\n' + errors.join('\n')); process.exit(1); }
  console.log('\n全部通过');
})();
