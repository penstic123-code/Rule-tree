# Design: RuleTree as a Claude app plugin

Status: draft for review, 2026-11-06. Requirement: R6.

## Goal

Anyone using the Code tab of the Claude desktop app can install RuleTree and, while the AI builds their project, see the whole project on one screen: what parts exist, how far along each is, and where the AI is working now.

The map is the product. Rules are what feed it. When the map and anything else compete, the map wins.

**Done means:** a person who has never seen RuleTree installs it from the plugin menu, enables it in a project of any shape, and has a useful map within a few minutes, with no VS Code and no hand-written config.

## Not in this version

- The Chat tab: it does not load path-based rules.
- Removing the Node.js requirement. The first version needs Node 18+ and says so plainly.
- New VS Code features. The extension stays on the shared core and gets fixes only.
- Claims that RuleTree beats `CLAUDE.md`. Section 19 of `dev/test-log.md` does not support that at 23 rules, and the scale test has not been run. The pitch is the map.

## What the throwaway test showed

| Question | Result | How it was checked |
|---|---|---|
| Can a plugin run the existing Node core? | Yes: 10 requirements read on Node 22 | Real headless session with the mod loaded |
| Does Chinese survive on Windows? | Yes | Same run |
| Does the desktop surface accept the pane? | Yes, including SVG and buttons | `claude plugin test`, desktop surface |
| Does an edit light up the owning requirement? | Yes, against a mocked engine | Same test |
| Does the map look right? | Yes at 10 nodes, no at scale | SVG rendered in a browser, not in the pane |
| Does it draw in a real desktop pane? | **Not confirmed** | The session's mods were recorded as declined, so the mod never loaded in the app |

Three things the test taught us:

- **A tall tree is not a big picture.** Ten requirements already overflow the screen, and 65 would be about 3,600px tall. See "The map".
- **Drawing must be pure.** A `ui.render` hook may not write state; the engine skips it. All writes happen in event hooks.
- **SVG cards cannot be clicked.** `Svg` is an image or a script-less frame, so it cannot raise a press.

## Architecture

```
Claude app (Code tab)
  plugin module (TypeScript, no Node APIs)
    events -> state -> pane drawing
        |  $.process.run(node ruletree.js snapshot --json)
        v
  existing Node core: src/ + bin/ruletree.js   <- also used by the VS Code extension
        |
        v
  project files: .claude/rules/ruletree/*.md  and  .ruletree/
```

The repository root becomes the plugin, so `src/`, `bin/` and `hooks/` ship as they are and `$.plugin.root` finds them. `.claude-plugin/marketplace.json` makes the GitHub repo installable.

| Unit | Job | Depends on |
|---|---|---|
| `bin/ruletree.js snapshot --json` (new) | One call that returns the tree, statuses, rule counts, recent activity and undoable changes. Wraps `src/viewmodel.js`. | Core only |
| `bin/ruletree.js edit --json` (new) | Applies a panel edit or undo through the same store path the extension uses | Core only |
| Plugin module (new) | Listens to events, keeps state, draws the pane, registers commands | The two commands above |
| `src/layout.js` (new) | Pure function from tree to overview blocks, so it can be unit tested without the app | Nothing |
| `src/guide.js`, `src/checkup.js` | Gain English text | Unchanged otherwise |

Both hosts apply changes through the same store functions, so they behave the same. The extension keeps its own prompts, and only its tree loading moves into the core.

The checkup runs in a separate Node process, so it cannot call the plugin's model API directly. It works in two phases: Node prepares the prompts, the plugin calls the model, and Node applies the answers.

## The map

An overview that fits one screen, not a tree that scrolls:

- Each top-level requirement is a **block**, sized by its share of the project.
- Each child is a **tile** inside its block, coloured by status.
- The tile the AI is working in is highlighted, and the last few it touched fade out.
- A header line gives the project total: done, in progress, to do.
- Pressing a tile opens that requirement's detail below the map: rules, decisions, files, recent changes, undo.
- Deeper levels stay collapsed until you press into a block.

Blocks and tiles are built from `Box` and `Button`, not SVG. That makes them clickable and lets them follow the app's theme, and it removes the need for separate buttons. If `Button` styling proves too limited in the real pane, the fallback is an SVG overview with a compact button row, which the test already passed.

A map is only useful if it stays true, so a new project gets a map proposed by the AI (see below), and requirements with no matching files are marked.

## Data flow

1. **Session start:** run `snapshot`, store it, register `/ruletree`, and open the pane if the surface docks it beside the chat.
2. **AI edits a file:** a `tool.call` hook calls `next(e)` first, then finds the owner without waiting on it, so the AI is never slowed. The test version did this before the edit; the real one must not.
3. **Rule files change:** the same hook refreshes when the edited file is under the rules folder. A slow timer (`$.clock`) catches edits made outside the session.
4. **You press something:** the handler runs `edit --json`, then refreshes.
5. **Drawing:** reads state only.

The plugin also carries the existing hooks, which do nothing in a project without rules. That removes the `~/.ruletree/runtime` copy and the per-project hook setup for plugin users. Teammates without the plugin still get the rules, because the rule files are plain Claude Code features.

## Working in most projects

| Today | Plugin version |
|---|---|
| Guide is Chinese only | English and Chinese, chosen by the project's existing rules, else the app language |
| Labels assume Chinese (`文档：`, `决定：`) | The parser accepts both; new files follow the guide's language |
| First tree comes from top-level folders | The session's AI reads the project and proposes a tree, and you approve it. Handles a flat `src/`, a monorepo, or a folder of documents |
| File matching is tuned for chapters and lessons | Kept as a helper, no longer the main route |
| Checkup shells out to `claude -p` | Uses `$.model.complete`, so it works when `claude` is not on the PATH |

`/ruletree` in an unset project offers to enable it, so there is one thing to remember.

## When things go wrong

| Situation | Behaviour |
|---|---|
| Node missing or too old | The pane says so with a download link. Nothing else breaks |
| Project not enabled | The pane offers Enable |
| Snapshot fails or a rule file is malformed | Keep showing the last good map with a warning, and name the file |
| Very large tree | Collapse to blocks and summarise the rest, staying under the 100,000-character tree limit |
| Terminal surface | A text tree, since it has no SVG and fewer styles |

## Testing

- **Unit:** `snapshot`, `edit` and `src/layout.js`, including a 200-requirement tree that must fit the screen.
- **Plugin:** `claude plugin test` on desktop and terminal surfaces, with drawing kept pure.
- **Real app, required before release:** install from the marketplace on a clean profile, enable a project that has never used RuleTree, watch a live edit light a tile.
- **Project shapes:** a flat app, a monorepo, a documents-only folder, an English project and a Chinese one.
- **Existing:** the current test suite stays green, as the VS Code extension shares the core.

## Build order

Each step ends with something working.

1. `snapshot --json`, and confirm a pane draws in the real app.
2. Overview map with live highlight. **Stop and judge it on a real project: this is the product.**
3. Detail view, edits and undo.
4. Plugin packaging, hooks and marketplace file.
5. English guide, AI-proposed first tree, checkup through `$.model.complete`.
6. README, then a fresh-install test.

## Open questions

- Does the desktop pane draw `Box` and `Button` tiles well enough? Step 1 answers this.
- Could the map tell people what the AI changed since they last looked? Likely valuable for the big picture, but it stays out of this version unless you want it in.
- Should the scale test run before public release? It decides what the README may claim about tokens, not whether the map works.
