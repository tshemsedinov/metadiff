'use strict';

const ansi = require('../ansi.js');
const { shortAge } = require('../files.js');
const primitives = require('./primitives.js');

const { THEME, paint, visibleWidth, trimVisible, seq, EL } = ansi;
const { MARK_W, markPrefix, branchLabel, editSpan } = primitives;
const { paintCursorList, fieldWindow } = primitives;
const { measureColumns, padColumns, joinColumns, paintColumns } = primitives;

const BRANCH_COL_ALIGN = {
  sha: 'end',
  ahead: 'start',
  behind: 'start',
  gone: 'end',
  date: 'start',
};

const BRANCH_COL_FG = {
  sha: THEME.shaFg,
  ahead: THEME.addLineFg,
  behind: THEME.delLineFg,
  gone: THEME.delLineFg,
  date: THEME.mutedFg,
};

const BRANCH_CURRENT_COL_FG = {
  ...BRANCH_COL_FG,
  sha: THEME.shaDarkFg,
  date: THEME.headerFg,
};

const BRANCH_NAME_MAX = 24;
const BRANCH_TAIL = 1;

const branchNameChip = (entry, rowBg) => {
  if (entry.current) {
    return { nameFg: THEME.mutedFg, nameBg: THEME.currentBg, nameBold: false };
  }
  if (entry.isDefault) {
    return { nameFg: THEME.warnFg, nameBg: rowBg, nameBold: true };
  }
  return { nameFg: THEME.buttonHotFg, nameBg: rowBg, nameBold: false };
};

const branchRowFields = (entry) => ({
  sha: entry.sha ?? '',
  ahead: entry.ahead ? `⇡${entry.ahead}` : '',
  behind: entry.behind ? `⇣${entry.behind}` : '',
  gone: entry.gone ? 'gone' : '',
  date: shortAge(entry.date),
});

const branchRowFg = (entry, selected) => {
  if (entry.current) return THEME.headerFg;
  return selected ? THEME.chromeFg : THEME.mutedFg;
};

const branchRowBg = (entry, selected) => {
  if (entry.current) return THEME.currentBg;
  return selected ? THEME.buttonBg : THEME.ctxBg;
};

const paintBranchRow = (entry, width, color, selected, cols) => {
  const inner = Math.max(1, width - BRANCH_TAIL);
  const prefix = markPrefix(selected);
  const parts = padColumns(branchRowFields(entry), cols, BRANCH_COL_ALIGN);
  const suffix = joinColumns(parts, cols);
  const rest = Math.max(1, inner - visibleWidth(prefix + suffix));
  const nameW = Math.min(cols.name, rest);
  const label = trimVisible(branchLabel(entry.name), nameW);
  const namePad = ' '.repeat(Math.max(0, nameW - visibleWidth(label)));
  const canSubject = rest >= nameW + 3;
  const gap = canSubject ? '  ' : '';
  const subjectW = canSubject ? rest - nameW - gap.length : 0;
  const subject = trimVisible(entry.subject ?? '', subjectW);
  const mid = `${label}${namePad}${gap}${subject}`;
  const pad = ' '.repeat(Math.max(0, rest - visibleWidth(mid)));
  const after = `${namePad}${gap}${subject}${pad}`;
  const tail = ' '.repeat(BRANCH_TAIL);
  if (!color) return `${prefix}${label}${after}${suffix}${tail}`;
  const fgRgb = branchRowFg(entry, selected);
  const bgRgb = branchRowBg(entry, selected);
  const chip = branchNameChip(entry, bgRgb);
  const tones = entry.current ? BRANCH_CURRENT_COL_FG : BRANCH_COL_FG;
  let out = `${seq(fgRgb, bgRgb)}${EL}`;
  out += paint(prefix, fgRgb, bgRgb, color);
  out += paint(label, chip.nameFg, chip.nameBg, color, chip.nameBold);
  out += paint(after, fgRgb, bgRgb, color);
  out += paintColumns(parts, cols, fgRgb, bgRgb, color, tones);
  return out + paint(tail, fgRgb, bgRgb, color);
};

const paintBranchEdit = (compose, width, color) => {
  const prefix = markPrefix(true);
  const rest = Math.max(1, width - MARK_W);
  const text = `${compose.text ?? ''}`.replaceAll('\n', ' ');
  const win = fieldWindow(text, compose.cursor, compose.scrollCol, rest);
  const gap = ' '.repeat(Math.max(0, rest - visibleWidth(win.text)));
  const fgRgb = THEME.chromeFg;
  const bgRgb = THEME.buttonBg;
  let row = `${prefix}${win.text}${gap}`;
  if (color) {
    row = `${seq(fgRgb, bgRgb)}${EL}`;
    row += paint(prefix, fgRgb, bgRgb, color);
    row += paint(win.text, THEME.buttonHotFg, bgRgb, color);
    row += paint(gap, fgRgb, bgRgb, color);
  }
  const textX = MARK_W + 1;
  const edit = editSpan(1, textX, textX + rest, 0, text);
  const cursor = { x: textX + win.col, scroll: win.scroll };
  return { row, cursor, edits: [{ ...edit, scroll: win.scroll }] };
};

const paintBodyBranches = (view, width, color, bodyH, headerLines) => {
  const branches = view.branches ?? [];
  const cols = measureColumns(branches, branchRowFields, BRANCH_COL_ALIGN);
  cols.name = 0;
  for (const entry of branches) {
    cols.name = Math.max(cols.name, visibleWidth(branchLabel(entry.name)));
  }
  cols.name = Math.min(BRANCH_NAME_MAX, cols.name);
  const cursor = view.branchCursor ?? 0;
  const { compose } = view;
  const edit =
    compose?.kind === 'branch' ? paintBranchEdit(compose, width, color) : null;
  const pane = { width, color, bodyH, headerLines, offset: view.listScroll };
  const paintRow = (entry, selected) =>
    paintBranchRow(entry, width, color, selected, cols);
  return paintCursorList(branches, cursor, pane, paintRow, edit);
};

module.exports = { paintBodyBranches };
