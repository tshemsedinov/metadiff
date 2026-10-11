'use strict';

const ansi = require('../term/ansi.js');
const { spinner } = require('./tiles.js');
const primitives = require('./primitives.js');
const { scrollMark } = primitives;
const { placeHits } = primitives;
const { THEME, paint, visibleWidth } = ansi;
const { trimVisible, seq, EL } = ansi;
const { fill, MARK_W, markPrefix, editSpan } = primitives;
const { paneResult, paintCursorList, fieldWindow } = primitives;
const log = require('./log.js');
const { mixRgb, withLogScroller, paintNpmLog } = log;

const EDGE = 2;

const TAIL = 1;

const NPM_NAME_MAX = 24;

const npmNameWidth = (commands, typed = '') => {
  let width = visibleWidth(typed);
  for (const entry of commands) {
    width = Math.max(width, visibleWidth(`${entry.name ?? ''}`));
  }
  return Math.min(NPM_NAME_MAX, width);
};

const COMMAND_MIN = 8;

const npmColumns = (width, nameCol) => {
  const rest = Math.max(1, width - EDGE - TAIL - MARK_W);
  const gap = rest > 3 ? '  ' : '';
  const nameRoom = Math.max(1, rest - gap.length - COMMAND_MIN);
  const nameW = Math.min(nameCol, nameRoom);
  const detailW = Math.max(0, rest - nameW - gap.length);
  return { rest, nameW, gap, detailW };
};

const paintNpmLine = (cols, name, detail, color, selected, bin) => {
  const prefix = markPrefix(selected);
  const namePad = ' '.repeat(Math.max(0, cols.nameW - visibleWidth(name)));
  const mid = `${name}${namePad}`;
  const after = `${cols.gap}${detail}`;
  const pad = ' '.repeat(Math.max(0, cols.rest - visibleWidth(mid + after)));
  const tail = ' '.repeat(TAIL);
  const fgRgb = selected ? THEME.chromeFg : THEME.mutedFg;
  const bgRgb = selected ? THEME.checkBg : THEME.buttonBg;
  const edge = fill(EDGE, fgRgb, bgRgb, color);
  if (!color) return `${prefix}${mid}${after}${pad}${tail}${edge}`;
  const nameFg = bin ? THEME.shaFg : THEME.buttonHotFg;
  let out = `${seq(fgRgb, bgRgb)}${EL}`;
  out += paint(prefix, fgRgb, bgRgb, color);
  out += paint(mid, nameFg, bgRgb, color, !bin);
  out += paint(`${after}${pad}${tail}`, fgRgb, bgRgb, color);
  return out + edge;
};

const paintNpmRow = (entry, width, color, selected, nameCol) => {
  const cols = npmColumns(width, nameCol);
  const bin = entry.kind === 'bin';
  const name = trimVisible(entry.name, cols.nameW);
  const detail = trimVisible(bin ? 'bin' : entry.command, cols.detailW);
  return paintNpmLine(cols, name, detail, color, selected, bin);
};

const editingName = (view) => view.npmEditField !== 'command';

const editWindow = (compose, live, draft, width) => {
  const value = `${(live ? compose.text : draft) ?? ''}`.replaceAll('\n', ' ');
  const win = live
    ? fieldWindow(value, compose.cursor, compose.scrollCol, width)
    : fieldWindow(value, 0, 0, width);
  return { ...win, value };
};

const paintNpmEdit = (view, width, color, nameCol) => {
  const { compose } = view;
  const isName = editingName(view);
  const cols = npmColumns(width, nameCol);
  const { npmDraftName: draftName, npmDraftCommand: draftCommand } = view;
  const name = editWindow(compose, isName, draftName, cols.nameW);
  const command = editWindow(compose, !isName, draftCommand, cols.detailW);
  const row = paintNpmLine(cols, name.text, command.text, color, true, false);
  const nameX = MARK_W + 1;
  const commandX = nameX + cols.nameW + cols.gap.length;
  const active = isName ? name : command;
  const cursor = {
    x: (isName ? nameX : commandX) + active.col,
    scroll: active.scroll,
  };
  const edits = [
    {
      field: 'name',
      ...editSpan(1, nameX, commandX, 0, name.value),
      scroll: name.scroll,
      live: isName,
    },
    {
      field: 'command',
      ...editSpan(commandX, commandX, width + 1, 0, command.value),
      scroll: command.scroll,
      live: !isName,
    },
  ];
  return { row, cursor, edits };
};

