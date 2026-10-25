# 需求树是怎么搭起来的

用途：给想看懂、想改这个项目的人。先用一张图讲清楚整体，再讲每一部分做什么、为什么这样设计。不需要先懂 Claude Code 的内部机制，用到的地方会解释。

![需求树是怎么工作的](images/architecture.png)

## 一句话

所有信息最后都落到一个文件 `需求树.md` 里；插件把它拆成一份份"只管某些文件"的规则，交给 Claude Code 自带的加载机制；AI 改到哪个文件，才读到管这个文件的规则。

## 为什么要靠 Claude Code 自带的机制

Claude Code 有一种叫"路径规则"的功能：在项目的 `.claude/rules/` 文件夹里放一份规则文件，文件开头写上它管哪些文件（比如 `DataScience/ch03-*.html`），AI 读写这些文件时，Claude Code 就会把这份规则交给 AI。

需求树早期的做法是自己往对话里塞规则，后来发现不可靠：对话被压缩以后、派出的子 agent 里，塞进去的东西会丢。Claude Code 自带的机制在这些情况下都照样生效，会话中途改了规则也会推给 AI。所以现在需求树只负责把树"编译"成这些规则文件，送规则这件事交给 Claude Code。

改第 3 章时，管第 3 章的、管数据科学课的、管整个项目的三份规则都会被读到，因为它们管的范围一层包着一层；管 AI 课的规则不会出现。

![改到哪个文件，就只带上那条路上的规则](images/scope.png)

## 各部分做什么

| 部分 | 什么时候跑 | 做什么 | 代码 |
|---|---|---|---|
| 需求树文件 | — | 唯一的标准答案：需求、状态、规则、挂的文档 | `需求树.md` |
| 解析和编辑 | 每次改树 | 读懂树的结构；所有修改都走同一个入口，每个修改都附带"怎么撤回" | `src/parser.js` |
| 存储 | 每次改树 | 加锁写文件，写完自动编译，记下改动记录 | `src/store.js` |
| 编译 | 树变了、挂的文档变了 | 每个需求生成一份规则文件；长文档附上目录 | `src/compile.js`、`src/docs.js` |
| hook（Claude Code 在特定时刻调用的小程序） | 你发消息、AI 改文件、一轮结束、对话压缩前 | 记下 AI 在改哪个需求；一轮结束叫醒记录员 | `hooks/hook.js` |
| 记录员 | 每轮结束（可以设成每几轮） | 用一个便宜的小模型读最近的对话，把长期要求写进树，挂在你正在做的需求上 | `hooks/recorder.js` |
| 问题 | 记录员、体检要改掉一条「决定：」时 | 先不动，问你；别的拿不准都按最可能的直接改（可撤销），由 `decide` 统一判断 | `src/questions.js` |
| 体检 | 你点"体检"时 | 合并重复、处理矛盾、整理记忆和文档 | `src/checkup.js` |
| 代码地图 | 记录员跑完、这一轮改过代码时 | 用正则读代码，记下每块有什么，生成按需加载的地图 | `src/codemap.js` |
| 界面 | 一直 | 侧栏、导图、详情面板 | `extension.js`、`media/` |
| Codex 支持 | — | Codex 没有路径规则，改用 `AGENTS.md` 里的索引加补送 | `src/targets/`、`hooks/codex-hook.js` |

## 文件放在哪

| 文件 | 内容 | 要不要提交进 git |
|---|---|---|
| `需求树.md` | 树本身 | 要 |
| `.claude/rules/reqtree/` | 编译出来的规则和代码地图 | 可以提交，也可以不提交（随时能重新生成） |
| `.reqtree/` | 改动记录、问题、体检报告、备份、设置 | 不要（已加进 `.gitignore`） |
| `~/.reqtree/runtime/` | hook 程序的副本；插件升级时自动更新 | 不在项目里 |

## 关键的设计决定

| 决定 | 为什么 |
|---|---|
| 树是唯一的标准答案；文档、记忆和树说法不同时，以树为准 | 同一条规则写在两处，迟早会一处改了、一处没改 |
| 改动直接生效，不逐条请你确认，但每条都能撤销 | 逐条确认太累；全不确认又怕错。直接做加上能撤回，两头都照顾到 |
| 记录员先改写旧规则，找不到同一件事才新增 | 不然规则会越堆越长，同一件事好几种说法 |
| 记录员默认把要求挂在你正在做的需求上 | 你在做第 3 章时说的话，多半是对第 3 章说的。早期版本把"像通用偏好的话"都挂到全局，结果别的任务也被这些规则干扰 |
| 规则一句话，细节放文档；长文档附目录，只读需要的节 | 规则每次都要读，所以要短；文档只在需要时读，而且只读相关的那几节 |
| 代码地图用正则，不用 tree-sitter，不调用模型 | 要支持 Godot 的 GDScript（aider 的 repo map 和 graphify 都不支持），而且要快、要免费 |
| hook 只读 Claude Code 公开的字段，不读对话记录文件 | 对话记录的格式没有公开，随时可能变 |

## 改代码前

- 设计笔记见 [design-info-architecture.md](design-info-architecture.md)，每次测试和测量的原始数据见 [test-log.md](test-log.md)。
- 跑测试：`node --test test/*.test.js`（界面测试要装 Edge 或 Chrome）。
- 用真实模型评测记录员：`node test/eval-recorder.js 3`（花少量额度）。

## 命令行

```bash
node bin/reqtree.js init    <项目目录>         # 启用：装 hook、编译规则
node bin/reqtree.js disable <项目目录>         # 停用：去掉 hook 和编译出的规则（需求树.md 留着）
node bin/reqtree.js tree    需求树.md          # 打印整棵树
node bin/reqtree.js rules   需求树.md C2.1     # 某个需求实际生效的规则
node bin/reqtree.js compile 需求树.md          # 手动编译（平时自动）
node bin/reqtree.js check   需求树.md          # 只读检查：重复编号、重复规则、没有对应文件
node bin/reqtree.js check   需求树.md --fix    # 体检（--no-model 不调用模型，--no-memory 不查记忆，--full 全部重查）
node bin/reqtree.js questions 需求树.md        # 等你回答的问题
node bin/reqtree.js answer  需求树.md <问题ID> <选项序号|dismiss>
node bin/reqtree.js map     需求树.md          # 重建代码地图（平时自动）
node bin/reqtree.js who     需求树.md add_money # 某个函数、类、信号在哪定义、谁在用
```
