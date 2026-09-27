# Changelog

## [Unreleased][unreleased]

## [0.2.3][] - 2026-09-27

- Add brief and full commit lists, toggled with `v`
- Select a commit from the list to view its diff
- Edit a multi-line commit message
- Propose unused removals only for libraries that export code
- Improve TUI/TUX, multiple small fixes
- Implement npm command runner with termination and re-run
- Filter tests output to reduce AI costs: `npm t` and other scripts
- Save script logs under `.log/`
- Group similar problems in test and other output

## [0.2.1][] - 2026-09-23

- Type a new commit message at the top of the list
- Improve `fixup!` functions: create and apply
- Reword the selected commit message with `r`
- Add light theme: `-light` option and `l` hotkey to switch
- Support checkbox state in TODOs, UI for state change
- Reload the file list when leaving todos, branches, or commits
- Let agents run `editing` reviews and leave `done` files unchanged
- Skip npm audit and outdated unless package files changed
- Sync and merge TODOs with file instead of overwriting it

## [0.2.0][] - 2026-09-22

- Add a full-size file editor
- Optimize codebase and reorganize code structure
- Add pull and push on the commits list screen
- Fix disk watcher startup on macOS
- Fix Windows temp-path comparison and same-size file reload polling

## [0.1.9][] - 2026-09-19

- Remove `r` reload hotkey and hint; auto-reload covers disk changes
- Improve branch list TUI/TUX
- Right-align the time column in the branch list
- Refresh the branch list after push, pull, and rebase
- Keep diff viewer order when staging or unstaging a block
- Add a commits list screen with commit operation
- Show staged/total rather than staged/unstaged in files list
- Show file ages in the file list right-aligned
- Sort the file list by path from the repo root
- Update file-list hotkeys and hints
- Fix dependency updates, locks and audit

## [0.1.8][] - 2026-09-17

- Simplify session controllers, input dispatch, and loading orchestration
- Enforce structural limits and session dependency direction on library files
- Show staged/unstaged +/- and staged/remaining totals in status line
- Jump by word with Ctrl+Left/Right in all text editors
- Support PgUp, PgDn, Home, and End in lists and multiline editors
- Support mouse click in submenu and confirmation choices on the hint line
- Fix TODO wrapped text; keep up/down navigation inside a multiline todos
- Fix identifier diffs as whole words compare, not just letters
- Keep reslop open when a local repo has no unstaged changes
- Fix invisible cursor movement in scrolling diffs
- Auto-reload worktree on disk changes, keeping the current UI state
- Fix disk watch paths on Windows
- Set git push upstream to `origin <branch>` when missing
- Save in-place diff edits to the reviewed file

## [0.1.7][] - 2026-09-16

- Make TODOs repo-wide, not per-file todos
- Improve TODO screen and files screen TUI/TUX including hotkeys
- Implement branch rebase and drop
- Improve branch screen TUI/TUX
- Fix TODOs autosave bug with todo duplication

## [0.1.6][] - 2026-09-15

- Auto updates for patch/minor, y/n per new major
- Lists branches, new branch, git pull, git push
- Show TUI progress for long background operations
- Fix Windows spawn EINVAL when running `npm.cmd`
- Highlight Dart diffs; refactor syntax highlighting
- Multiple TUI/TUX improvements and fixes

## [0.1.5][] - 2026-09-14

- Added `r` to reload diffs from disk
- Added `e` to edit added lines in place
- Added `d` on quit to discard a new review file
- Added `c` to commit, amend, or fixup staged changes
- Reassign hotkeys to free needed keys for new operations

## [0.1.4][] - 2026-09-13

- Support a GitLab MR by URL and import review comments
- Support Windows: npm.cmd, clip, terminal resize, installer
- Added `-r` read-only mode that blocks stage, unstage, revert, npm
- Fixed `npm test` so it finds tests on Windows, macOS, and Node 18
- Added Testing CI on Linux, macOS, and Windows

## [0.1.3][] - 2026-09-12

- Showed added/removed and staged/total counts in the file list
- Highlighted JSX and TSX syntax, including
- Added vim-style j/k navigation and Ctrl scrolling
- Improved TUI/UX with background git and npm checks to avoid a freeze

## [0.1.2][] - 2026-09-11

- Review each dependency once across package.json and package-lock
- Mark unused npm dependencies that are not imported or used
- Propose unused dependency removals and run npm uninstall
- Mark dependency review items and show npm audit findings
- Show npm outdated and npm audit updates as proposed diffs
- Propose a lockfile version bump for transitive dependencies

## [0.1.1][] - 2026-09-10

- Open a GitHub pull request by URL and review its diff
- Import GitHub pull request review comments into the local review
- Improve TUI navigation and hotkeys
- CLI simplification and optimisation
- Fix diff highlighting for snake_case identifier changes
- Updated package metadata and README

## [0.1.0][] - 2026-09-07

- Interactive review of uncommitted git diffs with stage, unstage, revert
- Feedback and todos that produce a repair plan for an agent
- Intra-line highlighting in unified, mixed, and side-by-side layouts

[unreleased]: https://github.com/tshemsedinov/reslop/compare/v0.2.3...HEAD
[0.2.3]: https://github.com/tshemsedinov/reslop/compare/v0.2.1...v0.2.3
[0.2.1]: https://github.com/tshemsedinov/reslop/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/tshemsedinov/reslop/compare/v0.1.9...v0.2.0
[0.1.9]: https://github.com/tshemsedinov/reslop/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/tshemsedinov/reslop/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/tshemsedinov/reslop/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/tshemsedinov/reslop/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/tshemsedinov/reslop/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/tshemsedinov/reslop/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/tshemsedinov/reslop/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/tshemsedinov/reslop/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/tshemsedinov/reslop/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/tshemsedinov/reslop/releases/tag/v0.1.0
