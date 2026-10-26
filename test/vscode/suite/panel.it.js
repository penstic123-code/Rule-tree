'use strict';
// 工作区一开始没有规则：插件照样在启动后激活（onStartupFinished），从 activate 的返回值拿到 Panel 实例，
// 包住它的消息处理和 resolveWebviewView，再把示例的规则文件复制进来。
// 测：侧栏 webview 真的加载（网页脚本在 CSP 下跑起来并发回 ready）、导图同样、面板消息处理（加规则 / 撤销 / 删除 / 改名 / 打开规则文件等）。
// 弹框（输入框、确认框、选择框）用替身返回固定答案。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const vscode = require('vscode');
const { WS, RULES, EXT_ID, sleep, waitFor, read, samePath, lastChange, ruleOf, rule } = require('./util');

let panel = null;
const messages = []; // 网页发给插件的消息（侧栏和导图都算）
let resolved = null; // 侧栏 webview 被 VS Code resolve 时拿到的 WebviewView
let uri = null;

const stubs = [];
function stub(name, fn) { stubs.push([name, vscode.window[name]]); vscode.window[name] = fn; }
function unstubAll() { while (stubs.length) { const [n, f] = stubs.pop(); vscode.window[n] = f; } }
const send = msg => panel.handle({ uri, ...msg });

describe('启动后接管（工作区里起初没有规则）', () => {
  it('没有规则时插件照样启动（onStartupFinished），什么都不建', async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    await waitFor(() => ext.isActive, '插件启动后激活');
    assert.ok(!fs.existsSync(RULES));
  });

  it('从 activate 的返回值拿到 Panel，包住消息处理；复制规则文件后 Panel 找到项目', async () => {
    panel = vscode.extensions.getExtension(EXT_ID).exports.panel;
    assert.ok(panel && typeof panel.handle === 'function', 'exports.panel');
    const handle = panel.handle.bind(panel);
    panel.handle = msg => { messages.push(msg); return handle(msg); };
    const resolve = panel.resolveWebviewView.bind(panel);
    panel.resolveWebviewView = (view, ...rest) => { resolved = view; return resolve(view, ...rest); };
    fs.mkdirSync(RULES, { recursive: true });
    for (const n of fs.readdirSync(process.env.RT_EXAMPLE)) fs.copyFileSync(path.join(process.env.RT_EXAMPLE, n), path.join(RULES, n));
    await vscode.commands.executeCommand('ruletree.refresh');
    await waitFor(() => panel.trees.length === 1, 'Panel 找到项目');
    uri = panel.trees[0].uri;
    assert.ok(samePath(panel.trees[0].dir, WS));
    await waitFor(() => fs.existsSync(path.join(RULES, '_guide.md')), '写说明书');
  });
});

describe('侧栏 webview 和导图在真实 VS Code 里加载', () => {
  it('打开侧栏 → VS Code resolve 视图，网页脚本跑起来发回 ready', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.ruletree');
    await waitFor(() => resolved, 'resolveWebviewView 被调用');
    await waitFor(() => messages.some(m => m.type === 'ready'), '侧栏网页发回 ready', 15000);
    const html = resolved.webview.html;
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /script-src 'nonce-/);
    assert.match(html, /view\.js/);
  });

  it('网页发 openMap → 导图打开，导图脚本也发回 ready', async () => {
    const n = messages.filter(m => m.type === 'ready').length;
    await send({ type: 'openMap' });
    await waitFor(() => vscode.window.tabGroups.all.flatMap(g => g.tabs).some(t => t.input instanceof vscode.TabInputWebview && /ruletree\.map/.test(t.input.viewType)), '导图标签页');
    await waitFor(() => messages.filter(m => m.type === 'ready').length > n, '导图网页发回 ready', 15000);
    assert.ok(panel.map && /map\.js/.test(panel.map.webview.html));
  });

  it('截图（RT_SHOT 时）', async function () {
    const out = process.env.RT_SHOT;
    if (!out) return this.skip();
    fs.mkdirSync(out, { recursive: true });
    await sleep(2500);
    const png = path.join(out, 'vscode-sidebar-map.png');
    const ps = path.join(__dirname, 'shot.ps1');
    const r = await new Promise(res => cp.execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps],
      { env: { ...process.env, RT_SHOT_OUT: png } }, (err, stdout, stderr) => res({ stdout, stderr })));
    console.log('    截图：', (r.stdout || '').trim(), (r.stderr || '').trim());
    assert.ok(fs.existsSync(png), '截图没生成');
  });
});