const leftFill = (width, color) =>
  fill(width, THEME.chromeFg, THEME.buttonBg, color);

const paintNpmList = (view, width, color, bodyH, headerLines) => {
  const commands = view.npmCommands ?? [];
  const { compose } = view;
  const editing = compose?.kind === 'npm';
  const typed = editingName(view) ? compose?.text : view.npmDraftName;
  const nameW = npmNameWidth(commands, editing ? `${typed ?? ''}` : '');
  const cursor = view.npmCursor ?? 0;
  const pane = {
    width,
    color,
    bodyH,
    headerLines,
    offset: view.listScroll,
    blank: leftFill(width, color),
  };
  const onCommands = view.npmFocus !== 'runs';
  const paintRow = (entry, selected) =>
    paintNpmRow(entry, width, color, onCommands && selected, nameW);
  let extra = null;
  if (editing) {
    const painted = paintNpmEdit(view, width, color, nameW);
    const at = view.npmEditName ? 'replace' : 'end';
    extra = { ...painted, at, index: cursor };
  }
  return paintCursorList(commands, cursor, pane, paintRow, extra);
};

const HISTORY_SHARE = 0.7;

const sessionSplit = (width) => {
  const rightW = Math.max(1, Math.floor(width * HISTORY_SHARE));
  const leftW = Math.max(0, width - rightW);
  return { leftW, rightW };
};

const rightFill = (width, color) =>
  fill(width, THEME.chromeFg, THEME.ctxBg, color);

const HISTORY_HEADER = [
  'command',
  'done',
  'ok',
  'fail',
  'total',
  'duration',
  'time',
];

const HISTORY_ALIGN = ['l', 'r', 'r', 'r', 'r', 'r', 'r'];

const HISTORY_CAP = [0, 6, 6, 6, 8, 8, 14];

const HISTORY_FLEX = 0;

const HISTORY_PREFIX = ' ';

const HISTORY_TAIL = ' ';

const SELECT_LIFT = 0.45;

const WHITE = [0xff, 0xff, 0xff];

const historyTone = (name) => {
  if (name === 'add') return THEME.addLineFg;
  if (name === 'error') return THEME.errorFg;
  if (name === 'warn') return THEME.warnFg;
  if (name === 'text') return THEME.chromeFg;
  if (name === 'caption') return THEME.dashCaptionFg;
  return THEME.mutedFg;
};

const toneRgb = (name, selected) => {
  const base = historyTone(name);
  if (!selected || name === 'caption') return base;
  return mixRgb(base, WHITE, SELECT_LIFT);
};

const historyIcon = (row, frame) => {
  if (row.live || row.mark === 'run') {
    return { text: spinner(frame), tone: 'warn' };
  }
  if (row.mark === 'pass') return { text: '✔', tone: 'add' };
  if (row.mark === 'stop') return { text: '⊘', tone: 'muted' };
  if (row.mark === 'fail') return { text: '✖', tone: 'error' };
  return { text: '?', tone: 'muted' };
};

const commandLabel = (row, frame) => {
  const icon = historyIcon(row, frame).text;
  const name = `${row.name ?? ''}`;
  if (!name) return icon;
  return `${icon} ${name}`;
};

const historyCells = (row, frame) => [
  commandLabel(row, frame),
  `${row.done ?? ''}`,
  `${row.ok ?? ''}`,
  `${row.fail ?? ''}`,
  `${row.total ?? ''}`,
  `${row.elapsed ?? ''}`,
  `${row.when ?? ''}`,
];

const columnWants = (rows, frame) => {
  const want = HISTORY_HEADER.map((label) => visibleWidth(label));
  for (const row of rows) {
    if (row.empty) continue;
    const cells = historyCells(row, frame);
    for (let i = 0; i < cells.length; i++) {
      const seen = visibleWidth(cells[i]);
      const cap = HISTORY_CAP[i];
      const width = i === HISTORY_FLEX || !cap ? seen : Math.min(cap, seen);
      want[i] = Math.max(want[i], width);
    }
  }
  return want;
};

