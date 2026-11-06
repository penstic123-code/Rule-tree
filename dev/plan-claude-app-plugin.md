# RuleTree Claude App Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship RuleTree as a plugin for the Code tab of the Claude desktop app, built around a one-screen live map of the project.

**Architecture:** The repository root becomes a Claude Code plugin. A TypeScript plugin module handles events and draws the pane, and calls the existing Node core through two JSON commands. The VS Code extension keeps using the same core.

**Tech Stack:** Node 18+ CommonJS with `node:test` for the core; the Claude Code plugin API (TSX module, `claude plugin validate`, `claude plugin test`).

**Spec:** `dev/design-claude-app-plugin.md`

## Global Constraints

- Node 18+ is required and stated plainly. No new npm dependencies.
- The map wins whenever it competes with anything else (R6).
- `ui.render` hooks read state only. All writes happen in event hooks.
- Rule file format stays compatible: teammates without the plugin still get their rules.
- All rule changes go through `store.commitAsync` or `store.undoChangeAsync`, so they stay undoable.
- The VS Code extension keeps working. It gets no new features.
- Design and dev documents go in `dev/`, per `_root.md`.
- The README makes no claim that RuleTree beats `CLAUDE.md`.
- Core tests: `node --test --test-timeout=600000 test/*.test.js`. Plugin tests: `claude plugin validate .` and `claude plugin test .`

## Review Focus

1. A project enabled by the old VS Code install, with the plugin also installed: each edit must be recorded once, not twice. Test in Task 6.
2. A session opened in a subfolder or a git worktree: the map shows the enclosing project. Test in Task 1.
3. An edit to a file outside the project, or a path with spaces or Chinese: no crash, and the highlight does not move. Test in Task 1.
4. A rule file that is half-written or malformed when the map refreshes: keep the last good map and name the file. Test in Task 4.
5. Undo after the AI has changed the same file: a partial undo is reported, not shown as success. Test in Task 5.

## Before Task 1

The working tree holds uncommitted work from the `dev/` move. It must be committed by its owner or with their approval before Task 1. Then create branch `claude-app-plugin` from it.

## File Structure

| File | Responsibility |
|---|---|
| `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` | Plugin identity and install source |
| `hooks/hooks.json` | Loads the module and the existing `hooks/hook.js` |
| `hooks/register.tsx` | Events, state, commands |
| `hooks/pane.tsx` | Pure drawing of the map and detail view |
| `types/index.d.ts` | Plugin state contract |
| `skills/setup/SKILL.md` | The AI-proposed first tree |
| `src/snapshot.js` | Everything the pane needs, in one object |
| `src/layout.js` | Pure tree-to-overview function |
| `src/lang.js` | Chooses a project's language |
| `src/propose.js` | Validates and applies a proposed tree |
| `src/checkup.js`, `src/guide.js`, `bin/ruletree.js`, `hooks/hook.js`, `extension.js` | Modified as described in the tasks |

---

### Task 1: Snapshot command

**Files:**
- Create: `src/snapshot.js`, `test/snapshot.test.js`
- Modify: `bin/ruletree.js`, `extension.js:100-113`

**Interfaces:**
- Produces: `loadTree(dir, now?) -> tree` (the object `extension.js` builds today, minus `uri`, which the extension adds); `snapshot(cwd, { file?, now? }) -> Snapshot`.
- `Snapshot = { enabled: boolean, dir: string|null, name: string, nodes: ViewNode[], changes: [], unmapped: [], problems: [], working: string|null, overview: Overview|null }`. `ViewNode` is what `viewData` returns.
- CLI: `ruletree snapshot [dir] [--file <path>] --json` prints one JSON object and exits 0, including when not enabled.

- [ ] **Step 1: Write the failing tests** in `test/snapshot.test.js`

