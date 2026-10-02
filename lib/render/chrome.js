'use strict';

const ansi = require('../ansi.js');
const keys = require('../keys.js');
const files = require('../files.js');
const primitives = require('./primitives.js');

const { itemPath, REPO_TASKS_LABEL, isTasksEntry, fileTotals } = files;
const { ACTION_IDS, actionLetter } = keys;
const { DASH_IDS, DASH_HIDDEN, buttonWord } = keys;
const { FILES_HIDDEN, FILES_GIT_DISABLED, BRANCHES_DISABLED } = keys;
const { COMMITS_DISABLED, TASKS_DISABLED, DIFF_DISABLED, UNIT_DISABLED } = keys;
const { NPM_DISABLED } = keys;
const { diffGitDisabled, branchGitDisabled, commitGitDisabled } = keys;
const { CONFIRM, confirmPrefix, promptFromChoices } = keys;
const { THEME, paint, visibleWidth } = ansi;
const { truncateVisible, fg, RESET, EL, seq } = ansi;
const { fill, branchLabel, isTaskView } = primitives;

const WAVE = '·•●•·';
const BUSY_BAR = Array.from(WAVE, (_, frame) => {
  const start = (WAVE.length - frame) % WAVE.length;
  return WAVE.slice(start) + WAVE.slice(0, start);
});

const BUSY_PROGRESS = [
  'pulling',
  'pushing',
  'loading',
  'checking npm',
  'updating reslop',
  'npm i',
  'npm uninstall',
  'npm audit fix',
  'running',
  'checking out',
  'creating branch',
  'rebasing',
  'dropping',
  'committing',
  'rewording',
  'force pushing',
];

const formatBusyStatus = (status, frame = 0) => {
  const kind = `${status ?? ''}`;
  if (!BUSY_PROGRESS.includes(kind)) return kind;
  const i = Math.abs(frame) % BUSY_BAR.length;
  return `${kind}  ${BUSY_BAR[i]}`;
};

const INFO_STATUS = [
  'copied',
  'staged',
  'unstaged',
  'not staged',
  'dropped',
  'already staged',
  'read only',
  'nothing to review',
  'nothing to commit',
  'unified',
  'mixed',
  'side-by-side',
  'dark',
  'light',
  'saved',
  'reloaded',
  'not a diff block',
  'file scope',
  'diff mode',
  'committed',
  'amended',
  'reworded',
  'fixup',
  'updated',
  'updating reslop',
  'loading',
  'checking npm',
  'npm i',
  'npm uninstall',
  'npm audit fix',
  'pulling',
  'pushing',
  'pulled',
  'pushed',
  'force pushing',
  'force pushed',
  'checking out',
  'creating branch',
  'rebasing',
  'dropping',
  'committing',
  'checked out',
  'created',
  'empty branch name',
  'empty commit message',
];
const INFO_PREFIX = ['checked out ', 'created ', 'rebased onto ', 'dropped '];

const LOGO = '👁️';
const HEADER_LEAD = ` ${LOGO}  reslop: `;
const HEADER_ROLE_FG = {
  chrome: THEME.headerChromeFg,
  repo: THEME.headerRepoFg,
  dir: THEME.headerDirFg,
  slash: THEME.headerSlashFg,
  file: THEME.headerFileFg,
};

const BUTTON_LEAD = ' ';
const BUTTON_GAP = '  ';
const BUTTON_EDGE = 1;
const BACK_ARROW = '🢐';
const STOP_MARK = '⊗';
const BACK_KEY = 'esc';

const BUTTON_MARK = {
  bgRgb: THEME.buttonBg,
  fgRgb: THEME.buttonFg,
  hotFg: THEME.buttonHotFg,
  missFg: THEME.buttonHotFg,
  missBold: true,
};

const QUIT_MARK = {
  bgRgb: THEME.chromeBg,
  fgRgb: THEME.mutedFg,
  hotFg: THEME.warnFg,
  missFg: THEME.mutedFg,
  missBold: false,
};

const STATUS_MARK = /(\+[0-9]+(?:\/[0-9]+)?|-[0-9]+(?:\/[0-9]+)?)/g;
const OLD_LOGS = /old logs \S+/;
const SAVE_HINT = 'Press **Ctrl-S** or **Enter** at EOF to save';
const HINT_HOT_FG = 0xff;

const selectedFile = (view) => (view.files ?? [])[view.fileCursor ?? 0];

const selectedBranch = (view) => (view.branches ?? [])[view.branchCursor ?? 0];

const selectedCommit = (view) => (view.commits ?? [])[view.commitCursor ?? 0];