const fitColumns = (want, budget) => {
  const gaps = Math.max(0, want.length - 1);
  let fixed = 0;
  for (let i = 0; i < want.length; i++) {
    if (i !== HISTORY_FLEX) fixed += want[i];
  }
  const room = budget - gaps - fixed;
  if (room >= 1) {
    const widths = want.slice();
    widths[HISTORY_FLEX] = room;
    return widths;
  }
  const widths = want.slice();
  widths[HISTORY_FLEX] = 1;
  let extra = 1 + fixed + gaps - budget;
  for (let index = widths.length - 1; index >= 0 && extra > 0; index--) {
    if (index === HISTORY_FLEX) continue;
    const drop = Math.min(extra, widths[index]);
    widths[index] -= drop;
    extra -= drop;
  }
  return widths;
};

const historyWidths = (rows, budget, frame) =>
  fitColumns(columnWants(rows, frame), budget);

const alignCell = (text, width, align) => {
  const shown = trimVisible(`${text ?? ''}`, width);
  const pad = ' '.repeat(Math.max(0, width - visibleWidth(shown)));
  return align === 'r' ? `${pad}${shown}` : `${shown}${pad}`;
};

const cellTone = (row, index, statusTone) => {
  if (index === 1) return 'text';
  if (index === 2) return row.okN ? 'add' : 'muted';
  if (index === 3) return row.failN ? 'error' : 'muted';
  if (index === 4) return row.exitLabel ? statusTone : 'text';
  if (index === 5 && row.live) return 'warn';
  return 'muted';
};

const paintPiece = (text, tone, bg, color, selected) => {
  if (!color || text === '') return text;
  return paint(text, toneRgb(tone, selected), bg, true);
};

const paintCommand = (row, frame, width, bg, color, selected) => {
  const icon = historyIcon(row, frame);
  if (width <= 0) return '';
  if (width === 1) return paintPiece(icon.text, icon.tone, bg, color, selected);
  const lead = `${icon.text} `;
  const nameW = Math.max(0, width - visibleWidth(lead));
  const name = trimVisible(`${row.name ?? ''}`, nameW);
  const pad = ' '.repeat(Math.max(0, nameW - visibleWidth(name)));
  const nameTone = selected ? icon.tone : 'text';
  const mark = paintPiece(lead, icon.tone, bg, color, selected);
  const label = paintPiece(`${name}${pad}`, nameTone, bg, color, selected);
  return `${mark}${label}`;
};

const historyParts = (cells, widths, tones, bg, color, selected, command) => {
  const parts = [];
  for (let i = 0; i < cells.length; i++) {
    if (!widths[i]) continue;
    if (i === 0 && command) {
      parts.push(command);
      continue;
    }
    const shown = alignCell(cells[i], widths[i], HISTORY_ALIGN[i]);
    parts.push(paintPiece(shown, tones[i], bg, color, selected));
  }
  const gap = paintPiece(' ', 'muted', bg, color, selected);
  return parts.join(gap);
};

const historyLine = (row, widths, color, selected, frame) => {
  const gaps = Math.max(0, widths.filter((n) => n > 0).length - 1);
  const budget = widths.reduce((sum, n) => sum + n, 0) + gaps;
  const bg = selected ? THEME.checkBg : THEME.ctxBg;
  if (row.empty) {
    const none = trimVisible('none', budget);
    return paintPiece(none, 'muted', bg, color, selected);
  }
  const status = historyIcon(row, frame).tone;
  const cells = historyCells(row, frame);
  const tones = cells.map((_, index) => cellTone(row, index, status));
  const command = paintCommand(row, frame, widths[0] ?? 0, bg, color, selected);
  return historyParts(cells, widths, tones, bg, color, selected, command);
};

const paintHistoryLine = (mid, width, color, bg) => {
  const prefix = HISTORY_PREFIX;
  const tail = HISTORY_TAIL;
  const budget = Math.max(0, width - prefix.length - tail.length);
  const pad = ' '.repeat(Math.max(0, budget - visibleWidth(mid)));
  if (!color) return `${prefix}${mid}${pad}${tail}`;
  const edge = paintPiece(prefix, 'muted', bg, true, false);
  const rest = paintPiece(`${pad}${tail}`, 'muted', bg, true, false);
  return `${edge}${mid}${rest}`;
};

const paintSessionRow = (row, width, color, selected, widths, frame) => {
  const bg = selected ? THEME.checkBg : THEME.ctxBg;
  const mid = historyLine(row, widths, color, selected, frame);
  const line = paintHistoryLine(mid, width, color, bg);
  return { row: line, hit: !row.empty };
};

