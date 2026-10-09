# 👁️ reslop

## Review AI generated code and plan changes

[![ci status](https://github.com/tshemsedinov/reslop/workflows/Testing%20CI/badge.svg)](https://github.com/tshemsedinov/reslop/actions?query=workflow%3A%22Testing+CI%22+branch%3Amain)
[![snyk](https://snyk.io/test/github/tshemsedinov/reslop/badge.svg)](https://snyk.io/test/github/tshemsedinov/reslop)
[![npm version](https://badge.fury.io/js/reslop.svg)](https://badge.fury.io/js/reslop)
[![npm downloads/month](https://img.shields.io/npm/dm/reslop.svg)](https://www.npmjs.com/package/reslop)
[![npm downloads](https://img.shields.io/npm/dt/reslop.svg)](https://www.npmjs.com/package/reslop)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/tshemsedinov/reslop/blob/main/LICENSE)

> Turn generated changes into owned changes

Open a change, leave findings and a backlog, and prepare a repair plan for the agent.

```text
Review → Plan → Repair → Verify
```

- Live dashboard: files, diffs, tasks, branches, commits, run, and npm, updated in real time
- Leave feedback, a project backlog, and in-place code proposals as a repair plan
- Review uncommitted git diffs, a given commit, a GitHub PR, or a GitLab MR
- File-scope review mode: not just diffs, with editor mode
- Stage, unstage, or revert each contiguous block of diff lines
- Auto-reload local diffs when files change, keeping the current screen
- Import GitHub PR and GitLab MR review comments into the local plan for AI
- Commits list: brief and full, view a commit's diff, commit, amend, apply, edit, fixup, and delete
- Branches: checkout, create, rebase, delete, pull, and push
- npm scripts and bins: run, edit, and reorder; double-click to run; clean logs older than 5 days
- Reduced test and lint output for agents: failures and a short summary, not passing noise
- Review, renew, audit and update npm dependencies in `package.json` and the lockfile
- Auto-update reslop patch and minor releases; confirm a new major
- Work with git, npm and fetch in background
- Execute review results and plan in cli agents, detect local agent, choose effort, and model

## Install

```bash
npm i -g reslop
```

Works on Linux, macOS, and Windows. On Windows use Windows Terminal.
Requires Node.js `>=18.15.0`.

## Usage

- `reslop` live dashboard of this repository; press a block key to open its screen
- `reslop path/file` show only that path or file (starts on the file list)
- `reslop 7ac260c` show that commit (read-only)
- `reslop https://github.com/metarhia/metacom/pull/555` GitHub/GitLab PR/MR
- `reslop https://github.com/metarhia/metacom/issues/550` import GitHub/GitLab issue
- `reslop https://github.com/metarhia/metacom/issues` import all issues
- `reslop -n` start a new review even if the latest is still editing
- `reslop -r` read-only mode
- `reslop -light` light color theme (default dark)
- `reslop t -- <program> [args]` run one program and print a reduced report

Prefix each program in an npm script with `reslop t --`. Keep `&&` between those wraps, so each program is captured on its own and a failing step does not start the next one:

```json
"lint": "reslop t -- eslint . && reslop t -- prettier -c \"**/*.js\"",
"test": "reslop t -- npm run -s lint && reslop t -- node --test"
```

The report is Markdown: failures, diagnostics, and a short summary. Passing results are omitted and similar problems are grouped. The reduced report is saved as `.log/<name>.log` and the raw output as `.log/<name>.raw`. The report names the raw file for an agent to read when a detail is missing. Set `RESLOP_OUTPUT=raw` to pass the command through unchanged. The review screen runs scripts in raw mode and applies its own filter once.

Run the full check with `npm t`. Run one or more test files with `reslop t -- node --test <files>`. New reviews include those two commands in the agent instructions.

`reslop t` records each run as `.log/<name>.json` beside those files so that the dashboard can show commands started by an agent in another terminal.

Reviews go in `.plan/YYYY-MM-DD-NN.md` with frontmatter `status`:

- `editing`: still writing the review in reslop
- `ready`: ready for AI to work through the checkboxes
- `partial`: AI started; some items remain
- `done`: all items marked `[x]`

## Future

- Search, blame, and file history in the review
- Security and code-quality audit; propose a repair plan
- Send anonymized code blocks for expert review
- Send questions and the repair plan to experts for approval
- Ask experts
- Apply refactoring skills
- Call agents, harnesses, and IDEs to execute prepared plans
- Squash, cherry-pick, and interactive rebase
- Merge, rename, and conflict resolution

## License

Copyright (c) 2026 Timur Shemsedinov and other contributors (see github).
This is [MIT](./LICENSE) licensed software.
