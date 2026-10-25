'use strict';
// 工作区一开始就有 需求树.md：workspaceContains 激活、命令、启用、导图、改树后重编译
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { WS, TREE, RULES, EXT_ID, sleep, waitFor, read, samePath } = require('./util');

const HOME = process.env.REQTREE_HOME;
const allTabs = () => vscode.window.tabGroups.all.flatMap(g => g.tabs);
const mapTabs = () => allTabs().filter(t => t.input instanceof vscode.TabInputWebview && /reqtree\.map/.test(t.input.viewType));

describe('激活（工作区里有 需求树.md）', () => {
  it('插件被 workspaceContains 自动激活，返回 { prompted }', async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, '找不到插件 ' + EXT_ID);
    await waitFor(() => ext.isActive, '插件激活');
    assert.ok(ext.exports && ext.exports.prompted instanceof Promise, 'exports.prompted 应是 Promise');
  });

  it('激活时把树编译成 .claude/rules/reqtree/', async () => {
    await waitFor(() => fs.existsSync(path.join(RULES, '_index.md')), '_index.md');
    const r3 = read(path.join(RULES, 'R3.md'));
    assert.ok(r3 && r3.includes('paths:') && r3.includes('DataScience/ch01-*.html'), 'R3.md 应带 paths');
    assert.ok(read(path.join(RULES, 'P.md')) || read(path.join(RULES, '_index.md')), '根规则');
  });

  it('激活后扩展宿主里没有 console.error（激活可能早于测试加载，日志另由 run.js 检查）', () => {
    assert.deepStrictEqual(global.__rtErrors, []);
  });
});

describe('命令', () => {
  it('package.json 里的命令全部注册了', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
    const all = await vscode.commands.getCommands(true);
    for (const c of pkg.contributes.commands) assert.ok(all.includes(c.command), '没注册：' + c.command);
    // 视图容器 / 视图也在
    assert.ok(all.includes('workbench.view.extension.reqtree'), '视图容器命令');
    assert.ok(all.includes('reqtree.panel.focus'), '视图 focus 命令');
  });

  it('reqtree.refresh 不抛错', async () => {
    await vscode.commands.executeCommand('reqtree.refresh');
  });

  it('reqtree.enable 在没装 hook 的项目里写 hook，命令指向 REQTREE_HOME', async () => {
    const settings = path.join(WS, '.claude', 'settings.local.json');
    assert.ok(!fs.existsSync(settings), '开始时不应有 settings.local.json');
    await vscode.commands.executeCommand('reqtree.enable');
    const s = JSON.parse(read(settings));
    const events = ['UserPromptSubmit', 'Stop', 'PostToolUse', 'InstructionsLoaded', 'PreCompact'];
    for (const ev of events) assert.ok(Array.isArray(s.hooks[ev]) && s.hooks[ev].length === 1, '缺 hook：' + ev);
    const home = HOME.replace(/\\/g, '/');
    for (const ev of events) for (const h of s.hooks[ev][0].hooks) assert.ok(h.command.includes(home + '/runtime/hooks/hook.js'), `${ev} 的命令没指向 REQTREE_HOME：${h.command}`);
    assert.ok(fs.existsSync(path.join(HOME, 'runtime', 'version')), 'REQTREE_HOME/runtime/version');
    assert.ok(fs.existsSync(path.join(HOME, 'runtime', 'hooks', 'hook.js')), 'REQTREE_HOME/runtime/hooks/hook.js');
    assert.match(read(path.join(WS, '.gitignore')), /^\.reqtree\/$/m);
    // 再跑一次不重复写
    await vscode.commands.executeCommand('reqtree.enable');
    const s2 = JSON.parse(read(settings));
    for (const ev of events) assert.strictEqual(s2.hooks[ev].length, 1, '重复启用后 hook 重复了：' + ev);
  });

  it('reqtree.create 在已有树、已启用时只打开它，不覆盖', async () => {
    const before = read(TREE);
    await vscode.commands.executeCommand('reqtree.create');
    await waitFor(() => vscode.window.activeTextEditor && samePath(vscode.window.activeTextEditor.document.uri.fsPath, TREE), '打开需求树.md');
    assert.strictEqual(read(TREE), before);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('reqtree.openMap 打开导图标签页；再执行一次不开第二个', async () => {
    await vscode.commands.executeCommand('reqtree.openMap');
    const tab = await waitFor(() => mapTabs()[0], '导图标签页');
    assert.strictEqual(tab.label, '需求树导图');
    await vscode.commands.executeCommand('reqtree.openMap');
    await sleep(300);
    assert.strictEqual(mapTabs().length, 1);
  });

  it('侧栏视图容器和视图能打开（不抛错）', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.reqtree');
    await vscode.commands.executeCommand('reqtree.panel.focus');
  });

  it('关掉导图后能重新打开', async () => {
    await vscode.window.tabGroups.close(mapTabs());
    await waitFor(() => !mapTabs().length, '导图关掉');
    await vscode.commands.executeCommand('reqtree.openMap');
    await waitFor(() => mapTabs().length === 1, '导图重新打开');
  });
});

