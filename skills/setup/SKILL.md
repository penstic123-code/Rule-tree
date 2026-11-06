---
name: setup
description: Set up RuleTree in this project - read the project, propose a requirement tree, and after the user approves it, write it as rule files. Use when the pane says the project is not set up, or the user types /ruletree:setup.
disable-model-invocation: true
---

# Set up RuleTree

Build the project's first requirement tree. Requirements are the project's real areas of work, and each one owns files.

1. If `.claude/rules/ruletree/` already holds rule files, stop and say so. Never overwrite them.
2. Read the project's shape with `ls`, a file listing, and the README and top-level docs. Do not read every file. This works for a flat app, a monorepo (one requirement per package or app) and a folder of documents (group by topic or folder).
3. Decide the language first: if the project's docs are Chinese, titles and rules are Chinese and `"lang": "zh"`; otherwise English and `"en"`. Then propose the tree as a short indented list: `R1 Title - paths`, children as `R1.1`. Split big areas into sub-requirements as deep as the content needs; do not stop at one level. Every path must match real files. A child's paths stay inside its parent's.
4. `rules` holds only what the project already states (README, CONTRIBUTING, config, comments saying "always/never"). When the project states nothing, leave `rules` out. Never invent rules, and set `status` only when the docs show it.
5. Show the list and ask the user to approve or change it. **Wait for the answer. Do not run `setup` before approval.**
6. Save the approved proposal with the Write tool to a temp file, then run (any shell; use the Bash tool if you have it):

```
node "${CLAUDE_PLUGIN_ROOT}/bin/ruletree.js" setup --json --proposal <temp-file>
```

The file holds `{"lang":"en","requirements":[{"id":"R1","title":"...","status":"doing","paths":["src/**"],"rules":["..."]},{"id":"R1.1","title":"...","paths":["src/api/**"]}]}`.

Run it from the project root. If the output has `"ok":false`, fix the `problems` it names, show the user what changed, and run again. When `"ok":true`, tell the user the map is ready and a new session loads the rules. If `warnings` is not empty (for example the rules folder is ignored by git or not added to git yet, so other worktrees, branches and teammates will not see the rules), pass each warning on to the user in their language. Do not edit `.gitignore` or commit for them.

If the output is not valid JSON, or setup fails after validation passed (`"ok":false` with a problem that is not about the proposal itself, such as an unreadable settings file), stop, report the exact message to the user, and do not retry blindly. A failed setup removes the rule files it wrote, so it can be run again once the cause is fixed.