```js
test('reports a project with no rules as not enabled', () => {
  assert.deepStrictEqual(pick(snapshot(emptyDir), ['enabled', 'nodes']), { enabled: false, nodes: [] });
});
test('finds the enclosing project from a subfolder', () => {
  assert.strictEqual(snapshot(path.join(project, 'src', 'deep')).dir, project);
});
test('working is the requirement that owns the edited file', () => {
  assert.strictEqual(snapshot(project, { file: path.join(project, 'src', 'a.js') }).working, 'R1');
});
test('a file outside the project leaves working null', () => {
  assert.strictEqual(snapshot(project, { file: path.join(os.tmpdir(), 'x.js') }).working, null);
});
test('handles spaces and Chinese in the path through the CLI', () => {
  const out = JSON.parse(execFileSync('node', [BIN, 'snapshot', '项目 甲', '--json'], { encoding: 'utf8' }));
  assert.strictEqual(out.enabled, true);
});
```

- [ ] **Step 2: Run them.** Run `node --test test/snapshot.test.js`. Expected: FAIL, cannot find `../src/snapshot`.
- [ ] **Step 3: Implement `src/snapshot.js`.** Move the object built at `extension.js:100-113` into `loadTree`, and have the extension call it and add `uri`. Use `findProjectUp` for the project, `projectRel` and `T.nodeForFile` for `working`, `viewData` for the nodes. Leave `overview: null` until Task 3. Add the `snapshot` branch to `main` in `bin/ruletree.js`.
- [ ] **Step 4: Run all core tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: add snapshot command for the plugin pane`

---

### Task 2: Plugin skeleton, proven in the real app

**Files:**
- Create: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `hooks/hooks.json`, `hooks/register.tsx`, `hooks/pane.tsx`, `types/index.d.ts`, `hooks/pane.test.tsx`

**Interfaces:**
- Consumes: `ruletree snapshot --json`, called as `$.process.run(['node', `${$.plugin.root}/bin/ruletree.js`, 'snapshot', cwd, '--json'])`.
- Produces: state atoms `snapshot`, `selected`, `error` under plugin name `ruletree`; pane id `ruletree-map`; command `ruletree`; `refresh($, file?)`, a top-level function in `register.tsx`.
- `hooks.json` at this stage: `{ "modules": ["./register.tsx"] }`.

The throwaway mod at `~/.claude/dev-mods/.../ruletree-spike` shows the working patterns. `refresh` must be a top-level function, because the validator rejects passing `$` to a local one.

- [ ] **Step 1: Write the failing test** `the pane draws requirement titles on desktop`, with `process.run` mocked to return a two-node snapshot, asserting `ui.find({ type: 'Text', text: /规则记录/ })` is found.
- [ ] **Step 2: Run** `claude plugin test .` Expected: FAIL.
- [ ] **Step 3: Implement** the manifests, `refresh`, and a plain list of requirement titles in `pane.tsx`. Open the pane on `session.start` only when the surface docks it.
- [ ] **Step 4: Run** `claude plugin validate .` and `claude plugin test .` Expected: PASS.
- [ ] **Step 5: Confirm in the real app.** With the user's permission, run `claude plugin marketplace add <repo folder>` and `claude plugin install ruletree --marketplace <name>`, then start a new Code tab session. Expected: the pane shows this project's requirements. **If it does not draw, stop and report: the design rests on this.**
- [ ] **Step 6: Try a styled tile.** Add one `Button` tile with a coloured `Box` to the pane and look at it in the app. Record in `dev/test-log.md` whether tiles look good enough, as Task 4 depends on it.
- [ ] **Step 7: Commit** `feat: add plugin skeleton and pane`

---

### Task 3: Overview layout

**Files:**
- Create: `src/layout.js`, `test/layout.test.js`
- Modify: `src/snapshot.js`

**Interfaces:**
- Produces: `overview(nodes, { working, now }) -> Overview`
- `Overview = { totals: { done, doing, todo, none }, blocks: Block[] }`
- `Block = { id, title, status, span: 1|2|3, tiles: Tile[], hidden: number }`
- `Tile = { id, title, status, state: 'working'|'recent'|null, hasChildren: boolean }`
- Constants: `MAX_TILES = 12`, `RECENT_MS = 600000`.

Blocks are the top-level requirements under the root. Tiles are each block's direct children. A block with no children gets one tile for itself. `span` comes from the block's share of all requirements: under 15% is 1, under 35% is 2, otherwise 3. Totals count every requirement except the root.

- [ ] **Step 1: Write the failing tests**

```js
test('fits a 200-requirement tree', () => {
  const o = overview(makeTree(8, 24), {});
  assert.ok(o.blocks.every(b => b.tiles.length <= 12));
  assert.strictEqual(o.blocks.reduce((n, b) => n + b.tiles.length + b.hidden, 0), 192);
});
test('a working requirement deep in the tree lights its visible ancestor tile', () => {
  assert.strictEqual(tile(overview(tree, { working: 'R1.2.3' }), 'R1.2').state, 'working');
});
test('a working tile past the cap is kept visible', () => {
  const o = overview(makeTree(1, 30), { working: 'R1.30' });
  assert.strictEqual(tile(o, 'R1.30').state, 'working');
});
test('a flat project still gets a useful map', () => {
  assert.strictEqual(overview(flatTree(3), {}).blocks[0].tiles.length, 1);
});
test('counts statuses without the root', () => {
  assert.deepStrictEqual(overview(tree, {}).totals, { done: 1, doing: 2, todo: 1, none: 0 });
});
```

- [ ] **Step 2: Run** `node --test test/layout.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `overview`, and set `Snapshot.overview` in `snapshot`.
- [ ] **Step 4: Run all core tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: add one-screen overview layout`

---

### Task 4: The live map

**Files:**
- Modify: `hooks/register.tsx`, `hooks/pane.tsx`, `hooks/pane.test.tsx`, `types/index.d.ts`

**Interfaces:**
- Consumes: `Snapshot.overview`, `refresh($, file?)`.
- Produces: `drawMap($, e)`, `drawDetail($, e)` in `pane.tsx`; atom `lastError: string`.

Header line, then blocks and tiles as `Box` and `Button` with `flexWrap`, status colours, and a clear working style. Pressing a tile sets `selected`. Pressing a block's tile with children shows that level. Terminal draws an indented text tree. If Task 2 found tiles too limited, use the spec's fallback: an SVG overview plus a button row.

- [ ] **Step 1: Write the failing tests**
  - `an edit lights the owning tile`: after `$.tool.call` on Edit, the working tile carries its working label.
  - `a failed refresh keeps the last good map and shows the reason`: a second `process.run` exits 1 with `R2-x.md`; the first titles still draw, and a Text matches `/R2-x\.md/`.
  - `missing Node says so`: `process.run` rejects; a Text matches `/Node\.js/`.
  - `not enabled offers setup`: `enabled: false`; a Text matches `/\/ruletree:setup/`.
  - `the terminal draws a text tree`: mount on `terminal`, no Svg is required, titles are found.
- [ ] **Step 2: Run** `claude plugin test .` Expected: FAIL.
- [ ] **Step 3: Implement.** In `tool.call`, call `next(e)` first, then start `refresh($, file)` for Edit and Write with `void ... .catch(...)`, so the AI never waits. Add a `$.clock.every` refresh every 30 seconds, which also picks up subagent edits recorded in `activity.jsonl`. A failed snapshot only sets `lastError`.
- [ ] **Step 4: Run** `claude plugin validate .` and `claude plugin test .` Expected: PASS, with no "gating hook without .catch" warning.
- [ ] **Step 5: Reinstall and watch it in the app** while the AI edits a real project. Expected: the working tile changes within a second or two of an edit.
- [ ] **Step 6: Commit** `feat: draw the live project map`
- [ ] **Step 7: Stop for the user's judgement.** This is the product. Ask them to look at it on a real project. Later tasks wait for their yes.

---

### Task 5: Detail view, edits and undo

**Files:**
- Modify: `bin/ruletree.js`, `hooks/pane.tsx`, `hooks/register.tsx`, `hooks/pane.test.tsx`
- Create: `test/edit-cli.test.js`

**Interfaces:**
- Produces: `ruletree edit [dir] --json`, reading stdin as `{ ops: Op[] }` or `{ undo: id }`, printing `{ ok: boolean, result: 'done'|'nochange'|'partial'|'failed', message?: string }`. Allowed ops: `set_status`, `add_rule`, `replace_rule`, `remove_rule`. Anything else exits 1.

The extension keeps its own prompts. What the two hosts share is the store path, so no further code moves out of `extension.js`.

- [ ] **Step 1: Write the failing tests**

```js
test('applies an op and records it as undoable', async () => { /* add_rule, then changeSummaries(dir, 1) has one entry */ });
test('rejects an op outside the list', async () => { /* delete_node exits 1, the tree is unchanged */ });
test('reports a partial undo', async () => {
  // add a rule, change the same line by hand, undo
  assert.strictEqual(out.result, 'partial');
});
```

Plus a pane test: `deleting a decision rule asks first`. A rule starting `决定：` or `Decision:` needs a second press before `edit` runs.

- [ ] **Step 2: Run** the new tests. Expected: FAIL.
- [ ] **Step 3: Implement** the command and the detail view: rules with decisions marked, files, recent changes, status `Select`, rule `Input`, undo buttons. Show `message` when the result is not `done`.
- [ ] **Step 4: Run** all core and plugin tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat: edit rules and undo from the pane`