describe('改树后自动重编译', () => {
  it('用 WorkspaceEdit 改 需求树.md 并保存 → R4.md 更新', async () => {
    const doc = await vscode.workspace.openTextDocument(TREE);
    const line = doc.getText().split(/\r?\n/).findIndex(l => l.includes('接着第1章的问题开场'));
    assert.ok(line >= 0);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, new vscode.Position(line + 1, 0), '- 集成测试规则甲乙丙\n');
    assert.ok(await vscode.workspace.applyEdit(edit));
    assert.ok(await doc.save());
    await waitFor(() => (read(path.join(RULES, 'R4.md')) || '').includes('集成测试规则甲乙丙'), 'R4.md 含新规则');
  });

  it('编辑器外直接写文件（文件监视）→ 新需求编出自己的规则文件，删掉后文件也删', async () => {
    const add = '\n## R9 集成测试需求 ⏳\n> 文件：it/**\n- 文件监视测试规则\n';
    fs.writeFileSync(TREE, read(TREE) + add);
    await waitFor(() => (read(path.join(RULES, 'R9.md')) || '').includes('文件监视测试规则'), 'R9.md 生成');
    fs.writeFileSync(TREE, read(TREE).replace(add, ''));
    await waitFor(() => !fs.existsSync(path.join(RULES, 'R9.md')), 'R9.md 删除');
  });

  it('编辑器有未保存改动时：写 editing 标记，记录员的改动排队；保存后排队的改动写进去，用户改动也在', async () => {
    const store = require(path.join(__dirname, '..', '..', '..', 'src', 'store.js'));
    const doc = await vscode.workspace.openTextDocument(TREE);
    const ed = await vscode.window.showTextDocument(doc);
    const line = doc.getText().split(/\r?\n/).findIndex(l => l.includes('接着第1章的问题开场'));
    await ed.edit(b => b.insert(new vscode.Position(line + 1, 0), '- 用户编辑中的规则\n'));
    await waitFor(() => store.isEditing(TREE), 'editing 标记');
    const r = store.submitOps(TREE, [{ op: 'add_rule', node: 'R3', text: '记录员排队的规则' }]);
    assert.strictEqual(r.queued, 1, '用户编辑中，记录员的改动应排队');
    assert.ok(!read(TREE).includes('记录员排队的规则'));
    assert.ok(await doc.save());
    await waitFor(() => read(TREE).includes('记录员排队的规则'), '保存后排队的改动写进去');
    assert.ok(read(TREE).includes('用户编辑中的规则'), '用户的改动丢了');
    assert.ok(!store.isEditing(TREE), '保存后 editing 标记应清掉');
    assert.ok(!fs.existsSync(path.join(WS, '.reqtree', 'queue.json')), 'queue.json 应清掉');
    await waitFor(() => doc.getText() === read(TREE) && !doc.isDirty, '编辑器跟上磁盘');
    await waitFor(() => (read(path.join(RULES, 'R3.md')) || '').includes('记录员排队的规则'), 'R3.md 重编译');
  });

  it('未保存的改动被撤回（revert）后 editing 标记清掉', async () => {
    const store = require(path.join(__dirname, '..', '..', '..', 'src', 'store.js'));
    const doc = await vscode.workspace.openTextDocument(TREE);
    const ed = await vscode.window.showTextDocument(doc);
    await ed.edit(b => b.insert(new vscode.Position(0, 0), 'x'));
    await waitFor(() => store.isEditing(TREE), 'editing 标记');
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await waitFor(() => !doc.isDirty, 'revert');
    await waitFor(() => !store.isEditing(TREE), 'revert 后标记清掉');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('整个过程扩展宿主里没有 console.error', () => {
    assert.deepStrictEqual(global.__rtErrors, []);
  });
});
