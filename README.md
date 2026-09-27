# 👁️ reslop

## Review AI generated code and plan changes

[![ci status](https://github.com/tshemsedinov/reslop/workflows/Testing%20CI/badge.svg)](https://github.com/tshemsedinov/reslop/actions?query=workflow%3A%22Testing+CI%22+branch%3Amain)
[![snyk](https://snyk.io/test/github/tshemsedinov/reslop/badge.svg)](https://snyk.io/test/github/tshemsedinov/reslop)
[![npm version](https://badge.fury.io/js/reslop.svg)](https://badge.fury.io/js/reslop)
[![npm downloads/month](https://img.shields.io/npm/dm/reslop.svg)](https://www.npmjs.com/package/reslop)
[![npm downloads](https://img.shields.io/npm/dt/reslop.svg)](https://www.npmjs.com/package/reslop)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/tshemsedinov/reslop/blob/main/LICENSE)

> Turn generated changes into owned changes

Open a change, leave findings and todos, and prepare a repair plan
for the agent.

```text
Review → Plan → Repair → Verify
```

- Leave feedback, issues/todos, and in-place code proposals as a repair plan
- Review uncommitted git diffs, a given commit, a GitHub PR, or a GitLab MR
- File-scope review mode: not just diffs, with editor mode
- Stage, unstage, or revert each contiguous block of diff lines
- Auto-reload local diffs when files change, keeping the current screen
- Import GitHub PR and GitLab MR review comments into the local plan for AI
- Commits list: commit, amend, fixup, reword, drop, pull, and push
- Branches: checkout, create, rebase, drop, pull, and push
- Review each npm dependency once across `package.json` and the lockfile
- Propose unused removals, npm audit fixes, and outdated updates as diffs
- Code highlighting and intra-line diffs: unified, mixed, and side-by-side
- Auto-update patch and minor releases; confirm a new major
- Work with git, npm and fetch in background

## Install

```bash
npm i -g reslop
```

Works on Linux, macOS, and Windows. On Windows use Windows Terminal.
Requires Node.js `>=18.15.0`.

## Usage

- `reslop` uncommitted diffs in this repository
- `reslop path/file` show only that path or file
- `reslop 7ac260c` show that commit (read-only)
- `reslop https://github.com/metarhia/metacom/pull/555` GitHub/GitLab PR/MR
- `reslop -n` start a new review even if the latest is still editing
- `reslop -r` read-only mode
- `reslop -light` light color theme (default dark)
- `reslop t -- <program> [args]` run one program and print a reduced report

Prefix each program in an npm script with `reslop t --`. Keep `&&` between those wraps, so each program is captured on its own and a failing step does not start the next one:

```json
"lint": "reslop t -- eslint . && reslop t -- prettier -c \"**/*.js\"",
"test": "reslop t -- npm run -s lint && reslop t -- node --test"
```

The report is Markdown: failures, diagnostics, and a short summary. Passing results are omitted and similar problems are grouped. The same text is saved under `.log/`. Set `RESLOP_OUTPUT=raw` to pass the command through unchanged. The review screen runs scripts in raw mode and applies its own filter once.

Reviews go in `.review/YYYY-MM-DD-NN.md` with frontmatter `status`:

- `editing`: still writing the review in reslop
- `ready`: ready for AI to work through the checkboxes
- `partial`: AI started; some items remain
- `done`: all items marked `[x]`

## Future

- Import issues from GitHub and GitLab
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

Copyright (c) 2026 Timur Shemsedinov.
This is [MIT](./LICENSE) licensed software.
