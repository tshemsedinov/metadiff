'use strict';

const ansi = require('../ansi.js');
const files = require('../files.js');
const primitives = require('./primitives.js');
const { shortAge } = files;
const { measureColumns, padColumns, joinColumns, paintColumns } = primitives;

const { THEME, paint, visibleWidth, truncateVisible, seq, EL } = ansi;
const { FILE_MARK } = primitives;
const { paintCursorList, paintListEdit } = primitives;
const { branchLabel } = primitives;

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
  sha: THEME.shaDarkFg,
  date: THEME.headerFg,
};

const BRANCH_NAME_MAX = 24;
const BRANCH_TAIL = 1;
const branchNameChip = (entry, rowBg) => {
  if (entry.current) {
    return {
      nameFg: THEME.mutedFg,
      nameBg: THEME.currentBg,
      nameBold: false,
    };
  }
  if (entry.isDefault) {
    return {
      nameFg: THEME.warnFg,
      nameBg: rowBg,
      nameBold: true,
    };
  }
  return {
    nameFg: THEME.buttonHotFg,
    nameBg: rowBg,
    nameBold: false,
  };
};

const branchRowFg = (entry, selected) => {
  if (selected) return THEME.chromeFg;
  return THEME.mutedFg;
};

const branchRowFields = (entry) => {
  const sha = entry.sha ?? '';
  const date = shortAge(entry.date ?? '');
  const gone = entry.gone ? 'gone' : '';
  const ahead = entry.ahead ? `⇡${entry.ahead}` : '';
  const behind = entry.behind ? `⇣${entry.behind}` : '';
  return { sha, ahead, behind, gone, date };
};

const branchRowBg = (entry, selected) => {
  if (entry.current) return THEME.currentBg;
  if (selected) return THEME.buttonBg;
  return THEME.ctxBg;
};

const paintBranchRow = (entry, width, color, selected, cols) => {
  const inner = Math.max(1, width - BRANCH_TAIL);
  const mark = selected ? FILE_MARK : ' ';
  const prefix = ` ${mark} `;
  const parts = padColumns(branchRowFields(entry), cols, BRANCH_COL_ALIGN);
  const suffix = joinColumns(parts, cols);
  const rest = Math.max(1, inner - visibleWidth(prefix + suffix));
  const nameW = Math.min(cols.name, rest);
  const label = truncateVisible(branchLabel(entry.name), nameW);
  const namePad = Math.max(0, nameW - visibleWidth(label));
  const canSubject = rest >= nameW + 3;
  const gap = canSubject ? '  ' : '';
  const subjectW = canSubject ? rest - nameW - visibleWidth(gap) : 0;
  const subject = truncateVisible(entry.subject ?? '', subjectW);
  const mid = `${label}${' '.repeat(namePad)}${gap}${subject}`;
  const pad = Math.max(0, rest - visibleWidth(mid));
  const after = `${' '.repeat(namePad)}${gap}${subject}${' '.repeat(pad)}`;
  const left = `${prefix}${label}${after}`;
  const fgRgb = branchRowFg(entry, selected);
  const rowBg = branchRowBg(entry, selected);
  const chip = branchNameChip(entry, rowBg);
  const toneFg = entry.current ? THEME.headerFg : fgRgb;
  const tail = ' '.repeat(BRANCH_TAIL);
  if (!color) return `${left}${suffix}${tail}`;
  let out = `${seq(toneFg, rowBg)}${EL}`;
  out += paint(prefix, toneFg, rowBg, color);
  out += paint(label, chip.nameFg, chip.nameBg, color, chip.nameBold);
  out += paint(after, toneFg, rowBg, color);
  const tones = entry.current
    ? { ...BRANCH_COL_FG, ...BRANCH_CURRENT_COL_FG }
    : BRANCH_COL_FG;
  out += paintColumns(parts, cols, toneFg, rowBg, color, tones);
  out += paint(tail, toneFg, rowBg, color);
  return out;
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
  const compose = view.compose;
  const editing = compose && compose.kind === 'branch';
  const tail = editing ? paintListEdit(compose, width, color) : null;
  const paintRow = (entry, rowWidth, rowColor, selected) =>
    paintBranchRow(entry, rowWidth, rowColor, selected, cols);
  return paintCursorList(
    branches,
    cursor,
    width,
    color,
    bodyH,
    headerLines,
    paintRow,
    tail,
    view.listScroll,
  );
};

module.exports = { paintBodyBranches };
