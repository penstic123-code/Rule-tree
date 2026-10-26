'use strict';
// 工作区一开始是旧版的项目（只有 需求树.md）：workspaceContains 激活、自动升级成规则文件、命令、导图、在编辑器里改规则文件
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { WS, TREE, RULES, EXT_ID, sleep, waitFor, read, samePath, lastChange, ruleOf, rule } = require('./util');

const HOME = process.env.RULETREE_HOME;
const allTabs = () => vscode.window.tabGroups.all.flatMap(g => g.tabs);
const mapTabs = () => allTabs().filter(t => t.input instanceof vscode.TabInputWebview && /ruletree\.map/.test(t.input.viewType));
const settings = () => JSON.parse(read(path.join(WS, '.claude', 'settings.local.json')));

describe('激活（工作区里有旧版的 需求树.md）', () => {
  it('插件被 workspaceContains 自动激活，返回 { prompted }', async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, '找不到插件 ' + EXT_ID);
    await waitFor(() => ext.isActive, '插件激活');
    assert.ok(ext.exports && ext.exports.prompted instanceof Promise, 'exports.prompted 应是 Promise');
  });

  it('自动升级：需求树.md 拆成规则文件（带 paths），原文件挪进 .ruletree/legacy，写说明书、装 hook、忽略 .ruletree/', async () => {
    await waitFor(() => fs.existsSync(path.join(RULES, '_guide.md')), '_guide.md');
    assert.ok(!fs.existsSync(TREE), '需求树.md 应挪走');
    assert.ok(fs.existsSync(path.join(WS, '.ruletree', 'legacy', '需求树.md')));
    const r3 = rule('R3');
    assert.ok(r3.includes('paths:') && r3.includes('DataScience/ch01-*.html'), 'R3 应带 paths');
    assert.match(read(path.join(RULES, '_root.md')), /^# P 示例课程/);
    const s = settings();
    assert.deepStrictEqual(Object.keys(s.hooks).sort(), ['InstructionsLoaded', 'PostToolUse']);
    const home = HOME.replace(/\\/g, '/');
    for (const ev of Object.keys(s.hooks)) assert.ok(s.hooks[ev][0].hooks[0].command.includes(home + '/runtime/hooks/hook.js'), `${ev} 的命令没指向 RULETREE_HOME`);
    assert.ok(fs.existsSync(path.join(HOME, 'runtime', 'hooks', 'hook.js')));
    assert.match(read(path.join(WS, '.gitignore')), /^\.ruletree\/$/m);
    assert.strictEqual(lastChange().source, '升级');
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
    assert.ok(all.includes('workbench.view.extension.ruletree'), '视图容器命令');
    assert.ok(all.includes('ruletree.panel.focus'), '视图 focus 命令');
  });

  it('ruletree.refresh 不抛错；ruletree.enable 重复启用不重复写 hook', async () => {
    await vscode.commands.executeCommand('ruletree.refresh');
    await vscode.commands.executeCommand('ruletree.enable');
    const s = settings();
    for (const ev of Object.keys(s.hooks)) assert.strictEqual(s.hooks[ev].length, 1, '重复启用后 hook 重复了：' + ev);
  });

  it('ruletree.create 在已启用的项目里只打开根需求，不覆盖', async () => {
    const before = read(path.join(RULES, '_root.md'));
    await vscode.commands.executeCommand('ruletree.create');
    await waitFor(() => vscode.window.activeTextEditor && samePath(vscode.window.activeTextEditor.document.uri.fsPath, path.join(RULES, '_root.md')), '打开 _root.md');
    assert.strictEqual(read(path.join(RULES, '_root.md')), before);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('ruletree.openMap 打开导图标签页；再执行一次不开第二个；关掉后能重新打开', async () => {
    await vscode.commands.executeCommand('ruletree.openMap');
    const tab = await waitFor(() => mapTabs()[0], '导图标签页');
    assert.strictEqual(tab.label, '需求树导图');
    await vscode.commands.executeCommand('ruletree.openMap');
    await sleep(300);
    assert.strictEqual(mapTabs().length, 1);
    await vscode.window.tabGroups.close(mapTabs());
    await waitFor(() => !mapTabs().length, '导图关掉');
    await vscode.commands.executeCommand('ruletree.openMap');
    await waitFor(() => mapTabs().length === 1, '导图重新打开');
  });

  it('侧栏视图容器和视图能打开（不抛错）', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.ruletree');
    await vscode.commands.executeCommand('ruletree.panel.focus');
  });
});

describe('在编辑器里改规则文件', () => {
  it('改完保存 → 记成「你」的一条改动，能撤销', async () => {
    const f = ruleOf('R4');
    const doc = await vscode.workspace.openTextDocument(f);
    const line = doc.getText().split(/\r?\n/).findIndex(l => l.includes('接着第1章的问题开场'));
    assert.ok(line >= 0);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, new vscode.Position(line + 1, 0), '- 集成测试规则甲乙丙\n');
    assert.ok(await vscode.workspace.applyEdit(edit));
    assert.ok(await doc.save());
    await waitFor(() => { const c = lastChange(); return c && c.source === '你' && c.summary.some(x => x.includes('集成测试规则甲乙丙')); }, '记下改动');
    const panel = vscode.extensions.getExtension(EXT_ID).exports.panel;
    await waitFor(() => panel.trees.length === 1, '面板找到项目');
    await panel.handle({ type: 'undo', uri: panel.trees[0].uri, id: lastChange().id });
    await waitFor(() => !rule('R4').includes('集成测试规则甲乙丙'), '撤销写回文件');
    await waitFor(() => doc.getText() === read(f), '编辑器跟上磁盘');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('整个过程扩展宿主里没有 console.error', () => {
    assert.deepStrictEqual(global.__rtErrors, []);
  });
});
