# 在 OpenAI Codex 里用需求树

需求树原本是给 Claude Code 做的。Codex（CLI、桌面版、IDE 插件）没有「改到哪个文件才加载哪条规则」的机制，所以换了一种送法，效果相同。

## 怎么启用

```bash
node Vibe-Friend/bin/reqtree.js init <项目目录> --tool codex
```

它会做四件事：

| 写到哪里 | 做什么 |
|---|---|
| `AGENTS.md` 末尾的托管块（`<!-- reqtree:begin -->` 到 `<!-- reqtree:end -->`） | 全局规则 + 一张索引：「改 `DataScience/ch01-*.html` 之前先读 `.reqtree/rules/R3.md`」。你自己写在 AGENTS.md 里的内容一个字不动。项目根有 `AGENTS.override.md` 时写进它（Codex 这时不读 AGENTS.md） |
| `.reqtree/rules/<编号>.md` | 每个有文件对应的需求一份，带上它下面没写文件的子需求 |
| `.codex/hooks.json` | 5 个 hook：AI 读写到某个需求的文件时把那份规则送过去；记下 AI 改了哪个需求；每轮结束启动记录员；每 8 轮和上下文压缩前补漏一次。你自己的 hook 保留 |
| `.reqtree/codex.json` | 记录员用的模型（默认 `gpt-6-luna`、推理强度 `low`），可以改；也可以写 `recorderCmd` 换成任意命令 |

**还差一步：信任 hook。** Codex 只运行你审核过的项目 hook。在项目目录里运行一次 `codex`，输入 `/hooks`，信任 5 个标着「需求树」的 hook。项目本身也要是 Codex 信任的项目。不信任也能用：AI 会照 AGENTS.md 里的索引自己去读规则文件，只是没有「AI 正在改」和自动记录。

升级需求树或换了安装位置后 hook 命令会变，需要在 `/hooks` 里重新信任一次。

## 规则怎么到 AI 手上

1. **会话开始**：Codex 读 AGENTS.md，拿到全局规则和索引。
2. **AI 动手前**：照索引读对应的规则文件（实测 AI 会先读 `.reqtree/rules/R4.md` 再改第 2 章）。
3. **hook 兜底**：AI 用命令读、或用 `apply_patch` 改到某个需求的文件，而这份规则它还没读过，hook 就把规则作为附加上下文送过去。同一份每个会话只送一次，规则改了再送；上下文压缩后重送。
4. **会话中途改了全局规则**：下一句话时 hook 补送新版。
5. **还没动手、只是在讨论**：你这句话明确提到某个需求（标题、编号、「第3章」）时，hook 把它的规则补上，每个会话一次。

别的需求的规则不会出现在上下文里。

## 能做什么、不能做什么

| 功能 | Codex 下 | 说明 |
|---|---|---|
| 按文件送规则 | ✅ | 通过 AGENTS.md 索引 + hook。精度到 glob，和 Claude Code 版一样 |
| 子需求覆盖母规则 | ✅ | 规则文件里写明「在本范围内以此为准，取代上级…」 |
| 记录员自动记下长期要求 | ✅ | 用 `codex exec` 调小模型，消耗你的 ChatGPT 额度（每轮一次，约 7 秒，短回复和纯提问不调用） |
| 面板显示「AI 正在改」 | ✅ | 认 `apply_patch` 和 PowerShell/shell 里的写文件命令（Set-Content、WriteAllText、sed -i 等） |
| 子 agent | ❓ | 没测。Codex 子 agent 触发的是 SubagentStart/SubagentStop，没有装 |
| AGENTS.md 大小 | ⚠ | Codex 默认只读 AGENTS.md 合计 32 KiB。全局规则太多会被截掉，编译时会提醒 |
| Codex 云端任务 | ✗ | `.reqtree/` 在 .gitignore 里，云端拿不到规则文件 |

## 验证情况（2026-10-22，Codex CLI 0.163.0，Windows）

| 项目 | 结果 |
|---|---|
| AGENTS.md 托管块进入模型上下文 | ✅ `codex debug prompt-input` 和真实运行都看到了 |
| AI 照索引先读规则文件再改 | ✅ 两次真实运行都是先读 `R3.md`/`R4.md` |
| 只拿到对应需求的规则，别的需求的没有 | ✅ 改第 2 章时让 AI 逐字列出收到的规则，只有全局规则和 R4 |
| hook 送规则（PostToolUse 附加上下文） | ✅ 去掉索引后，AI 列出「工具输出附加的需求规则：接着第1章的问题开场」 |
| SessionStart / UserPromptSubmit / PostToolUse / Stop 都触发 | ✅ |
| `apply_patch` 的文件名解析、活动记录 | ✅ 真实补丁里解析出 `DataScience/ch02-next.html`，记到 R4 |
| 记录员：「以后每章结尾都加一道思考题」写进树、R4 标 🔨、AGENTS.md 自动更新 | ✅ 第一次小模型把它挂在已有的 `[练习]` 键下，同一节点出现两条同键规则；已在 `applyOps` 里拦住（同节点同键自动改为改写原条），并过滤掉记录员没有根据的「设对应文件」 |
| hook 信任哈希的算法 | ✅ 和 `codex app-server` 的 `hooks/list` 返回值逐个对上 |
| Codex 桌面版、IDE 插件里是否运行项目 hook、在哪里信任 | 未验证。桌面版和 CLI 共用 `~/.codex`，在 CLI 里 `/hooks` 信任后应该通用 |
| macOS / Linux | 未验证 |

## 参考

- Codex hooks：<https://developers.openai.com/codex/hooks>
- AGENTS.md：<https://developers.openai.com/codex/guides/agents-md>
- 信任哈希：`codex-rs/hooks/src/engine/discovery.rs`（`hook_hash`）、`codex-rs/config/src/fingerprint.rs`（`version_for_toml`）
