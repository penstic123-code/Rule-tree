'use strict';
// 工作区一开始没有树：插件照样在启动后激活（onStartupFinished），从 activate 的返回值拿到 Panel 实例，
// 包住它的消息处理和 resolveWebviewView，再复制树进来。
// 测：侧栏 webview 真的加载（网页脚本在 CSP 下跑起来并发回 ready）、导图同样、面板消息处理（加规则 / 撤销 / 删除 /
// 编辑器有未保存改动时写树等）。弹框（输入框、确认框、选择框）用替身返回固定答案。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const vscode = require('vscode');
const { WS, TREE, RULES, EXT_ID, sleep, waitFor, read, samePath, lastChange } = require('./util');

let panel = null;
const messages = []; // 网页发给插件的消息（侧栏和导图都算）
let resolved = null; // 侧栏 webview 被 VS Code resolve 时拿到的 WebviewView
let uri = null;

// 把 vscode.window 上的弹框换成替身，测试结束换回来
const stubs = [];
function stub(name, fn) { stubs.push([name, vscode.window[name]]); vscode.window[name] = fn; }
function unstubAll() { while (stubs.length) { const [n, f] = stubs.pop(); vscode.window[n] = f; } }
const send = msg => panel.handle({ uri, ...msg });
const treeText = () => read(TREE);

describe('启动后接管（工作区里起初没有树）', () => {
  it('没有树时插件照样启动（onStartupFinished），不编译、不建树', async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    await waitFor(() => ext.isActive, '插件启动后激活');
    assert.ok(!fs.existsSync(TREE));
    assert.ok(!fs.existsSync(RULES), '没有树时不该编译');
  });

  it('从 activate 的返回值拿到 Panel，包住消息处理；复制树后 Panel 找到树', async () => {
    panel = vscode.extensions.getExtension(EXT_ID).exports.panel;
    assert.ok(panel && typeof panel.handle === 'function', 'exports.panel');
    const handle = panel.handle.bind(panel);
    panel.handle = msg => { messages.push(msg); return handle(msg); };
    // 侧栏还没打开过，VS Code 打开时才 resolve，这时包住来得及
    const resolve = panel.resolveWebviewView.bind(panel);
    panel.resolveWebviewView = (view, ...rest) => { resolved = view; return resolve(view, ...rest); };
    fs.copyFileSync(process.env.RT_EXAMPLE, TREE);
    await vscode.commands.executeCommand('reqtree.refresh');
    await waitFor(() => panel.trees.length === 1, 'Panel 找到树');
    uri = panel.trees[0].uri;
    assert.ok(samePath(panel.trees[0].path, TREE));
    await waitFor(() => fs.existsSync(path.join(RULES, 'R3.md')), '激活时编译');
  });
});

describe('侧栏 webview 和导图在真实 VS Code 里加载', () => {
  it('打开侧栏 → VS Code resolve 视图，网页脚本跑起来发回 ready', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.reqtree');
    await waitFor(() => resolved, 'resolveWebviewView 被调用');
    await waitFor(() => messages.some(m => m.type === 'ready'), '侧栏网页发回 ready', 15000);
    const html = resolved.webview.html;
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /script-src 'nonce-/);
    assert.match(html, /view\.js/);
    assert.strictEqual(resolved.badge, undefined, '记录员没出错时不该有角标');
  });

  it('网页发 openMap → 导图打开，导图脚本也发回 ready', async () => {
    const n = messages.filter(m => m.type === 'ready').length;
    await send({ type: 'openMap' });
    await waitFor(() => vscode.window.tabGroups.all.flatMap(g => g.tabs).some(t => t.input instanceof vscode.TabInputWebview && /reqtree\.map/.test(t.input.viewType)), '导图标签页');
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
    // 异步跑（同步等会卡住扩展宿主）；路径走环境变量，命令行里的中文会被代码页弄坏
    const r = await new Promise(res => cp.execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps],
      { env: { ...process.env, RT_SHOT_OUT: png } }, (err, stdout, stderr) => res({ stdout, stderr })));
    console.log('    截图：', (r.stdout || '').trim(), (r.stderr || '').trim());
    assert.ok(fs.existsSync(png), '截图没生成');
  });
});