const piecesText = (pieces) => pieces.map((piece) => piece.text).join('');

const pathSegments = (rel) => {
  const segs = [];
  if (!rel) return segs;
  const bits = rel.split('/');
  for (let i = 0; i < bits.length; i++) {
    if (i) segs.push({ text: '/', role: 'slash' });
    const role = i === bits.length - 1 ? 'file' : 'dir';
    if (bits[i]) segs.push({ text: bits[i], role });
  }
  return segs;
};

const headerScreen = (view) => {
  const { pane } = view;
  if (
    pane === 'dashboard' ||
    pane === 'branches' ||
    pane === 'npm' ||
    pane === 'tasks'
  ) {
    return pane;
  }
  if (pane === 'commits') {
    return view.commitView === 'full' ? 'commits full' : 'commits brief';
  }
  if (pane === 'files') {
    return isTasksEntry(selectedFile(view)) ? REPO_TASKS_LABEL : '';
  }
  return isTaskView(view) ? REPO_TASKS_LABEL : '';
};

const headerTarget = (view) => {
  if (view.pane === 'files') {
    const entry = selectedFile(view);
    if (!entry || isTasksEntry(entry)) return '';
    return entry.path;
  }
  if (view.pane === 'unit') return view.reviewPath ?? '';
  if (isTaskView(view)) return '';
  return itemPath(view.item);
};

const headerLead = (view) => {
  const screen = headerScreen(view);
  const label = screen || headerTarget(view);
  const repo = view.repoName || '';
  const pieces = [{ text: HEADER_LEAD, role: 'chrome' }];
  if (repo) {
    pieces.push({ text: repo, role: 'repo' });
    if (!label) pieces.push({ text: ' ', role: 'chrome' });
    else if (screen) pieces.push({ text: ': ', role: 'chrome' });
    else pieces.push({ text: '/', role: 'slash' });
  }
  return { pieces, label };
};

const headerText = (view) => {
  const { pieces, label } = headerLead(view);
  return `${piecesText(pieces)}${label}`;
};

const paintHeader = (view, width, color) => {
  const { pieces, label } = headerLead(view);
  const right = ' ';
  const used = visibleWidth(piecesText(pieces)) + visibleWidth(right);
  const room = Math.max(0, width - used);
  const clipped = truncateVisible(label, room);
  const pad = Math.max(0, room - visibleWidth(clipped));
  pieces.push(...pathSegments(clipped));
  if (pad) pieces.push({ text: ' '.repeat(pad), role: 'chrome' });
  pieces.push({ text: right, role: 'chrome' });
  if (!color) return piecesText(pieces);
  let out = `${seq(THEME.headerChromeFg, THEME.headerBg)}${EL}`;
  for (const piece of pieces) {
    out += `${fg(HEADER_ROLE_FG[piece.role])}${piece.text}`;
  }
  return `${out}${RESET}`;
};

const backFooterId = (view) => {
  const { pane } = view;
  if (pane === 'branches' || pane === 'commits' || pane === 'tasks') {
    return 'back';
  }
  if (pane === 'npm') return view.npmView ? 'npmStop' : 'back';
  return isTaskView(view) ? 'back' : '';
};

const backHintMark = (view) => {
  if (view.pane === 'npm' && view.npmView && view.npmRunning) return STOP_MARK;
  return BACK_ARROW;
};

const buttonGap = (index) => (index ? BUTTON_GAP : BUTTON_LEAD);

const hintBody = (mark) => {
  const gap = mark === STOP_MARK ? ' ' : '';
  return `${mark}${gap}${BACK_KEY}`;
};

const buttonLabel = (id, short) => (short ? actionLetter(id) : buttonWord(id));

const paintBackHint = (color, mark) => {
  const bgRgb = THEME.buttonBg;
  const rest = hintBody(mark).slice(mark.length);
  const arrow = paint(mark, THEME.buttonHotFg, bgRgb, color, true);
  return arrow + paint(rest, THEME.buttonFg, bgRgb, color);
};

const paintMarkedWord = (label, letter, color, mark) => {
  const at = label.indexOf(letter);
  if (at < 0) {
    return paint(label, mark.missFg, mark.bgRgb, color, mark.missBold);
  }
  const before = label.slice(0, at);
  const hot = label.slice(at, at + letter.length);
  const after = label.slice(at + letter.length);
  let out = paint(before, mark.fgRgb, mark.bgRgb, color);
  out += paint(hot, mark.hotFg, mark.bgRgb, color, true);
  return out + paint(after, mark.fgRgb, mark.bgRgb, color);
};