---

### Task 6: Hooks in the plugin

**Files:**
- Modify: `hooks/hooks.json`, `hooks/hook.js`, `bin/ruletree.js`, `src/common.js`, `test/system.test.js`

**Interfaces:**
- Produces: `hasProjectHook(dir) -> boolean` in `src/common.js`; `init(dir, { plugin: true })`.

`hooks.json` also declares the two existing hooks; the validator accepts both forms together:

```json
{ "modules": ["./register.tsx"], "hooks": {
  "PostToolUse": [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit", "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/hook.js\"", "async": true }] }],
  "InstructionsLoaded": [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/hook.js\"", "async": true }] }] } }
```

- [ ] **Step 1: Write the failing tests**
  - `the plugin hook stands down when the project has its own hook`: run `hook.js` with `CLAUDE_PLUGIN_ROOT` set in a project whose settings hold the old hook; `activity.jsonl` gets no entry from that run.
  - `the hook does nothing in a project without rules`: no `.ruletree/` is created.
  - `init with plugin skips the runtime copy and project hooks`: `~/.ruletree/runtime` is untouched, `settings.local.json` holds the allow rule and no `hooks` key.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** `hasProjectHook` must live in `src/`, as `hooks/hook.js` cannot reach `bin/`. Update the R1.1 notes that say hooks always run from `~/.ruletree/runtime`.
