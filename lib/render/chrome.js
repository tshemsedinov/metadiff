'use strict';

const ansi = require('../ansi.js');
const keys = require('../keys.js');
const files = require('../files.js');
const primitives = require('./primitives.js');

const { itemPath, TODO_FILE, isTodosEntry, fileTotals } = files;
const { ACTION_IDS, BRANCH_ACTIONS, COMMIT_ACTIONS, actionLetter } = keys;
const { buttonWord } = keys;
const { FILES_HIDDEN, FILES_GIT_DISABLED, BRANCHES_DISABLED } = keys;
const { COMMITS_DISABLED, TODO_DISABLED, DIFF_DISABLED, UNIT_DISABLED } = keys;
const { NPM_DISABLED } = keys;
const { diffGitDisabled, branchGitDisabled, commitGitDisabled } = keys;
const { CONFIRM, confirmPrefix, promptFromChoices } = keys;
const { THEME, paint, visibleWidth } = ansi;
const { truncateVisible, fg, RESET, EL, seq } = ansi;
const { fill, branchLabel } = primitives;

const HEADER_ROLE_FG = {
  repo: THEME.headerRepoFg,
  dir: THEME.headerDirFg,
  slash: THEME.headerSlashFg,
  file: THEME.headerFileFg,
};

const WAVE = '·•●•·';

const busyBars = (wave) => {
  const n = wave.length;
  const frames = new Array(n);
  for (let frame = 0; frame < n; frame++) {
    const start = (n - frame) % n;
    frames[frame] = wave.slice(start) + wave.slice(0, start);
  }
  return frames;
};

const BUSY_BAR = busyBars(WAVE);
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

const QUIT_PROMPT = promptFromChoices(CONFIRM.confirmQuit.choices);
const updatePrompt = (from, to) => ` update reslop ${from} → ${to}? y/n`;
const dropPrompt = (name) => ` drop ${name}? y/n`;
const PUSH_REJECT_PREFIX = CONFIRM.confirmPush.prefix;
const PUSH_PROMPT = `${PUSH_REJECT_PREFIX} force push`;

const BUTTON_LEAD = ' ';
const BUTTON_GAP = '  ';
const BUTTON_EDGE = 1;
const buttonGap = (index) => (index ? BUTTON_GAP : BUTTON_LEAD);
const LOGO = '👁️';

const pathSegments = (rel) => {
  const segs = [];
  if (!rel) return segs;
  const bits = rel.split('/');
  for (let i = 0; i < bits.length; i++) {
    if (i) {
      segs.push({ text: '/', role: 'slash' });
    }
    if (!bits[i]) {
      continue;
    }
    const last = i === bits.length - 1;
    segs.push({ text: bits[i], role: last ? 'file' : 'dir' });
  }
  return segs;
};

const headerScreen = (view) => {
  const pane = view.pane ?? 'diff';
  if (pane === 'branches') return 'branches';
  if (pane === 'commits') {
    const mode = view.commitView === 'full' ? 'full' : 'brief';
    return `commits ${mode}`;
  }
  if (pane === 'npm') return 'npm';
  if (pane === 'files') {
    const files = view.files ?? [];
    const entry = files[view.fileCursor ?? 0];
    if (isTodosEntry(entry)) return TODO_FILE;
    return '';
  }
  if (view.item && view.item.origin === 'todo') return TODO_FILE;
  return '';
};

const headerTarget = (view) => {
  const pane = view.pane ?? 'diff';
  if (pane === 'files') {
    const entry = (view.files ?? [])[view.fileCursor ?? 0];
    if (!entry || isTodosEntry(entry)) return '';
    return entry.path;
  }
  if (pane === 'unit') return view.reviewPath ?? '';
  if (!view.item || view.item.origin === 'todo') return '';
  return itemPath(view.item);
};

const headerLabel = (view) => headerScreen(view) || headerTarget(view);

const headerSep = (view) => (headerScreen(view) ? ': ' : '/');

const headerPrefix = (view, label) => {
  const repo = view.repoName || '';
  if (repo && label) return ` ${LOGO}  reslop: ${repo}${headerSep(view)}`;
  if (repo) return ` ${LOGO}  reslop: ${repo} `;
  return ` ${LOGO}  reslop: `;
};

const headerText = (view) => {
  const label = headerLabel(view);
  return `${headerPrefix(view, label)}${label}`;
};

