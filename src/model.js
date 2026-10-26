'use strict';
// 调用模型（体检用）：claude -p，提示词从 stdin 进，输出里取 JSON。
// 不加载 MCP 和项目配置（冷启动快），不保存会话（免得塞满用户的 /resume 列表），不在项目里运行（免得触发项目的 hook）
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const CLAUDE = process.env.RULETREE_CLAUDE_CMD || 'claude -p --model haiku --strict-mcp-config --no-session-persistence --setting-sources user';
const TIMEOUT_MS = +process.env.RULETREE_CLAUDE_TIMEOUT_MS || 300000;

// 把命令行拆成参数（posix 不经过 shell 时用）：认双引号、单引号和反斜杠转义，和 sh 的规则一致
function splitCommand(cmd) {
  const args = [];
  let cur = '', has = false, quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote === "'") { if (c === "'") quote = null; else cur += c; continue; }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < cmd.length && '"\\$`'.includes(cmd[i + 1])) cur += cmd[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (c === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; has = true; continue; }
    if (/\s/.test(c)) { if (has) { args.push(cur); cur = ''; has = false; } continue; }
    cur += c; has = true;
  }
  if (has) args.push(cur);
  return args;
}

// 杀掉整棵进程树。Windows 上 claude 是 claude.cmd，经 cmd.exe 再起 node，只杀 cmd.exe 会留下真正干活的 node
function killTree(child) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }
}

// Windows 要经过 shell（claude 是 .cmd）；posix 直接按参数启动，免得路径里的 $、引号被 shell 解释
function runModel(prompt, timeoutMs = TIMEOUT_MS, cmd = CLAUDE) {
  return new Promise(resolve => {
    const win = process.platform === 'win32';
    const [file, ...args] = win ? [cmd] : splitCommand(cmd);
    let child;
    try { child = spawn(file, args, { shell: win, windowsHide: true, detached: !win, cwd: os.tmpdir() }); }
    catch (error) { resolve({ error }); return; }
    let stdout = '', stderr = '', done = false;
    const finish = r => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    child.stdout.setEncoding('utf8').on('data', d => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', d => { stderr += d; });
    child.stdin.on('error', () => {}); // 对方没读完就退出时写入会 EPIPE
    child.stdin.end(prompt);
    child.on('error', error => finish({ error }));
    child.on('close', status => finish({ status, stdout, stderr }));
    const timer = setTimeout(() => {
      killTree(child);
      for (const s of [child.stdout, child.stderr, child.stdin]) try { s.destroy(); } catch {}
      finish({ timedOut: true });
    }, timeoutMs);
  });
}

// 出错时除了中文 message，再带上结构化的 t（{ k: 文字表的键, a: 参数 }），界面按当前语言显示
const fail = (message, k, ...a) => Object.assign(new Error(message), { t: { k, a } });

// 调用模型，返回它输出的 JSON 对象
async function askJson(prompt, { timeoutMs = TIMEOUT_MS, cmd = CLAUDE } = {}) {
  const res = await runModel(prompt, timeoutMs, cmd);
  if (res.timedOut) throw fail(`调用模型超时（${Math.round(timeoutMs / 1000)} 秒没有返回）`, 'm.timeout', Math.round(timeoutMs / 1000));
  if (res.error) throw fail(`调用模型失败：${res.error.message}`, 'm.spawn', res.error.message);
  if (res.status !== 0) {
    const out = (res.stderr || res.stdout || '').trim().slice(0, 200);
    throw fail(`模型返回错误：${out || '退出码 ' + res.status}`, 'm.error', out || String(res.status));
  }
  const m = (res.stdout || '').match(/\{[\s\S]*\}/);
  let out = null;
  try { out = m && JSON.parse(m[0]); } catch {}
  if (!out || typeof out !== 'object') throw fail(`模型没有返回 JSON：${(res.stdout || '').slice(0, 120)}`, 'm.noJson', (res.stdout || '').slice(0, 120));
  return out;
}

module.exports = { askJson, runModel, splitCommand, fail };