- [ ] **Step 4: Run** all tests and `claude plugin validate .` Expected: PASS.
- [ ] **Step 5: Commit** `feat: run hooks from the plugin`

---

### Task 7: English and Chinese

**Files:**
- Create: `src/lang.js`
- Modify: `src/guide.js`, `src/checkup.js`, `src/store.js`, `test/store.test.js`, `test/checkup.test.js`

**Interfaces:**
- Produces: `detectLang(dir, fallback = 'en') -> 'zh'|'en'`; `guideText(lang)`; `ensureGuide(dir, { lang })`. `guide.VERSION` becomes `3`, so an older extension leaves a new guide alone.

Order for `detectLang`: the existing guide's language, then the language most of the existing rules use, then `fallback`. `MARK` keeps the `ruletree:guide N` form that `ensureGuide` reads.

- [ ] **Step 1: Write the failing tests**
  - `an existing Chinese project stays Chinese`: rules in Chinese, fallback `en`, guide stays Chinese.
  - `a new English project gets an English guide`: the guide has no CJK characters and uses `Decision:`, `Docs:`, `Parent:`.
  - `a guide in one language is not rewritten into the other`.
  - `the checkup report follows the project language`: an English project's report has no CJK characters.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Write the English guide using the en-teaching-prose skill. Same rules as the Chinese guide, nothing added.
- [ ] **Step 4: Run** all core tests. Expected: PASS. Update tests that pin `VERSION` to 2.
- [ ] **Step 5: Commit** `feat: support English projects`

---

### Task 8: AI-proposed first tree

**Files:**
- Create: `skills/setup/SKILL.md`, `src/propose.js`, `test/propose.test.js`, `test/fixtures/proposals/*.json`
- Modify: `bin/ruletree.js`

**Interfaces:**
- Consumes: `init(dir, { plugin: true })`, `detectLang`.
- Produces: `validate(dir, proposal) -> { ok, problems: string[] }`; `apply(dir, proposal)`; `ruletree setup [dir] --json` reading the proposal on stdin.
- `Proposal = { requirements: [{ id, title, status?, paths: string[], rules?: string[], parent?: string }] }`