const headerPieces = (view, width) => {
  const repo = view.repoName || '';
  const path = headerLabel(view);
  const right = ' ';
  const chrome = ` ${LOGO}  reslop: `;
  const prefixW = visibleWidth(headerPrefix(view, path));
  const used = prefixW + visibleWidth(right);
  const room = Math.max(0, width - used);
  const clipped = truncateVisible(path, room);
  const pad = Math.max(0, room - visibleWidth(clipped));
  const pieces = [{ text: chrome, role: 'chrome' }];
  if (repo) {
    pieces.push({ text: repo, role: 'repo' });
    if (path) {
      const sep = headerSep(view);
      const role = sep === '/' ? 'slash' : 'chrome';
      pieces.push({ text: sep, role });
    } else {
      pieces.push({ text: ' ', role: 'chrome' });
    }
  }
  for (const seg of pathSegments(clipped)) {
    pieces.push(seg);
  }
  if (pad) {
    pieces.push({ text: ' '.repeat(pad), role: 'chrome' });
  }
  pieces.push({ text: right, role: 'chrome' });
  return pieces;
};

const paintHeader = (view, width, color) => {
  const pieces = headerPieces(view, width);
  if (!color) {
    return pieces.map((piece) => piece.text).join('');
  }
  const bgRgb = THEME.headerBg;
  let out = `${seq(THEME.headerChromeFg, bgRgb)}${EL}`;
  for (const piece of pieces) {
    if (!piece.text) {
      continue;
    }
    const roleFg = HEADER_ROLE_FG[piece.role] ?? THEME.headerChromeFg;
    out += `${fg(roleFg)}${piece.text}`;
  }
  return `${out}${RESET}`;
};

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

const paintMarkedWord = (label, letter, color, mark) => {
  const at = label.indexOf(letter);
  if (at < 0) {
    return paint(label, mark.missFg, mark.bgRgb, color, mark.missBold);
  }
  const before = label.slice(0, at);
  const hot = label.slice(at, at + letter.length);
  const after = label.slice(at + letter.length);
  let out = '';
  if (before) out += paint(before, mark.fgRgb, mark.bgRgb, color);
  out += paint(hot, mark.hotFg, mark.bgRgb, color, true);
  if (after) out += paint(after, mark.fgRgb, mark.bgRgb, color);
  return out;
};

const layoutButtons = (width, compact, hidden, extra, disabled) => {
  const hiddenIds = hidden ?? [];
  const extraIds = extra ?? [];
  const disabledIds = disabled ?? [];
  const ids = [];
  for (const id of ACTION_IDS) {
    if (id === 'quit') {
      for (const add of extraIds) {
        if (!ids.includes(add)) ids.push(add);
      }
      continue;
    }
    if (hiddenIds.includes(id)) continue;
    ids.push(id);
  }
  const build = (short) => {
    const hits = [];
    const parts = [];
    let x = 0;
    const limit = Math.max(0, width - BUTTON_EDGE);
    for (const id of ids) {
      const letter = actionLetter(id);
      const word = buttonWord(id);
      const label = short ? letter : word;
      const gap = buttonGap(parts.length);
      const piece = `${gap}${label}`;
      const w = visibleWidth(piece);
      if (x + w > limit && parts.length) break;
      const off = disabledIds.includes(id);
      if (!off) hits.push({ id, x0: x, x1: x + w });
      parts.push({ action: { id }, piece, letter, label, disabled: off });
      x += w;
    }
    return { hits, parts, width: x };
  };
  if (compact) return build(true);
  const words = build(false);
  if (words.parts.length === ids.length) return words;
  return build(true);
};

const paintButtons = (layout, width, color) => {
  let out = '';
  let used = 0;
  const fgRgb = THEME.buttonFg;
  const bgRgb = THEME.buttonBg;
  for (let i = 0; i < layout.parts.length; i++) {
    const part = layout.parts[i];
    const gap = buttonGap(i);
    out += paint(gap, fgRgb, bgRgb, color);
    if (part.disabled) out += paint(part.label, fgRgb, bgRgb, color);
    else out += paintMarkedWord(part.label, part.letter, color, BUTTON_MARK);
    used += visibleWidth(part.piece);
  }
  if (used < width) {
    out += fill(width - used, THEME.buttonFg, THEME.buttonBg, color);
  }
  return out;
};

const isInfoStatus = (status) => {
  if (INFO_STATUS.includes(status)) return true;
  for (const prefix of INFO_PREFIX) {
    if (status.startsWith(prefix)) return true;
  }
  return false;
};

const joinStatus = (parts) => {
  const bits = [];
  for (const part of parts) {
    if (!part) continue;
    bits.push(part);
  }
  return bits.join('  ');
};

const countsKind = (sourceKind, revShort) => {
  if (sourceKind === 'pr' || sourceKind === 'mr') return sourceKind;
  if (revShort) return 'commit';
  return 'worktree';
};

const notesLine = (counts) => {
  const feedback = counts.feedback ?? 0;
  const todo = counts.todo ?? 0;
  const code = counts.code ?? 0;
  return `feedback ${feedback}  todo ${todo}  code ${code}`;
};