const paintColumnHeader = (widths, width, color) => {
  const bg = THEME.ctxBg;
  const tones = HISTORY_HEADER.map(() => 'caption');
  const mid = historyParts(HISTORY_HEADER, widths, tones, bg, color, false);
  return paintHistoryLine(mid, width, color, bg);
};

const joinNpm = (left, right, width, color, bodyH) => {
  const { leftW, rightW } = sessionSplit(width);
  const blankL = leftFill(leftW, color);
  const blankR = rightFill(rightW, color);
  const count = Math.max(left.body.length, right.body.length, bodyH);
  const body = [];
  for (let i = 0; i < count; i++) {
    const sideL = left.body[i] ?? blankL;
    const sideR = right.body[i] ?? blankR;
    body.push(`${sideL}${sideR}`);
  }
  const fileHits = [
    ...placeHits(left.fileHits, 0, leftW, 'commands'),
    ...placeHits(right.fileHits, leftW, rightW, 'runs'),
  ];
  return paneResult({
    body,
    fileHits,
    editHits: left.editHits,
    cursor: left.cursor,
    listScroll: left.listScroll,
  });
};

const historyHead = (header, width, color, bodyH) => {
  const blank = rightFill(width, color);
  const lines = [blank, header || blank, blank];
  return lines.slice(0, bodyH);
};

const historyBar = (lines, count, start, width, fullWidth, color, head) => {
  const rows = lines.length;
  const barred = lines.map((line, index) => {
    const mark = scrollMark(index, count, rows, start);
    return withLogScroller(line, mark, width, color);
  });
  const scrollBar = {
    col: fullWidth,
    row: head,
    height: rows,
    track: 0,
    rows,
    count,
    start,
  };
  return { body: barred, scrollBar };
};

const paintNpmSessions = (
  view,
  width,
  color,
  bodyH,
  headerLines,
  fullWidth,
) => {
  const runs = view.npmRuns ?? [];
  const frame = view.progressFrame ?? 0;
  const listRoom = Math.max(0, bodyH - 3);
  const overflow = runs.length > listRoom && listRoom > 0;
  const inner = overflow ? Math.max(1, width - 1) : width;
  const edge = HISTORY_PREFIX.length + HISTORY_TAIL.length;
  const budget = Math.max(0, inner - edge);
  const widths = historyWidths(runs, budget, frame);
  const header = paintColumnHeader(widths, inner, color);
  const pad = rightFill(width - inner, color);
  const padded = overflow ? `${header}${pad}` : header;
  const head = historyHead(padded, width, color, bodyH);
  const listH = Math.max(0, bodyH - head.length);
  const rows = runs.length ? runs : [{ empty: true }];
  const cursor = view.npmRunCursor ?? 0;
  const onRuns = view.npmFocus === 'runs';
  const paintRun = (entry, selected) =>
    paintSessionRow(entry, inner, color, onRuns && selected, widths, frame);
  const painted = paintCursorList(
    rows,
    cursor,
    {
      width: inner,
      color,
      bodyH: listH,
      headerLines: headerLines + head.length,
      offset: view.npmRunScroll ?? 0,
      blank: rightFill(inner, color),
      pad: 0,
    },
    paintRun,
  );
  const list = painted.body.slice();
  while (list.length < listH) list.push(rightFill(inner, color));
  const scrolled = overflow
    ? historyBar(
        list,
        runs.length,
        painted.listScroll,
        width,
        fullWidth,
        color,
        head.length,
      )
    : { body: list, scrollBar: null };
  return {
    body: [...head, ...scrolled.body].slice(0, bodyH),
    fileHits: painted.fileHits,
    listScroll: painted.listScroll,
    scrollBar: scrolled.scrollBar,
  };
};

const paintBodyNpm = (view, width, color, bodyH, headerLines) => {
  if (view.npmView) return paintNpmLog(view, width, color, bodyH);
  const { leftW, rightW } = sessionSplit(width);
  const left = paintNpmList(view, leftW, color, bodyH, headerLines);
  const right = paintNpmSessions(
    view,
    rightW,
    color,
    bodyH,
    headerLines,
    width,
  );
  const joined = joinNpm(left, right, width, color, bodyH);
  joined.runScroll = right.listScroll;
  if (right.scrollBar) joined.scrollBar = right.scrollBar;
  return joined;
};

module.exports = { paintBodyNpm };