The skill tells the AI to read the project structure, propose a tree with sub-requirements at whatever depth the content needs (R1.3), show it as a short list, and wait for approval before running `setup`. It must not invent rules: `rules` holds only what the project already states.

- [ ] **Step 1: Write the failing tests**
  - `rejects a path that matches no file`.
  - `rejects a child whose paths fall outside its parent`.
  - `rejects a one-level tree in a project with more than one area` (R1.3).
  - `applies a valid proposal and the map shows it`: `snapshot(dir).overview.blocks.length` equals the top-level count.
  - `refuses to overwrite a project that already has rules`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** `src/propose.js`, the command and the skill.
- [ ] **Step 4: Run** all tests. Expected: PASS.
- [ ] **Step 5: Try the skill for real** on four copies, and record results in `dev/test-log.md`: a flat app, a monorepo, a documents-only folder, an English project. Expected: each gives a map with more than one block and no invented rules.
- [ ] **Step 6: Commit** `feat: let the AI propose the first tree`

---

### Task 9: Checkup without the claude command

**Files:**
- Modify: `src/checkup.js`, `src/model.js`, `bin/ruletree.js`, `hooks/register.tsx`, `hooks/pane.tsx`, `test/checkup.test.js`

**Interfaces:**
- Produces: `planJobs(dir, { full }) -> Job[]`, extracted from `runCheckup`; `parseAnswer(text) -> object`, extracted from `askJson`.
- CLI: `ruletree checkup [dir] --jobs --json` prints `[{ prompt, rules }]` and changes nothing. `ruletree checkup [dir] --answers --json` reads `[{ prompt, text }]` on stdin, runs `runCheckup` with an `ask` that looks up each prompt, and prints the result.

The checkup runs in a separate Node process, so it cannot call `$.model.complete` itself. The plugin gets prompts, calls the model, and hands back the answers. A prompt with no answer throws, so that block is reported failed and retried next time, which is existing behaviour. If rule files change between the two calls, the prompts stop matching and the same path applies.

- [ ] **Step 1: Write the failing tests**
  - `jobs changes nothing on disk`.
  - `answers applies fixes and they can be undone`.
  - `a missing answer fails only that block`.
  - Plugin: `the checkup runs at most 3 model calls at once` and `a timed-out block is retried once`, per R1.2.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Use `$.model.complete({ model: 'haiku', prompt })`. `ruletree checkup` from the shell keeps working through `claude -p`. Keep the report rules in R1.2: no scores, no raw numbers.
- [ ] **Step 4: Run** all tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat: run the checkup through the session's model`

---

### Task 10: Release

**Files:**
- Modify: `README.md`, `README.en.md`, `package.json`, `.claude-plugin/plugin.json`, `dev/architecture.md`, `dev/test-log.md`, `.claude/rules/ruletree/R6-Claude-应用插件.md`

- [ ] **Step 1: Ask the user about R5.** R5 has a `决定：` that the README subtitle stresses information architecture, while R6 now makes the map the headline. Decisions are the user's, so ask before changing that line.
- [ ] **Step 2: Write the README** install section and a screenshot of the real map, following R5, using zh-teaching-prose and en-teaching-prose. State the Node 18+ requirement, and that the Chat tab is not supported.
- [ ] **Step 3: Bump** both versions to `0.22.0`.
- [ ] **Step 4: Fresh-install test** on a clean profile: add the marketplace from the GitHub repo, install, run `/ruletree:setup` in a project that has never used RuleTree, and watch a live edit light a tile. Expected: a useful map within a few minutes, with no VS Code and no hand-written config.
- [ ] **Step 5: Run everything:** core tests, `claude plugin validate .`, `claude plugin test .`, and `node test/vscode/run.js`. Expected: all pass.
- [ ] **Step 6: Record** the results in `dev/test-log.md`, including context used (R4), update `dev/architecture.md`, and set R6 to ✅.
- [ ] **Step 7: Commit** `release: 0.22.0 Claude app plugin`. Pushing and publishing need the user's approval.