const statusLead = (view) => {
  const counts = view.counts ?? {};
  const kind = countsKind(view.sourceKind, view.revShort);
  if (kind === 'worktree') return branchLabel(view.branch ?? '');
  if (kind === 'commit') {
    const n = counts.commit ?? 0;
    return `commit ${view.revShort}  ${n}`;
  }
  const n = counts.pr ?? 0;
  const label = view.sourceLabel || kind;
  return `${kind} ${label}  ${n}`;
};

const statusLeft = (view) => {
  const body = joinStatus([statusLead(view), notesLine(view.counts ?? {})]);
  if (!body) return '';
  return ` ${body}`;
};

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
  return joinStatus([plus, minus]);
};

const statusStats = (view) => {
  const counts = view.counts ?? {};
  const total = fileTotals(view.files ?? []);
  const counted = (counts.staged ?? 0) + (counts.unstaged ?? 0);
  const hasGit =
    total.remaining || total.staged || total.added || total.removed;
  const fallbackN = counts.staged ?? 0;
  const n = hasGit ? total.staged : fallbackN;
  const m = hasGit ? total.remaining : counted;
  const git = joinStatus([statusDelta(total), `${n}/${m}`]);
  if (!view.npmLogs) return git;
  return joinStatus([view.npmLogs, git]);
};

const statusLayout = (view, status, width) => {
  const shown = formatBusyStatus(status, view.progressFrame ?? 0);
  const msg = shown;
  let msgFg = THEME.chromeFg;
  if (msg && !isInfoStatus(status)) msgFg = THEME.errorFg;
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
  const { length } = choices;
  const hits = new Array(length);
  let x = visibleWidth(prefix);
  for (let i = 0; i < length; i++) {
    const choice = choices[i];
    const piece = `${choice.lead}${choice.label}`;
    const w = visibleWidth(piece);
    hits[i] = { id: choice.letter, y, x0: x, x1: x + w };
    x += w;
  }
  return hits;
};

const paintChoicePrompt = (choices, width, color, prefix = '') => {
  const bgRgb = THEME.chromeBg;
  const labels = choices
    .map((choice) => `${choice.lead}${choice.label}`)
    .join('');
  const body = `${prefix}${labels}`;
  if (!color) {
    const pad = Math.max(0, width - visibleWidth(body));
    return body + ' '.repeat(pad);
  }
  let out = '';
  if (prefix) out += paint(prefix, THEME.mutedFg, bgRgb, color);
  for (const choice of choices) {
    const label = `${choice.lead}${choice.label}`;
    out += paintMarkedWord(label, choice.letter, color, QUIT_MARK);
  }
  const pad = Math.max(0, width - visibleWidth(body));
  return out + fill(pad, THEME.mutedFg, bgRgb, color);
};

const STATUS_MARK = /(\+[0-9]+(?:\/[0-9]+)?|-[0-9]+(?:\/[0-9]+)?)/g;
const OLD_LOGS = /old logs \S+/;

const paintStatusMark = (token, color) => {
  const bgRgb = THEME.chromeBg;
  if (token.startsWith('+')) {
    return paint(token, THEME.addLineFg, bgRgb, color);
  }
  return paint(token, THEME.delLineFg, bgRgb, color);
};

const paintStatusLeft = (text, color) => {
  const bgRgb = THEME.chromeBg;
  const muted = THEME.mutedFg;
  if (!color) return text;
  const found = text.match(OLD_LOGS);
  if (found) {
    const at = found.index;
    const token = found[0];
    const before = text.slice(0, at);
    const after = text.slice(at + token.length);
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
    const start = match.index;
    if (start > last) {
      out += paint(text.slice(last, start), muted, bgRgb, color);
    }
    out += paintStatusMark(token, color);
    last = start + token.length;
  }
  if (last < text.length) {
    out += paint(text.slice(last), muted, bgRgb, color);
  }
  return out;
};

const paintBranchHead = (text, branch, color) => {
  const name = branchLabel(branch);
  if (!name || !text.startsWith(' ')) return null;
  const head = ` ${name}`;
  const shown = text.startsWith(head) ? name : text.slice(1);
  if (!shown || !name.startsWith(shown)) return null;
  const rest = text.slice(1 + shown.length);
  const bgRgb = THEME.chromeBg;
  return (
    paint(' ', THEME.mutedFg, bgRgb, color) +
    paint(shown, THEME.buttonHotFg, bgRgb, color, true) +
    paintStatusLeft(rest, color)
  );
};

const SAVE_HINT = 'Press **Ctrl-S** or **Enter** at EOF to save';
const HINT_HOT_FG = 0xff;

const hintParts = (source) => {
  const bits = source.split('**');
  const parts = [];
  for (let i = 0; i < bits.length; i++) {
    if (!bits[i]) continue;
    parts.push({ text: bits[i], hot: i % 2 === 1 });
  }
  return parts;
};