describe('面板消息处理（真实 VS Code API + 弹框替身）', () => {
  afterEach(unstubAll);

  it('ready → push 不抛错；不认识的消息忽略', async () => {
    await send({ type: 'ready' });
    await send({ type: 'whatever' });
    await panel.handle({ type: 'edit', uri: 'file:///not/a/tree', action: 'addRule', node: 'R4' });
  });

  let addId = null;
  it('addRule：输入框给的规则写进树、重编译、记改动（来源「你」）', async () => {
    stub('showInputBox', async () => '面板加的规则一二三');
    await send({ type: 'edit', action: 'addRule', node: 'R4' });
    assert.match(treeText(), /## R4 第2章 ⏳\n> 文件：DataScience\/ch02-\*\.html\n- 接着第1章的问题开场\n- 面板加的规则一二三/);
    await waitFor(() => (read(path.join(RULES, 'R4.md')) || '').includes('面板加的规则一二三'), 'R4.md 重编译');
    const c = lastChange();
    assert.strictEqual(c.source, '你');
    addId = c.id;
  });

  it('同一条规则再加一次 → 不改，提示「没有改动」', async () => {
    const shown = [];
    stub('showInputBox', async () => '面板加的规则一二三');
    stub('showInformationMessage', async m => { shown.push(m); });
    const before = treeText();
    await send({ type: 'edit', action: 'addRule', node: 'R4' });
    assert.strictEqual(treeText(), before);
    assert.ok(shown.some(m => /没有改动/.test(m)), '应提示没有改动：' + shown.join(' | '));
  });

  it('undo → 规则去掉、R4.md 跟着更新；再撤销一次给警告', async () => {
    await send({ type: 'undo', id: addId });
    assert.ok(!treeText().includes('面板加的规则一二三'));
    await waitFor(() => !(read(path.join(RULES, 'R4.md')) || '').includes('面板加的规则一二三'), 'R4.md 去掉规则');
    const warned = [];
    stub('showWarningMessage', async m => { warned.push(m); });
    await send({ type: 'undo', id: addId });
    assert.ok(warned.some(m => /没能撤销/.test(m)));
  });

  it('setStatus / rename（带 title）/ deleteRule', async () => {
    await send({ type: 'edit', action: 'setStatus', node: 'R4', status: 'done' });
    assert.match(treeText(), /^## R4 第2章 ✅$/m);
    await send({ type: 'edit', action: 'rename', node: 'R4', title: '第二章' });
    assert.match(treeText(), /^## R4 第二章 ✅$/m);
    await send({ type: 'edit', action: 'rename', node: 'R4', title: '   ' }); // 空名字不收
    assert.match(treeText(), /^## R4 第二章 ✅$/m);
    await send({ type: 'edit', action: 'deleteRule', node: 'R3.1', text: '反例画出缺的那一项' });
    assert.ok(!treeText().includes('反例画出缺的那一项'));
  });

  it('editRule / overrideRule', async () => {
    stub('showInputBox', async () => '每个概念至少 4 个例子');
    await send({ type: 'edit', action: 'editRule', node: 'R3.1', text: '每个概念至少 3 个例子，含 1 个反例' });
    assert.ok(treeText().includes('- 每个概念至少 4 个例子'));
    stub('showInputBox', async () => '段落不超过 8 行');
    await send({ type: 'edit', action: 'overrideRule', node: 'R4', from: 'P', text: '段落不超过 4 行' });
    assert.ok(/## R4 第二章 ✅[\s\S]*段落不超过 8 行/.test(treeText()), 'R4 下应有覆盖规则');
    await waitFor(() => /取代上级/.test(read(path.join(RULES, 'R4.md')) || ''), 'R4.md 写出覆盖说明');
  });

  it('addChild：新建子需求（选择框答「先不设」）', async () => {
    stub('showInputBox', async () => '集成测试子需求');
    stub('showQuickPick', async items => items.find(i => i.id === 'none'));
    await send({ type: 'edit', action: 'addChild', node: 'R3' });
    assert.match(treeText(), /^### R3\.4 集成测试子需求$/m);
  });

  it('delete（确认框答「删除」）→ 节点没了；undo 恢复', async () => {
    stub('showWarningMessage', async () => '删除');
    await send({ type: 'edit', action: 'delete', node: 'R3.3' });
    assert.ok(!/R3\.3 练习题/.test(treeText()));
    unstubAll();
    await send({ type: 'undo', id: lastChange().id });
    assert.ok(/### R3\.3 练习题/.test(treeText()), '撤销后应恢复 R3.3');
  });

  it('setFiles：手动输入路径规则', async () => {
    stub('showQuickPick', async items => items.find(i => i.id === 'type'));
    stub('showInputBox', async () => 'DataScience/ch02-*.html, DataScience/ch02/**');
    await send({ type: 'edit', action: 'setFiles', node: 'R4' });
    assert.match(treeText(), /## R4 第二章 ✅\n> 文件：DataScience\/ch02-\*\.html, DataScience\/ch02\/\*\*/);
  });

  it('编辑器里有未保存改动时，面板加规则会写进编辑器并保存，两边改动都在', async () => {
    const doc = await vscode.workspace.openTextDocument(TREE);
    const ed = await vscode.window.showTextDocument(doc);
    const line = doc.getText().split(/\r?\n/).findIndex(l => l.includes('6 篇 24 章'));
    await ed.edit(b => b.insert(new vscode.Position(line + 1, 0), '- 用户还没保存的规则\n'));
    assert.ok(doc.isDirty);
    assert.ok(!treeText().includes('用户还没保存的规则'));
    stub('showInputBox', async () => '面板在编辑中加的规则');
    await send({ type: 'edit', action: 'addRule', node: 'R4' });
    await waitFor(() => !doc.isDirty, '文档已保存');
    const t = treeText();
    assert.ok(t.includes('用户还没保存的规则'), '用户的改动丢了');
    assert.ok(t.includes('面板在编辑中加的规则'), '面板的改动没写进去');
    assert.strictEqual(doc.getText(), t, '编辑器和磁盘应一致');
    // 撤销也走编辑器
    await send({ type: 'undo', id: lastChange().id });
    await waitFor(() => !treeText().includes('面板在编辑中加的规则'), '撤销写到磁盘');
    assert.ok(treeText().includes('用户还没保存的规则'));
  });

  it('open：按原文找回行，在编辑器里定位', async () => {
    const lines = treeText().split(/\r?\n/);
    const line = lines.findIndex(l => l.startsWith('### R3.2'));
    await send({ type: 'open', line: 0, expect: lines[line] }); // 行号故意给错，靠原文找回
    const ed = vscode.window.activeTextEditor;
    assert.ok(ed && samePath(ed.document.uri.fsPath, TREE));
    assert.strictEqual(ed.selection.active.line, line);
  });

  it('setConfig：暂停记录员写进 .reqtree/config.json', async () => {
    await send({ type: 'setConfig', patch: { recorder: 'off', junk: 1 } });
    const c = JSON.parse(read(path.join(WS, '.reqtree', 'config.json')));
    assert.strictEqual(c.recorder, 'off');
    assert.ok(!('junk' in c));
  });

  it('全程扩展宿主里没有 console.error', () => {
    assert.deepStrictEqual(global.__rtErrors, []);
  });
});
