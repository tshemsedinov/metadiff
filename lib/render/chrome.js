'use strict';

const ansi = require('../ansi.js');
const keys = require('../keys.js');
const files = require('../files.js');
const { fill, branchLabel, isTaskView } = require('./primitives.js');
const { npmStatus } = require('./dash-blocks.js');

const { itemPath, REPO_TASKS_LABEL, isTasksEntry, fileTotals } = files;
const { ACTION_IDS, actionLetter } = keys;
const { DASH_IDS, DASH_HIDDEN, buttonWord } = keys;
const { FILES_HIDDEN, FILES_GIT_DISABLED, BRANCHES_DISABLED } = keys;
const { COMMITS_DISABLED, TASKS_DISABLED, DIFF_DISABLED, UNIT_DISABLED } = keys;
const { NPM_DISABLED } = keys;
const { diffGitDisabled, branchGitDisabled, commitGitDisabled } = keys;
const { entryHasDiff, lineHasDiff, withoutMoves } = keys;
const { CONFIRM, confirmPrefix, promptFromChoices } = keys;
const { THEME, paint, visibleWidth } = ansi;
const { truncateVisible, fg, RESET, EL, seq } = ansi;
const { paintPathText } = require('./search.js');
const { activeHit, spansFor, fileMatches } = require('../find.js');

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
  'transitive',
  'nothing to review',
  'nothing to commit',
  'not installed',
  'no plan',
  'returned',
  'stopped',
  'started',
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
const INFO_PREFIX = [
  'checked out ',
  'created ',
  'rebased onto ',
  'dropped ',
  'exit ',
  'model ',
];

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
  if (pane === 'agents') return view.agentView ? 'agents log' : 'agents';
  if (
    pane === 'dashboard' ||
    pane === 'repos' ||
    pane === 'branches' ||
    pane === 'npm' ||
    pane === 'packages' ||
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

const headerFind = (view, label, clipped) => {
  const query = view.find && view.find.query ? view.find.query : '';
  const target = headerTarget(view);
  if (!query || label !== target || !label) return [];
  const hit = activeHit(view.files ?? [], view.find);
  return spansFor(clipped, label, query, hit);
};

const paintHeaderRoles = (pieces) => {
  let out = `${seq(THEME.headerChromeFg, THEME.headerBg)}${EL}`;
  for (const piece of pieces) {
    out += `${fg(HEADER_ROLE_FG[piece.role])}${piece.text}`;
  }
  return out;
};

const paintHeaderHits = (clipped, spans, color) => {
  let out = '';
  let offset = 0;
  for (const seg of pathSegments(clipped)) {
    const local = [];
    const end = offset + seg.text.length;
    for (const span of spans) {
      const start = Math.max(span.start, offset);
      const stop = Math.min(span.end, end);
      if (start >= stop) continue;
      local.push({
        start: start - offset,
        end: stop - offset,
        on: span.on === true,
      });
    }
    const roleFg = HEADER_ROLE_FG[seg.role];
    out += paintPathText(seg.text, roleFg, THEME.headerBg, color, false, local);
    offset = end;
  }
  return out;
};

const paintHeader = (view, width, color) => {
  const { pieces, label } = headerLead(view);
  const right = ' ';
  const used = visibleWidth(piecesText(pieces)) + visibleWidth(right);
  const room = Math.max(0, width - used);
  const clipped = truncateVisible(label, room);
  const pad = ' '.repeat(Math.max(0, room - visibleWidth(clipped)));
  const spans = headerFind(view, label, clipped);
  if (!color || !spans.length) {
    pieces.push(...pathSegments(clipped));
    if (pad) pieces.push({ text: pad, role: 'chrome' });
    pieces.push({ text: right, role: 'chrome' });
    if (!color) return piecesText(pieces);
    return `${paintHeaderRoles(pieces)}${RESET}`;
  }
  let out = paintHeaderRoles(pieces);
  out += paintHeaderHits(clipped, spans, color);
  out += `${fg(HEADER_ROLE_FG.chrome)}${pad}${right}`;
  return `${out}${RESET}`;
};

const backFooterId = (view) =>
  view.pane === 'npm' && view.npmView ? 'npmStop' : 'back';

const backHintMark = () => BACK_ARROW;

const buttonGap = (index) => (index ? BUTTON_GAP : BUTTON_LEAD);

const hintBody = (mark) => `${mark}${BACK_KEY}`;

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

const footerIds = (hidden, extra, backId, globals, tail, after) => {
  const ids = backId ? [backId] : [];
  const push = (id) => {
    if (!ids.includes(id)) ids.push(id);
  };
  for (const add of extra) push(add);
  for (const id of globals) push(id);
  if (tail) {
    for (const id of ACTION_IDS) {
      if (id === 'quit' || hidden.includes(id) || ids.includes(id)) continue;
      ids.push(id);
    }
  }
  for (const id of after) push(id);
  return ids;
};

const buttonPiece = (id, index, short, backId, mark) => {
  const back = id === backId;
  const letter = back ? BACK_KEY : actionLetter(id);
  const label = back ? hintBody(mark) : buttonLabel(id, short);
  const gap = buttonGap(index);
  return {
    id,
    piece: `${gap}${label}`,
    gap,
    letter,
    label,
    back,
    mark: back ? mark : '',
  };
};

const packGroup = (ids, short, start, backId, mark) => {
  const parts = [];
  for (let i = 0; i < ids.length; i++) {
    parts.push(buttonPiece(ids[i], start + i, short, backId, mark));
  }
  return parts;
};

const groupWidth = (parts) => {
  let width = 0;
  for (const part of parts) width += visibleWidth(part.piece);
  return width;
};

const placeGroup = (parts, hits, disabled, x) => {
  const placed = [];
  let cursor = x;
  for (const part of parts) {
    const w = visibleWidth(part.piece);
    const off = disabled.includes(part.id);
    if (!off) hits.push({ id: part.id, x0: cursor, x1: cursor + w });
    placed.push({ ...part, disabled: off });
    cursor += w;
  }
  return { placed, cursor };
};

const splitFooter = (ids, options, limit) => {
  const { disabled = [], backId = '', mark = BACK_ARROW } = options;
  const { globals = [], after = [] } = options;
  const rightIds = [];
  for (const id of [...globals, ...after]) {
    if (ids.includes(id) && !rightIds.includes(id)) rightIds.push(id);
  }
  const leftIds = ids.filter((id) => !rightIds.includes(id));
  const pack = (leftShort, rightShort) => {
    const left = packGroup(leftIds, leftShort, 0, backId, mark);
    const start = left.length ? 1 : 0;
    const right = packGroup(rightIds, rightShort, start, backId, mark);
    return { left, right };
  };
  const wide = (packed) =>
    groupWidth(packed.left) + groupWidth(packed.right) > limit;
  let packed = pack(false, false);
  if (wide(packed)) packed = pack(false, true);
  if (wide(packed)) packed = pack(true, true);
  const left = packed.left.slice();
  const right = packed.right.slice();
  while (groupWidth(left) + groupWidth(right) > limit && left.length) {
    left.pop();
  }
  while (groupWidth(left) + groupWidth(right) > limit && right.length) {
    right.pop();
  }
  const hits = [];
  const leftPlace = placeGroup(left, hits, disabled, 0);
  const parts = leftPlace.placed;
  let x = leftPlace.cursor;
  const gap = Math.max(0, limit - x - groupWidth(right));
  if (gap && right.length) {
    parts.push({ spacer: true, piece: ' '.repeat(gap) });
    x += gap;
  }
  const rightPlace = placeGroup(right, hits, disabled, x);
  parts.push(...rightPlace.placed);
  return { hits, parts };
};

const layoutButtons = (width, options = {}) => {
  const { compact = false, hidden = [], extra = [], disabled = [] } = options;
  const { backId = '', mark = BACK_ARROW, globals = [] } = options;
  const { tail = true, after = [] } = options;
  const ids = footerIds(hidden, extra, backId, globals, tail, after);
  const limit = Math.max(0, width - BUTTON_EDGE);
  if (globals.length) return splitFooter(ids, options, limit);
  const build = (short) => {
    const hits = [];
    const parts = [];
    let x = 0;
    for (const id of ids) {
      const part = buttonPiece(id, parts.length, short, backId, mark);
      const w = visibleWidth(part.piece);
      if (x + w > limit && parts.length) break;
      const off = disabled.includes(id);
      if (!off) hits.push({ id, x0: x, x1: x + w });
      parts.push({ ...part, disabled: off });
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
    if (part.spacer) {
      out += paint(part.piece, fgRgb, bgRgb, color);
      used += visibleWidth(part.piece);
      continue;
    }
    const gap = part.gap ?? buttonGap(i);
    out += paint(gap, fgRgb, bgRgb, color);
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
  const done = counts.tasksDone ?? 0;
  const total = counts.tasks ?? 0;
  return `tasks ${done}/${total}`;
};

const statusLead = (view) => {
  if (view.pane === 'repos') {
    const tiles = view.repos && view.repos.tiles ? view.repos.tiles : [];
    const count = tiles.length;
    if (!count) return 'repos';
    const at = (view.repos.cursor ?? 0) + 1;
    return `${at}/${count}`;
  }
  if (view.pane === 'agents') {
    if (view.agentView) return view.agentStatus || 'log';
    const list = view.agents ?? [];
    let found = 0;
    for (const row of list) {
      if (row.bin) found += 1;
    }
    return `${found}/${list.length}`;
  }
  const counts = view.counts ?? {};
  const kind = countsKind(view.sourceKind, view.revShort);
  if (kind === 'worktree') return branchLabel(view.branch);
  if (kind === 'commit') {
    return `commit ${view.revShort}  ${counts.commit ?? 0}`;
  }
  const label = view.sourceLabel || kind;
  return `${kind} ${label}  ${counts.pr ?? 0}`;
};

const STATUS_QUIET = new Set(['npm', 'packages', 'branches', 'agents']);

const statusLeft = (view) => {
  if (view.pane === 'repos') return ` ${statusLead(view)}`;
  const notes = STATUS_QUIET.has(view.pane) ? '' : notesLine(view.counts ?? {});
  return ` ${joinStatus([statusLead(view), notes])}`;
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
  return `${plus}  ${minus}`;
};

const DIFF_QUIET = new Set(['npm', 'packages', 'tasks', 'branches', 'agents']);

const statusStats = (view) => {
  const counts = view.counts ?? {};
  const staged = counts.staged ?? 0;
  const total = fileTotals(view.files ?? []);
  const hasGit =
    total.remaining || total.staged || total.added || total.removed;
  const n = hasGit ? total.staged : staged;
  const m = hasGit ? total.remaining : staged + (counts.unstaged ?? 0);
  const delta = DIFF_QUIET.has(view.pane) ? '' : statusDelta(total);
  const ratio = STATUS_QUIET.has(view.pane) ? '' : `${n}/${m}`;
  const packages = view.pane === 'packages' ? npmStatus(view.packages) : '';
  return joinStatus([view.npmLogs, delta, ratio, packages]);
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

const paintFindStatus = (view, width, color) => {
  const query = view.find.query ?? '';
  const hits = fileMatches(view.files ?? [], query);
  const miss = query.length > 0 && hits.length === 0;
  const lead = ' /';
  const caret = 1;
  const room = Math.max(0, width - lead.length - caret);
  const shown = truncateVisible(query, room);
  const pad = Math.max(0, width - lead.length - visibleWidth(shown) - caret);
  if (!color) return `${lead}${shown}${' '.repeat(caret + pad)}`;
  const bgRgb = THEME.chromeBg;
  const tone = miss ? THEME.errorFg : THEME.chromeFg;
  let out = paint(lead, THEME.warnFg, bgRgb, color, true);
  out += paint(shown, tone, bgRgb, color);
  out += paint(' ', THEME.searchOnFg, THEME.searchOnBg, color);
  return out + fill(pad, THEME.mutedFg, bgRgb, color);
};

const paintStatusLine = (view, status, width, color) => {
  if (view.find) return paintFindStatus(view, width, color);
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
  if (view.find || CONFIRM[view.mode]) return null;
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
  if (pane === 'dashboard' || pane === 'repos') return DASH_HIDDEN;
  if (pane === 'files') return FILES_HIDDEN;
  if (pane === 'unit') return withHidden(UNIT_DISABLED, ['feedback', 'tasks']);
  if (pane === 'branches') return BRANCHES_DISABLED;
  if (pane === 'commits') return COMMITS_DISABLED;
  if (pane === 'npm') return NPM_DISABLED;
  if (pane === 'agents') return NPM_DISABLED;
  if (pane === 'tasks' || isTaskView(view)) {
    return withHidden(TASKS_DISABLED, ['prev', 'next']);
  }
  return withHidden(DIFF_DISABLED, ['feedback', 'tasks']);
};

const dimFooterActions = (view) => {
  const pane = view.pane ?? 'diff';
  if (pane === 'files') {
    const entry = selectedFile(view);
    if (isTasksEntry(entry)) return FILES_GIT_DISABLED;
    return withoutMoves([], entryHasDiff(entry));
  }
  if (pane === 'unit') {
    const off = [...diffGitDisabled(view.item)];
    const lines = view.unitLines;
    if (!lines || !lines.length) return off;
    const line = lines[view.unitLine ?? 0];
    return withoutMoves(off, lineHasDiff(line));
  }
  if (pane === 'diff') return diffGitDisabled(view.item);
  if (pane === 'branches') return branchGitDisabled(selectedBranch(view));
  if (pane === 'commits') {
    return commitGitDisabled({
      ...selectedCommit(view),
      canCommit: (view.counts?.staged ?? 0) > 0,
      unstagedCurrent: !view.rev && !view.revShort,
    });
  }
  if (pane === 'packages') {
    const listed = view.packages && view.packages.modules;
    const rows = listed && listed.packages ? listed.packages : [];
    const cursor = view.packagesCursor ?? 0;
    const onRow = rows.length > 0 && cursor < rows.length;
    if (!onRow) return ['packageDrop', 'packageWanted', 'packageLatest'];
    if (rows[cursor] && rows[cursor].transitive) {
      return ['packageNew', 'packageDrop'];
    }
    return [];
  }
  if (pane === 'agents') {
    if (view.agentView) return view.agentRunning ? [] : ['agentStop'];
    const list = view.agents ?? [];
    const row = list[view.agentCursor ?? 0];
    const off = [];
    if (!row || !row.login) off.push('agentLogin');
    const levels = row && row.efforts ? row.efforts : [];
    if (!row || !row.bin || levels.length < 2) off.push('agentEffort');
    if ((view.agentPlanCount ?? 0) < 2) off.push('agentReview');
    return off;
  }
  if (pane !== 'npm') return [];
  if (view.npmView) return view.npmRunning ? ['npmRerun'] : [];
  return view.npmLogs ? [] : ['npmLogs'];
};

const GIT_FOOTER = ['add', 'unstage', 'revert', 'ignore'];

const extraFooterActions = (view) => {
  const { pane } = view;
  if (pane === 'repos') return ['theme'];
  if (pane === 'dashboard') return ['theme', 'pull', 'push'];
  if (pane === 'unit') return ['add', 'unstage', 'revert', 'feedback', 'code'];
  if (pane === 'files') return [...GIT_FOOTER, 'code'];
  if (pane === 'diff') return [...GIT_FOOTER, 'feedback', 'code', 'layout'];
  if (pane === 'branches') {
    return ['newBranch', 'rebase', 'drop', 'pull', 'push'];
  }
  if (pane === 'commits') {
    return ['newCommit', 'apply', 'reword', 'drop', 'view', 'pull', 'push'];
  }
  if (pane === 'npm') {
    if (view.npmView) return ['npmVerbose', 'npmRerun'];
    return ['npmEdit', 'npmNew', 'npmDrop', 'npmLogs'];
  }
  if (pane === 'packages') {
    return ['packageNew', 'packageDrop', 'packageWanted', 'packageLatest'];
  }
  if (pane === 'agents') {
    if (view.agentView) return ['agentStop'];
    return [
      'agentModel',
      'agentEffort',
      'agentReview',
      'agentParams',
      'agentLogin',
      'agentStop',
    ];
  }
  if (pane === 'tasks' || isTaskView(view)) return ['drop', 'check'];
  return GIT_FOOTER;
};

const footerLayout = (view, width) =>
  layoutButtons(width, {
    hidden: hiddenActions(view),
    extra: extraFooterActions(view),
    disabled: dimFooterActions(view),
    backId: backFooterId(view),
    mark: backHintMark(view),
    globals: view.pane === 'repos' ? [] : DASH_IDS,
    tail: false,
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