describe('面板消息处理（真实 VS Code API + 弹框替身）', () => {
  afterEach(unstubAll);

  it('ready → push 不抛错；不认识的消息、别的项目的消息忽略', async () => {
    await send({ type: 'ready' });
    await send({ type: 'whatever' });
    await panel.handle({ type: 'edit', uri: 'file:///not/a/tree', action: 'addRule', node: 'R4' });
  });

  let addId = null;
  it('addRule：输入框给的规则写进 R4 的规则文件、记改动（来源「你」）', async () => {
    stub('showInputBox', async () => '面板加的规则一二三');
    await send({ type: 'edit', action: 'addRule', node: 'R4' });
    assert.match(rule('R4'), /- 接着第1章的问题开场\n- 面板加的规则一二三\n/);
    const c = lastChange();
    assert.strictEqual(c.source, '你');
    addId = c.id;
  });

  it('同一条规则再加一次 → 不改，提示「没有改动」', async () => {
    const shown = [];
    stub('showInputBox', async () => '面板加的规则一二三');
    stub('showInformationMessage', async m => { shown.push(m); });
    const before = rule('R4');
    await send({ type: 'edit', action: 'addRule', node: 'R4' });
    assert.strictEqual(rule('R4'), before);
    assert.ok(shown.some(m => /没有改动/.test(m)), '应提示没有改动：' + shown.join(' | '));
  });

  it('undo → 规则去掉；再撤销一次给警告', async () => {
    await send({ type: 'undo', id: addId });
    assert.ok(!rule('R4').includes('面板加的规则一二三'));
    const warned = [];
    stub('showWarningMessage', async m => { warned.push(m); });
    await send({ type: 'undo', id: addId });
    assert.ok(warned.some(m => /没能撤销/.test(m)));
  });

  it('setStatus / rename（带 title，文件名跟着改）/ deleteRule', async () => {
    await send({ type: 'edit', action: 'setStatus', node: 'R4', status: 'done' });
    assert.match(rule('R4'), /^# R4 第2章 ✅$/m);
    await send({ type: 'edit', action: 'rename', node: 'R4', title: '第二章' });
    assert.ok(path.basename(ruleOf('R4')) === 'R4-第二章.md');
    assert.match(rule('R4'), /^# R4 第二章 ✅$/m);
    await send({ type: 'edit', action: 'rename', node: 'R4', title: '   ' });
    assert.match(rule('R4'), /^# R4 第二章 ✅$/m);
    await send({ type: 'edit', action: 'deleteRule', node: 'R3.1', text: '反例画出缺的那一项' });
    assert.ok(!rule('R3.1').includes('反例画出缺的那一项'));
  });

  it('editRule / overrideRule（写成取代说明）', async () => {
    stub('showInputBox', async () => '每个概念至少 4 个例子');
    await send({ type: 'edit', action: 'editRule', node: 'R3.1', text: '每个概念至少 3 个例子，含 1 个反例' });
    assert.ok(rule('R3.1').includes('- 每个概念至少 4 个例子'));
    stub('showInputBox', async () => '段落不超过 8 行');
    await send({ type: 'edit', action: 'overrideRule', node: 'R4', from: 'P', text: '段落不超过 4 行' });
    assert.ok(rule('R4').includes('- 段落不超过 8 行（在本范围内取代 P 的「段落不超过 4 行」）'));
  });

  it('addChild：新建子需求（新文件，选择框答「先不设」，沿用上级的范围）', async () => {
    stub('showInputBox', async () => '集成测试子需求');
    stub('showQuickPick', async items => items.find(i => i.id === 'none'));
    await send({ type: 'edit', action: 'addChild', node: 'R3' });
    assert.match(rule('R3.4'), /^---\npaths:\n {2}- "DataScience\/ch01-\*\.html"\n---\n# R3\.4 集成测试子需求\n上级：R3 第1章\n/);
  });

  it('delete（确认框答「删除」）→ 文件没了；undo 恢复', async () => {
    stub('showWarningMessage', async () => '删除');
    await send({ type: 'edit', action: 'delete', node: 'R3.3' });
    assert.strictEqual(ruleOf('R3.3'), null);
    unstubAll();
    await send({ type: 'undo', id: lastChange().id });
    assert.ok(rule('R3.3').includes('练习题'), '撤销后应恢复 R3.3');
  });

  it('setFiles：手动输入路径规则写进文件头', async () => {
    stub('showQuickPick', async items => items.find(i => i.id === 'type'));
    stub('showInputBox', async () => 'DataScience/ch02-*.html, DataScience/ch02/**');
    await send({ type: 'edit', action: 'setFiles', node: 'R4' });
    assert.match(rule('R4'), /^---\npaths:\n {2}- "DataScience\/ch02-\*\.html"\n {2}- "DataScience\/ch02\/\*\*"\n---\n/);
  });

  it('open：打开规则文件，按原文找回行', async () => {
    const f = ruleOf('R3.2');
    const lines = read(f).split(/\r?\n/);
    const line = lines.findIndex(l => l.startsWith('# R3.2'));
    await send({ type: 'open', file: path.basename(f), line: 0, expect: lines[line] });
    const ed = vscode.window.activeTextEditor;
    assert.ok(ed && samePath(ed.document.uri.fsPath, f));
    assert.strictEqual(ed.selection.active.line, line);
  });

  it('全程扩展宿主里没有 console.error', () => {
    assert.deepStrictEqual(global.__rtErrors, []);
  });
});
