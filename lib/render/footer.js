'use strict';

const ansi = require('../term/ansi.js');
const actions = require('../input/actions.js');
const files = require('../common/files.js');
const primitives = require('./primitives.js');
const { fill, isTaskView } = primitives;
const { isTasksEntry } = files;
const { ACTION_IDS, actionLetter } = actions;
const { DASH_IDS, buttonWord } = actions;
const { FILES_GIT_DISABLED } = actions;
const { diffGitDisabled, branchGitDisabled, commitGitDisabled } = actions;
const { entryHasDiff, lineHasDiff, withoutMoves } = actions;
const { THEME, paint, visibleWidth } = ansi;
const { selectedFile, selectedBranch, selectedCommit } = require('./header.js');

const BUTTON_LEAD = ' ';

const BUTTON_GAP = '  ';

const HINT_ONLY = new Set(['taskNudge']);

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

const SAVE_HINT = 'Press **Ctrl-S** or **Enter** at EOF to save';

const HINT_HOT_FG = 0xff;

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
    const hint = HINT_ONLY.has(part.id);
    if (!off && !hint) hits.push({ id: part.id, x0: cursor, x1: cursor + w });
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
      const hint = HINT_ONLY.has(id);
      if (!off && !hint) hits.push({ id, x0: x, x1: x + w });
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
    if (view.agentView) {
      return view.agentRunning ? ['agentRerun'] : ['agentStop'];
    }
    const list = view.agents ?? [];
    const row = list[view.agentCursor ?? 0];
    const off = [];
    const levels = row && row.efforts ? row.efforts : [];
    if (!row || !row.bin || levels.length < 2) off.push('agentEffort');
    if (!row || !row.bin) off.push('agentFast');
    const sizes = row && row.contexts ? row.contexts : [];
    if (!row || !row.bin || !sizes.length) off.push('agentContext');
    if ((view.agentPlanCount ?? 0) < 2) off.push('agentReview');
    return off;
  }
  if (pane !== 'npm') return [];
  if (view.npmView) return view.npmRunning ? [] : ['npmStop'];
  return view.npmLogs ? [] : ['npmLogs'];
};

const GIT_FOOTER = ['add', 'unstage', 'revert', 'ignore'];

const extraFooterActions = (view) => {
  const { pane } = view;
  if (pane === 'repos') return ['theme'];
  if (pane === 'dashboard') return ['theme', 'pull', 'push'];
  if (pane === 'unit') {
    return ['add', 'unstage', 'revert', 'feedback', 'code', 'lines'];
  }
  if (pane === 'files') return [...GIT_FOOTER, 'code'];
  if (pane === 'diff') {
    return [...GIT_FOOTER, 'feedback', 'code', 'layout', 'lines'];
  }
  if (pane === 'branches') {
    return ['newBranch', 'rebase', 'drop', 'pull', 'push'];
  }
  if (pane === 'commits') {
    return ['newCommit', 'apply', 'reword', 'drop', 'view', 'pull', 'push'];
  }
  if (pane === 'npm') {
    if (view.npmView) return ['npmVerbose', 'npmStop', 'npmRerun'];
    return ['npmEdit', 'npmNew', 'npmDrop', 'npmLogs'];
  }
  if (pane === 'packages') {
    return ['packageNew', 'packageDrop', 'packageWanted', 'packageLatest'];
  }
  if (pane === 'agents') {
    if (view.agentView) return ['agentStop', 'agentRerun'];
    return [
      'agentModel',
      'agentEffort',
      'agentFast',
      'agentContext',
      'agentReview',
    ];
  }
  if (pane === 'tasks' || isTaskView(view)) {
    return ['plan', 'import', 'drop', 'check', 'taskNudge'];
  }
  return GIT_FOOTER;
};

const footerLayout = (view, width) =>
  layoutButtons(width, {
    extra: extraFooterActions(view),
    disabled: dimFooterActions(view),
    backId: 'back',
    globals: view.pane === 'repos' ? [] : DASH_IDS,
    tail: false,
  });

module.exports = {
  QUIT_MARK,
  paintMarkedWord,
  layoutButtons,
  paintFooter,
  footerHits,
  footerLayout,
};