const footerIds = (hidden, extra, backId) => {
  const ids = backId ? [backId] : [];
  for (const add of extra) {
    if (!ids.includes(add)) ids.push(add);
  }
  for (const id of ACTION_IDS) {
    if (id === 'quit' || hidden.includes(id) || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids;
};

const layoutButtons = (width, options = {}) => {
  const { compact = false, hidden = [], extra = [], disabled = [] } = options;
  const { backId = '', mark = BACK_ARROW } = options;
  const ids = footerIds(hidden, extra, backId);
  const limit = Math.max(0, width - BUTTON_EDGE);
  const build = (short) => {
    const hits = [];
    const parts = [];
    let x = 0;
    for (const id of ids) {
      const back = id === backId;
      const letter = back ? BACK_KEY : actionLetter(id);
      const label = back ? hintBody(mark) : buttonLabel(id, short);
      const piece = `${buttonGap(parts.length)}${label}`;
      const w = visibleWidth(piece);
      if (x + w > limit && parts.length) break;
      const off = disabled.includes(id);
      if (!off) hits.push({ id, x0: x, x1: x + w });
      const hint = back ? mark : '';
      parts.push({ id, piece, letter, label, disabled: off, back, mark: hint });
      x += w;
    }
    return { hits, parts };
  };
  if (compact) return build(true);
  const words = build(false);
  if (words.parts.length === ids.length) return words;
  return build(true);
};

const paintButtons = (layout, width, color) => {
  const fgRgb = THEME.buttonFg;
  const bgRgb = THEME.buttonBg;
  let out = '';
  let used = 0;
  for (let i = 0; i < layout.parts.length; i++) {
    const part = layout.parts[i];
    out += paint(buttonGap(i), fgRgb, bgRgb, color);
    if (part.back) out += paintBackHint(color, part.mark);
    else if (part.disabled) out += paint(part.label, fgRgb, bgRgb, color);
    else out += paintMarkedWord(part.label, part.letter, color, BUTTON_MARK);
    used += visibleWidth(part.piece);
  }
  return out + fill(width - used, fgRgb, bgRgb, color);
};

const isInfoStatus = (status) =>
  INFO_STATUS.includes(status) ||
  INFO_PREFIX.some((prefix) => status.startsWith(prefix));

const joinStatus = (parts) => parts.filter(Boolean).join('  ');

const countsKind = (sourceKind, revShort) => {
  if (sourceKind === 'pr' || sourceKind === 'mr') return sourceKind;
  return revShort ? 'commit' : 'worktree';
};

const isWorktree = (view) =>
  countsKind(view.sourceKind, view.revShort) === 'worktree';

const notesLine = (counts) => {
  const feedback = counts.feedback ?? 0;
  const tasks = counts.tasks ?? 0;
  const code = counts.code ?? 0;
  return `feedback ${feedback}  tasks ${tasks}  code ${code}`;
};

const statusLead = (view) => {
  const counts = view.counts ?? {};
  const kind = countsKind(view.sourceKind, view.revShort);
  if (kind === 'worktree') return branchLabel(view.branch);
  if (kind === 'commit') {
    return `commit ${view.revShort}  ${counts.commit ?? 0}`;
  }
  const label = view.sourceLabel || kind;
  return `${kind} ${label}  ${counts.pr ?? 0}`;
};

const statusLeft = (view) =>
  ` ${joinStatus([statusLead(view), notesLine(view.counts ?? {})])}`;

const statusDelta = (total) => {
  const stagedAdd = total.stagedAdded ?? 0;
  const unstagedAdd = total.unstagedAdded ?? 0;
  const stagedDel = total.stagedRemoved ?? 0;
  const unstagedDel = total.unstagedRemoved ?? 0;
  const hasDelta =
    stagedAdd || unstagedAdd || stagedDel || unstagedDel || total.added;
  if (!hasDelta && !total.removed) return '';
  const plus = `+${stagedAdd}/${stagedAdd + unstagedAdd}`;
  const minus = `-${stagedDel}/${stagedDel + unstagedDel}`;
  return `${plus}  ${minus}`;
};

const statusStats = (view) => {
  const counts = view.counts ?? {};
  const staged = counts.staged ?? 0;
  const total = fileTotals(view.files ?? []);
  const hasGit =
    total.remaining || total.staged || total.added || total.removed;
  const n = hasGit ? total.staged : staged;
  const m = hasGit ? total.remaining : staged + (counts.unstaged ?? 0);
  return joinStatus([view.npmLogs, statusDelta(total), `${n}/${m}`]);
};

const statusLayout = (view, status, width) => {
  const msg = formatBusyStatus(status, view.progressFrame ?? 0);
  const isError = msg && !isInfoStatus(status);
  const msgFg = isError ? THEME.errorFg : THEME.chromeFg;
  const stats = statusStats(view);
  const right = stats ? `${stats} ` : '';
  const rightW = visibleWidth(right);
  const msgW = visibleWidth(msg);
  const side = msg ? 1 : 0;
  const room = Math.max(0, width - rightW - msgW - side * 2);
  const clipped = truncateVisible(statusLeft(view), room);
  const leftW = visibleWidth(clipped);
  const extra = Math.max(0, width - leftW - rightW - msgW);
  const padLeft = msg ? Math.floor(extra / 2) : extra;
  const padRight = msg ? extra - padLeft : 0;
  return { clipped, msg, msgFg, right, padLeft, padRight };
};

const choiceHits = (choices, prefix, y) => {
  let x = visibleWidth(prefix);
  return choices.map((choice) => {
    const w = visibleWidth(`${choice.lead}${choice.label}`);
    const hit = { id: choice.letter, y, x0: x, x1: x + w };
    x += w;
    return hit;
  });
};

const paintChoicePrompt = (choices, width, color, prefix) => {
  const bgRgb = THEME.chromeBg;
  const body = `${prefix}${promptFromChoices(choices)}`;
  const pad = Math.max(0, width - visibleWidth(body));
  if (!color) return body + ' '.repeat(pad);
  let out = paint(prefix, THEME.mutedFg, bgRgb, color);
  for (const choice of choices) {
    const label = `${choice.lead}${choice.label}`;
    out += paintMarkedWord(label, choice.letter, color, QUIT_MARK);
  }
  return out + fill(pad, THEME.mutedFg, bgRgb, color);
};

const paintStatusLeft = (text, color) => {
  if (!color) return text;
  const bgRgb = THEME.chromeBg;
  const found = text.match(OLD_LOGS);
  if (found) {
    const token = found[0];
    const before = text.slice(0, found.index);
    const after = text.slice(found.index + token.length);
    return (
      paintStatusLeft(before, color) +
      paint(token, THEME.shaFg, bgRgb, color) +
      paintStatusLeft(after, color)
    );
  }
  let out = '';
  let last = 0;
  for (const match of text.matchAll(STATUS_MARK)) {
    const token = match[0];
    const tokenFg = token.startsWith('+') ? THEME.addLineFg : THEME.delLineFg;
    out += paint(text.slice(last, match.index), THEME.mutedFg, bgRgb, color);
    out += paint(token, tokenFg, bgRgb, color);
    last = match.index + token.length;
  }
  return out + paint(text.slice(last), THEME.mutedFg, bgRgb, color);
};

const paintBranchHead = (text, branch, color) => {
  const name = branchLabel(branch);
  if (!name || !text.startsWith(' ')) return null;
  const shown = text.startsWith(` ${name}`) ? name : text.slice(1);
  if (!shown || !name.startsWith(shown)) return null;
  const rest = text.slice(1 + shown.length);
  const bgRgb = THEME.chromeBg;
  return (
    paint(' ', THEME.mutedFg, bgRgb, color) +
    paint(shown, THEME.buttonHotFg, bgRgb, color, true) +
    paintStatusLeft(rest, color)
  );
};

const commitSaveHint = (view) =>
  view.mode === 'compose' &&
  view.commitView === 'full' &&
  view.compose?.kind === 'commit';

const paintSaveHintBar = (width, color) => {
  const bgRgb = THEME.buttonBg;
  const plain = `${BUTTON_LEAD}${SAVE_HINT.replaceAll('**', '')}`;
  const pad = Math.max(0, width - visibleWidth(plain));
  if (!color) return plain + ' '.repeat(pad);
  let out = paint(BUTTON_LEAD, THEME.buttonFg, bgRgb, color);
  const bits = SAVE_HINT.split('**');
  for (let i = 0; i < bits.length; i++) {
    const hot = i % 2 === 1;
    const tone = hot ? HINT_HOT_FG : THEME.buttonFg;
    out += paint(bits[i], tone, bgRgb, color, hot);
  }
  return out + fill(pad, THEME.buttonFg, bgRgb, color);
};

const paintFooter = (view, layout, width, color) => {
  if (commitSaveHint(view)) return paintSaveHintBar(width, color);
  return paintButtons(layout, width, color);
};

const footerHits = (view, layout) => (commitSaveHint(view) ? [] : layout.hits);

const paintStatusLine = (view, status, width, color) => {
  const confirm = CONFIRM[view.mode];
  if (confirm) {
    const prefix = confirmPrefix(confirm, view);
    return paintChoicePrompt(confirm.choices, width, color, prefix);
  }
  const layout = statusLayout(view, status, width);
  const leftGap = ' '.repeat(layout.padLeft);
  const rightGap = ' '.repeat(layout.padRight);
  if (!color) {
    return layout.clipped + leftGap + layout.msg + rightGap + layout.right;
  }
  const bgRgb = THEME.chromeBg;
  const head = isWorktree(view)
    ? paintBranchHead(layout.clipped, view.branch, color)
    : null;
  const left = head ?? paintStatusLeft(layout.clipped, color);
  return (
    left +
    paint(leftGap, THEME.mutedFg, bgRgb, color) +
    paint(layout.msg, layout.msgFg, bgRgb, color) +
    paint(rightGap, THEME.mutedFg, bgRgb, color) +
    paintStatusLeft(layout.right, color)
  );
};

const statusChoiceHits = (view, y) => {
  const spec = CONFIRM[view.mode];
  if (!spec) return [];
  return choiceHits(spec.choices, confirmPrefix(spec, view), y);
};

const statusBranchHit = (view, width, y) => {
  if (CONFIRM[view.mode]) return null;
  const name = branchLabel(view.branch);
  if (!name || !isWorktree(view)) return null;
  const layout = statusLayout(view, view.status ?? '', width);
  const at = layout.clipped.indexOf(name);
  if (at < 0) return null;
  return { id: 'branch', y, x0: at, x1: at + visibleWidth(name) };
};

const withHidden = (ids, more) => [...ids, ...more];

const hiddenActions = (view) => {
  const { pane } = view;
  if (pane === 'dashboard') return DASH_HIDDEN;
  if (pane === 'files') return FILES_HIDDEN;
  if (pane === 'unit') return withHidden(UNIT_DISABLED, ['feedback', 'tasks']);
  if (pane === 'branches') return BRANCHES_DISABLED;
  if (pane === 'commits') return COMMITS_DISABLED;
  if (pane === 'npm') return NPM_DISABLED;
  if (pane === 'tasks' || isTaskView(view)) {
    return withHidden(TASKS_DISABLED, ['prev', 'next']);
  }
  return withHidden(DIFF_DISABLED, ['feedback', 'tasks']);
};

const dimFooterActions = (view) => {
  const pane = view.pane ?? 'diff';
  if (pane === 'files') {
    return isTasksEntry(selectedFile(view)) ? FILES_GIT_DISABLED : [];
  }
  if (pane === 'diff' || pane === 'unit') return diffGitDisabled(view.item);
  if (pane === 'branches') return branchGitDisabled(selectedBranch(view));
  if (pane === 'commits') {
    return commitGitDisabled({
      ...selectedCommit(view),
      canCommit: (view.counts?.staged ?? 0) > 0,
      unstagedCurrent: !view.rev && !view.revShort,
    });
  }
  if (pane !== 'npm') return [];
  if (view.npmView) return view.npmRunning ? ['npmRerun'] : [];
  return view.npmLogs ? [] : ['npmLogs'];
};

const navExcept = (skip) => DASH_IDS.filter((id) => !skip.includes(id));

const extraFooterActions = (view) => {
  const { pane } = view;
  if (pane === 'dashboard') return DASH_IDS;
  if (pane === 'branches') {
    return [
      ...navExcept(['dashNpm']),
      'newBranch',
      'rebase',
      'drop',
      'pull',
      'push',
    ];
  }
  if (pane === 'commits') {
    return [
      ...navExcept(['dashCommits']),
      'commit',
      'amend',
      'apply',
      'reword',
      'fixup',
      'drop',
      'view',
    ];
  }
  if (pane === 'npm') {
    if (view.npmView) {
      return [...navExcept(['dashRun']), 'npmVerbose', 'npmRerun'];
    }
    return [...DASH_IDS, 'npmEdit', 'npmNew', 'npmDrop', 'npmLogs'];
  }
  if (pane === 'tasks' || isTaskView(view)) return [...DASH_IDS, 'drop'];
  return navExcept(['dashDiffs']);
};

const footerLayout = (view, width) =>
  layoutButtons(width, {
    hidden: hiddenActions(view),
    extra: extraFooterActions(view),
    disabled: dimFooterActions(view),
    backId: backFooterId(view),
    mark: backHintMark(view),
  });

module.exports = {
  formatBusyStatus,
  headerText,
  paintHeader,
  layoutButtons,
  footerLayout,
  paintFooter,
  footerHits,
  paintStatusLine,
  statusChoiceHits,
  statusBranchHit,
};