const saveHintText = () => SAVE_HINT.replaceAll('**', '');

const commitSaveHint = (view) => {
  if (view.mode !== 'compose' || view.commitView !== 'full') return false;
  const compose = view.compose;
  return Boolean(compose && compose.kind === 'commit');
};

const paintSaveHintBar = (width, color) => {
  const bgRgb = THEME.buttonBg;
  const plain = `${BUTTON_LEAD}${saveHintText()}`;
  if (!color) {
    const pad = Math.max(0, width - visibleWidth(plain));
    return plain + ' '.repeat(pad);
  }
  let out = paint(BUTTON_LEAD, THEME.buttonFg, bgRgb, color);
  for (const part of hintParts(SAVE_HINT)) {
    const tone = part.hot ? HINT_HOT_FG : THEME.buttonFg;
    out += paint(part.text, tone, bgRgb, color, part.hot);
  }
  const pad = Math.max(0, width - visibleWidth(plain));
  return out + fill(pad, THEME.buttonFg, bgRgb, color);
};

const paintFooter = (view, layout, width, color) => {
  if (commitSaveHint(view)) return paintSaveHintBar(width, color);
  return paintButtons(layout, width, color);
};

const footerHits = (view, layout) => {
  if (commitSaveHint(view)) return [];
  return layout.hits;
};

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
  const worktree = countsKind(view.sourceKind, view.revShort) === 'worktree';
  const head = worktree
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
  const prefix = confirmPrefix(spec, view);
  return choiceHits(spec.choices, prefix, y);
};

const statusBranchHit = (view, width, y) => {
  const mode = view.mode;
  if (CONFIRM[mode]) return null;
  const branch = view.branch ?? '';
  if (!branchLabel(branch)) return null;
  if (countsKind(view.sourceKind, view.revShort) !== 'worktree') return null;
  const layout = statusLayout(view, view.status ?? '', width);
  const name = branchLabel(branch);
  const at = layout.clipped.indexOf(name);
  if (at < 0) return null;
  return { id: 'branch', y, x0: at, x1: at + visibleWidth(name) };
};

const selectedBranch = (view) => (view.branches ?? [])[view.branchCursor ?? 0];

const selectedCommit = (view) => (view.commits ?? [])[view.commitCursor ?? 0];

const hiddenActions = (view) => {
  const pane = view.pane ?? 'diff';
  if (pane === 'files') return FILES_HIDDEN;
  if (pane === 'unit') return UNIT_DISABLED;
  if (pane === 'branches') return BRANCHES_DISABLED;
  if (pane === 'commits') return COMMITS_DISABLED;
  if (pane === 'npm') return NPM_DISABLED;
  if (view.item && view.item.origin === 'todo') return TODO_DISABLED;
  return DIFF_DISABLED;
};

const dimFooterActions = (view) => {
  const pane = view.pane ?? 'diff';
  if (pane === 'files') {
    const files = view.files ?? [];
    const entry = files[view.fileCursor ?? 0];
    if (!entry || entry.kind !== 'todos') return [];
    return FILES_GIT_DISABLED;
  }
  if (pane === 'diff' || pane === 'unit') return diffGitDisabled(view.item);
  if (pane === 'branches') return branchGitDisabled(selectedBranch(view));
  if (pane === 'commits') {
    const entry = selectedCommit(view);
    const staged = (view.counts?.staged ?? 0) > 0;
    const unstagedCurrent = !view.rev && !view.revShort;
    return commitGitDisabled({
      ...entry,
      canCommit: staged,
      unstagedCurrent,
    });
  }
  if (pane === 'npm' && view.npmView) {
    if (view.npmRunning) return ['npmRerun'];
    return [];
  }
  if (pane === 'npm' && !view.npmLogs) return ['npmLogs'];
  return [];
};

const extraFooterActions = (view) => {
  const pane = view.pane ?? 'diff';
  if (pane === 'files') {
    const scope = view.fileScope === 'file' ? 'diff' : 'file';
    return ['npm', scope, 'commit', 'pull', 'push'];
  }
  if (pane === 'branches') return Object.keys(BRANCH_ACTIONS);
  if (pane === 'commits') return Object.keys(COMMIT_ACTIONS);
  if (pane === 'npm') {
    if (view.npmView) return ['npmStop', 'npmRerun'];
    return ['npmEdit', 'npmNew', 'npmDrop', 'npmLogs'];
  }
  return [];
};

module.exports = {
  QUIT_PROMPT,
  PUSH_PROMPT,
  updatePrompt,
  dropPrompt,
  formatBusyStatus,
  headerText,
  paintHeader,
  layoutButtons,
  paintButtons,
  paintFooter,
  footerHits,
  paintStatusLine,
  statusChoiceHits,
  statusBranchHit,
  hiddenActions,
  dimFooterActions,
  extraFooterActions,
};
