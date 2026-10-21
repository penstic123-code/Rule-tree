# Vibecoding Friend · ReqTree

**Help your AI coding assistant remember the rules you set: every rule lives in one place, the assistant gets only the rules for the files it is editing, and the long-term requirements you mention in chat are recorded automatically.**

For [Claude Code](https://claude.com/claude-code), with a VS Code extension. **English** | [中文](README.md)

> 🚧 The code is getting its final cleanup and tests and will be uploaded here shortly. For now you can read the introduction and the test data.

![ReqTree mind map](docs/images/ui-map.png)

*The extension UI is currently in Chinese; an English UI is planned.*

## Sound familiar?

You work with an AI assistant on a long project. A few weeks in, your rules are everywhere: said once in chat, written once in CLAUDE.md, stored once in the assistant's memory, copied again into a project doc. Then you change your mind, update one of those places, and the others keep the old version.

Requirements drift the same way. A feature gets revised again and again; the plan from three weeks ago has been overturned twice. Eventually even you can't say what the project currently looks like: which requirements are done, which are in progress, which version of a rule is the latest.

And the longer the conversation, the more the assistant forgets. After context compaction, the "paragraphs at most 4 lines" rule you agreed on early is gone. A subagent gets only some of the rules. Ask "what did we decide?" and it picks one of three contradicting documents.

![Rules scattered across many places](docs/images/en/pain.png)

This is not hypothetical. The author audited their own course project after a few months of work: across 21 rule documents (over 80,000 characters), there were **237 duplicated, contradictory or outdated rules**. One document said "run only one agent at a time", another said "two or three chapters can run in parallel"; the same "three checks" rule had been copied 15 times.

## What it does for you

| Your problem | How ReqTree helps |
|---|---|
| Requirements changed so often you no longer know what the project looks like | Open the sidebar or the mind map and see the whole picture: every requirement, how far along it is, and the current version of each rule. "Recent changes" shows what changed and who changed it, with undo |
| Rules scattered across chat, CLAUDE.md, memory and docs — which one wins? | All requirements and rules live in one file, `需求树.md` (the tree file). Each rule has exactly one place |
| Rules pile up; the same idea gets added again in different words | A background recorder looks for an existing rule on the same topic and **rewrites it** instead of adding a new one. Every change can be undone |
| Long chats and compaction make the assistant forget | Rules are compiled into Claude Code's native rule files, which still apply after compaction and inside subagents |
| Stuffing every rule into the context is costly and distracting | The assistant gets a requirement's rules only when it touches that requirement's files |
| Parent and child rules conflict ("paragraphs ≤ 4 lines" everywhere, but Chapter 1's opening may be longer) | A child requirement overrides a parent rule with the same `[key]`, only within its own scope |
| You can't tell which requirement the assistant is working on | The sidebar and mind map show it live |
| You don't want to hand-edit Markdown | Add, edit and delete rules, change status, set files, undo — all by clicking |

## Screenshots

| Sidebar (dark theme) | Mind map (light theme) |
|---|---|
| <img src="docs/images/ui-sidebar.png" width="300"> | <img src="docs/images/ui-map.png" width="560"> |

Rendered with the extension's own UI code in a browser preview, using `example/需求树.md`.

## Getting started

**You need** Node.js 18+, Claude Code and VS Code.

1. Get the repo and enable it for your project:
   ```bash
   git clone https://github.com/penstic123-code/Vibecoding-Friend.git
   node Vibecoding-Friend/bin/reqtree.js init <your-project>
   ```
   This adds hooks to the project's `.claude/settings.local.json` and creates a template `需求树.md` if there is none.
2. Install the VS Code extension: download `reqtree-<version>.vsix` from [Releases](https://github.com/penstic123-code/Vibecoding-Friend/releases), then Extensions → `…` → "Install from VSIX".
3. Start a new Claude Code session and work as usual.

Day to day you don't do anything extra:
- Say "from now on, end every chapter with a reflection question", and after that turn it appears in the tree.
- When the assistant edits `ch01.html`, it automatically gets the rules of Chapter 1 and everything above it.
- The sidebar shows which requirement the assistant is editing. If the recorder got something wrong, click undo under "Recent changes".

### What the tree looks like

```markdown
# P Example course
- [para] Paragraphs at most 4 lines          ← root rules apply everywhere

## C2 Data science course 🔨
> 文件：DataScience/**                       ← the files this requirement covers
- No direct quotes; retell everything

### C2.1 Chapter 1 🔨
> 文件：DataScience/ch01-*.html
- [para] The opening may run to 6 lines      ← same key: overrides the parent in Chapter 1
- Hook the reader within the first screen
```

- A heading is a requirement: an ID first, a status last (✅ done 🔨 in progress ⏳ to do ❓ undecided).
- List items under a heading are its rules.
- A requirement without `> 文件：` (files) inherits its parent's scope; if no ancestor has one, the panel warns you.

## How it works

Everything revolves around one file. While you chat, a background recorder writes long-term requirements into `需求树.md`. The tree is compiled into one rule file per requirement, each declaring which files it covers. Claude Code's own mechanism hands those rules to the assistant when it touches matching files.

![From one sentence to the rules the assistant sees](docs/images/en/idea.png)

**Loading on demand.** Each requirement compiles to `.claude/rules/reqtree/<ID>.md` with a `paths:` header. These are Claude Code's native path-scoped rules: they enter the context only when the assistant reads or writes a matching file. A parent's scope contains its children's, so editing Chapter 1 brings in the root, the course and the chapter rules — and nothing from other courses.

![Only the rules on the path to the file you edit](docs/images/en/scope.png)

**The recorder.** At the end of each turn, a hook starts Claude Haiku in the background. It reads only your message and the assistant's final reply. It first looks for a rule on the same topic: if there is one, it rewrites it; otherwise it adds one. One-off instructions ("shorten this paragraph") are not recorded, and short replies like "ok" or "continue" skip the model entirely. Changes apply immediately and are logged in `.reqtree/changes.jsonl` with an inverse operation, so each one can be undone.

![The recorder notes long-term requirements in the background](docs/images/en/recorder.png)

**Why not inject rules with hooks?** Early versions did. Claude Code's native rules turned out to be more reliable: they work inside subagents and after compaction, and rules created or edited mid-session are pushed to the assistant. So the hooks now only do what the native mechanism can't — track which requirement is being edited and start the recorder. They add nothing to the assistant's context.

| Part | What it does |
|---|---|
| `src/parser.js` | Parses the tree; every edit goes through `applyOps`, and each operation returns its inverse; similarity-based dedupe |
| `src/compile.js` | Compiles each requirement into a native rule file; inheritance via nested scopes, overrides written as "within this scope, this one wins" |
| `src/store.js` | Locked atomic writes, recompiles after every write, change log and undo, state files |
| `hooks/hook.js` | Keeps rules fresh when you send a message, records which requirement an edited file belongs to, starts the recorder at the end of a turn, and logs which rules were loaded |
| `hooks/recorder.js` | Uses Haiku to decide whether the turn contained a long-term requirement, then rewrites or adds a rule |
| `extension.js`, `media/` | VS Code sidebar and mind map |

## Saving context and tokens

| Feature | Status |
|---|---|
| Rules load on demand, only when matching files are touched | ✅ |
| Hooks add nothing to the conversation | ✅ |
| Old rules are rewritten instead of duplicated, so the tree doesn't keep growing | ✅ |
| The recorder uses the inexpensive Haiku model in the background; short replies skip it | ✅ |
| Context meter: which rules each session loaded and how many characters each | In progress |
| Split CLAUDE.md: move requirement-specific content into the tree so it loads on demand | Planned |
| Cross-file duplicate and contradiction check between the tree, CLAUDE.md and project docs | Planned (experiment script exists) |

![Characters always in context](docs/images/en/chart-context.png)

## Test data

Every number comes from [`测试数据记录.md`](测试数据记录.md) (the test log, in Chinese), including the experiments that did not show an advantage.

**Does the recorder judge correctly?** Six kinds of situations, three runs each, with the real Haiku model: a reworded duplicate is not added, a change of mind rewrites the original rule, a genuinely new rule is added, a one-off instruction is ignored, a rejected rule is deleted, and a child repeating its parent is not added. 18 out of 18 correct.

![Recorder accuracy](docs/images/en/chart-recorder.png)

**With or without ReqTree — do rules get messier?** A simulated 32-turn conversation in which the user gradually states 13 long-term requirements, changes their mind, cancels some and adds exceptions. Three arms: the assistant maintaining its own rule document (plain prompt, careful prompt) and the ReqTree recorder. ReqTree left no redundant entries and attached no rule to the wrong scope; all three arms missed some requirements. The model saw the whole document every turn, which is easier than real life, and the sample is small, so the difference is not significant.

![Rule problems after a simulated conversation](docs/images/en/chart-confusion.png)

**How messy is a real project?** In a real course project's 21 rule documents, most problems sit **across files**: the same rule copied in several places, updated in one and stale in the others. That is exactly what "one rule, one place" is meant to fix. Proving that ReqTree reduces it needs a second experiment that simulates many files and many sessions.

![Audit of real rule documents](docs/images/en/chart-audit.png)

## Limitations

- Claude Code only for now (it relies on Claude Code hooks and path-scoped rules). Codex support is in progress.
- The recorder sometimes misses things, especially decisions about a single chapter's content ("open Chapter 1 with this story"). You can add those by hand in the panel.
- Each turn costs one extra Haiku call, in the background (about 6 seconds; you never wait for it).
- The extension UI is in Chinese for now.
- Developed and tested mainly on Windows; macOS and Linux run the test suite in CI but haven't been used by a person yet.

## Command line

```bash
node bin/reqtree.js init    <project>          # enable: install hooks, compile rules
node bin/reqtree.js tree    需求树.md           # print the whole tree
node bin/reqtree.js rules   需求树.md C2.1      # the rules in effect for one requirement
node bin/reqtree.js compile 需求树.md           # compile by hand (normally automatic)
node bin/reqtree.js check   需求树.md           # duplicate IDs, requirements without files, stale 🔨
```

**Note:** don't force-reinstall the extension from the command line (`code --install-extension --force`) while Claude Code is running in VS Code. It restarts the extension host, and Claude Code restarts with it.

## Development

```bash
node --test test/*.test.js        # all automated tests (UI tests need Edge or Chrome)
node test/eval-recorder.js 3      # evaluate the recorder with the real Haiku model (costs a little)
node test/eval-confusion.js 2     # the with/without comparison (about 200 model calls)
```

## License

MIT
