'use strict';

const ansi = require('../ansi.js');
const { TABLE_KEY, TABLE_VAL } = require('../npm-commands.js');
const { wrapPlain } = require('../wrap.js');
const { formatBusyStatus } = require('./chrome.js');
const { spinner } = require('./tiles.js');
const primitives = require('./primitives.js');

const { THEME, CODE_FG, paint, visibleWidth, truncateVisible } = ansi;
const { trimVisible, seq, EL, RESET, fg, hyperlink } = ansi;
const { clipAnsi, stripAnsi, foregroundOn } = ansi;
const { fill, MARK_W, markPrefix, editSpan } = primitives;
const { paneResult, paintCursorList, fieldWindow } = primitives;

const EDGE = 2;
const TAIL = 1;
const LOG_PAD_Y = 1;
const LOG_PAD_X = 2;
const NPM_NAME_MAX = 24;
const LOG_URL = /https?:\/\/[^\s<>"']+/g;

const TABLE_INK = {
  actual: THEME.errorFg,
  expected: THEME.addLineFg,
  code: THEME.shaFg,
  type: CODE_FG.className,
  count: THEME.warnFg,
  omitted: THEME.warnFg,
};

const COUNT_INK = {
  failed: THEME.errorFg,
  errors: THEME.errorFg,
  passed: THEME.addLineFg,
};

const logViewRows = (bodyH) => {
  const height = Math.max(1, bodyH);
  if (height >= LOG_PAD_Y * 2 + 1) return height - LOG_PAD_Y * 2;
  return height;
};

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

const panelFill = (width, color, bgRgb) => {
  const text = ' '.repeat(Math.max(0, width));
  if (!color) return text;
  return paint(text, THEME.chromeFg, bgRgb, color);
};

const leftFill = (width, color) => panelFill(width, color, THEME.buttonBg);

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

const logStart = (view, count, rows) => {
  const maxStart = Math.max(0, count - rows);
  const start = view.npmFollow ? maxStart : view.npmScroll;
  return Math.max(0, Math.min(start ?? 0, maxStart));
};

const isTableLine = (line) => `${line ?? ''}`.startsWith(TABLE_KEY);

const mixRgb = (from, to, part) =>
  from.map((value, i) => Math.round(value + (to[i] - value) * part));

const tableTone = (index) => {
  const lift = index % 2 === 0 ? 0.035 : 0.07;
  const valueBg = mixRgb(THEME.ctxBg, THEME.chromeFg, lift);
  const keyBg = mixRgb(THEME.ctxBg, THEME.chromeFg, lift + 0.025);
  const frame = mixRgb(THEME.ctxBg, THEME.chromeFg, lift * 0.4);
  return { valueBg, keyBg, frame };
};

const tableIndex = (lines, index) => {
  let row = 0;
  while (index - row > 0 && isTableLine(lines[index - row - 1])) row += 1;
  return row;
};

const tableInk = (key, value) => {
  const name = key.trim();
  if (Object.hasOwn(COUNT_INK, name)) {
    return Number(value) > 0 ? COUNT_INK[name] : THEME.mutedFg;
  }
  return Object.hasOwn(TABLE_INK, name) ? TABLE_INK[name] : THEME.chromeFg;
};

const tableParts = (line, width) => {
  const raw = line.slice(TABLE_KEY.length);
  const at = raw.indexOf(TABLE_VAL);
  const key = at < 0 ? raw : raw.slice(0, at);
  const rest = at < 0 ? '' : raw.slice(at + TABLE_VAL.length);
  const gap = rest.startsWith('  ') ? '  ' : '';
  const value = rest.slice(gap.length);
  const edge = Math.min(1, Math.floor(width / 2));
  const inner = Math.max(0, width - edge * 2);
  const keyW = Math.min(visibleWidth(key), inner);
  const gapW = Math.min(visibleWidth(gap), Math.max(0, inner - keyW));
  const valueW = Math.max(0, inner - keyW - gapW);
  return { key, gap, value, edge, keyW, gapW, valueW };
};

const wrapTableLine = (line, width) => {
  const part = tableParts(line, width);
  if (part.valueW < 1) return [line];
  const trimmed = part.value.trimEnd();
  const lead = trimmed.startsWith(' ') ? ' ' : '';
  const body = trimmed.slice(lead.length);
  const budget = Math.max(1, part.valueW - visibleWidth(lead));
  if (visibleWidth(body) <= budget) return [line];
  const blank = ' '.repeat(visibleWidth(part.key));
  return wrapPlain(body, budget).map((piece, index) => {
    const name = index === 0 ? part.key : blank;
    return `${TABLE_KEY}${name}${TABLE_VAL}${part.gap}${lead}${piece}`;
  });
};

const urlSpans = (text) => {
  const spans = [];
  for (const match of `${text ?? ''}`.matchAll(LOG_URL)) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      href: match[0],
    });
  }
  return spans;
};

const linkSlice = (text, start, end) => {
  let out = '';
  let at = start;
  for (const span of urlSpans(text)) {
    if (span.end <= start || span.start >= end) continue;
    const from = Math.max(start, span.start);
    const to = Math.min(end, span.end);
    out += text.slice(at, from);
    out += hyperlink(span.href, text.slice(from, to));
    at = to;
  }
  return out + text.slice(at, end);
};

const wrapLogText = (line, inner) => {
  const mark = line.startsWith('│ ') ? '│ ' : '';
  const rest = line.slice(mark.length);
  const budget = Math.max(1, inner - visibleWidth(mark));
  const rows = visibleWidth(rest) <= budget ? [rest] : wrapPlain(rest, budget);
  const out = [];
  let start = 0;
  for (const piece of rows) {
    const linked = linkSlice(rest, start, start + piece.length);
    out.push(`${mark}${linked}`);
    start += piece.length;
  }
  return out;
};

const expandLogLines = (text, width) => {
  const lines = `${text ?? ''}`.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const inner = Math.max(1, width - LOG_PAD_X * 2);
  return lines.flatMap((line) => {
    if (isTableLine(line)) return wrapTableLine(line, width);
    return wrapLogText(line, inner);
  });
};

const paintPlainTable = (line, width) => {
  const part = tableParts(line, width);
  const name = trimVisible(part.key, part.keyW);
  const namePad = ' '.repeat(Math.max(0, part.keyW - visibleWidth(name)));
  const shown = trimVisible(part.value, part.valueW);
  const pad = ' '.repeat(Math.max(0, part.valueW - visibleWidth(shown)));
  const edge = ' '.repeat(part.edge);
  const gap = part.gap.slice(0, part.gapW);
  return `${edge}${name}${namePad}${gap}${shown}${pad}${edge}`;
};

const paintTableLine = (line, width, index) => {
  const part = tableParts(line, width);
  const shownKey = trimVisible(part.key, part.keyW);
  const shown = trimVisible(part.value, part.valueW);
  const pad = ' '.repeat(Math.max(0, part.valueW - visibleWidth(shown)));
  const tone = tableTone(index);
  const ink = THEME.ctxFg;
  const valueFg = tableInk(part.key, part.value);
  let out = fill(part.edge, ink, tone.frame, true);
  out += paint(shownKey, ink, tone.keyBg, true);
  out += paint(part.gap.slice(0, part.gapW), ink, tone.frame, true);
  out += paint(`${shown}${pad}`, valueFg, tone.valueBg, true);
  return out + fill(part.edge, ink, tone.frame, true);
};

const paintLogSource = (line) => {
  if (line !== stripAnsi(line)) return line;
  if (/^[✖✔△] /.test(line)) {
    const ink = line[0] === '✔' ? THEME.addLineFg : THEME.errorFg;
    const color = line[0] === '△' ? THEME.warnFg : ink;
    return paint(line, color, THEME.ctxBg, true, true);
  }
  if (line.startsWith('│')) {
    return `${fg(THEME.shaFg)}│${fg(THEME.ctxFg)}${line.slice(1)}`;
  }
  if (/^(Stack|Related failures|Stderr)$/.test(line)) {
    return paint(line, THEME.chromeFg, THEME.ctxBg, true, true);
  }
  if (!/^\s+(at|↳)\s/.test(line)) return line;
  const source = line.replace(
    /([^\s()|]+)(:\d+:\d+)(?=[\s)|]|$)/g,
    (match, file, position) => {
      const path = `${fg(THEME.shaFg)}${file}`;
      const point = `${fg(THEME.mutedFg)}${position}`;
      return `${path}${point}${fg(THEME.ctxFg)}`;
    },
  );
  const frame = /^(\s+at\s+)(.*?)(\s+\(.+\))$/.exec(source);
  if (!frame) return source;
  return (
    `${fg(THEME.mutedFg)}${frame[1]}${fg(CODE_FG.function)}${frame[2]}` +
    `${fg(THEME.ctxFg)}${frame[3]}`
  );
};

const paintLogLine = (line, width, color, fgRgb = THEME.ctxFg) => {
  const inner = Math.max(1, width - LOG_PAD_X * 2);
  const lead = ' '.repeat(LOG_PAD_X);
  if (!color) {
    const body = truncateVisible(stripAnsi(line), inner);
    const pad = Math.max(0, width - LOG_PAD_X - visibleWidth(body));
    return `${lead}${body}${' '.repeat(pad)}`;
  }
  const source = paintLogSource(`${line ?? ''}`);
  const body = foregroundOn(clipAnsi(source, inner), THEME.ctxBg);
  const pad = Math.max(0, width - LOG_PAD_X - visibleWidth(body));
  const base = seq(fgRgb, THEME.ctxBg);
  let out = `${base}${EL}${lead}${body}`;
  if (pad) out += `${RESET}${base}${' '.repeat(pad)}`;
  return `${out}${RESET}`;
};

const paintLogRow = (view, lines, index, width, color) => {
  if (index < lines.length) {
    const line = lines[index];
    if (!isTableLine(line)) return paintLogLine(line, width, color);
    if (!color) return paintPlainTable(line, width);
    return paintTableLine(line, width, tableIndex(lines, index));
  }
  if (view.npmRunning === true && index === lines.length) {
    const label = formatBusyStatus('running', view.progressFrame ?? 0);
    return paintLogLine(label, width, color, THEME.chromeFg);
  }
  return fill(width, THEME.ctxFg, THEME.ctxBg, color);
};

const scrollThumb = (count, inner, start) => {
  if (count <= inner || inner < 1) return null;
  let size = Math.max(1, Math.round((inner * inner) / count));
  if (inner > 1) size = Math.min(size, inner - 1);
  const travel = inner - size;
  const maxStart = count - inner;
  const at = maxStart <= 0 ? 0 : Math.round((start * travel) / maxStart);
  return { size, travel, maxStart, at };
};

const scrollMark = (index, count, inner, start) => {
  const thumb = scrollThumb(count, inner, start);
  if (!thumb) return '';
  const end = thumb.at + thumb.size;
  if (index >= thumb.at && index < end) return 'thumb';
  return 'track';
};

const scrollAtThumb = (top, thumb) => {
  if (!thumb || thumb.travel <= 0) return 0;
  const at = Math.max(0, Math.min(top, thumb.travel));
  return Math.round((at * thumb.maxStart) / thumb.travel);
};

const paintScrollCell = (mark, color) => {
  const bgRgb = mark === 'thumb' ? THEME.taskHeadBg : THEME.buttonBg;
  return paint(' ', THEME.chromeFg, bgRgb, color);
};

const withLogScroller = (line, mark, width, color) => {
  const text = clipAnsi(line, Math.max(0, width - 1));
  return `${text}${paintScrollCell(mark, color)}`;
};

const paintNpmLog = (view, width, color, bodyH) => {
  const lines = expandLogLines(view.npmOutput ?? '', width);
  const count = lines.length + (view.npmRunning === true ? 1 : 0);
  const rows = logViewRows(bodyH);
  const padY = bodyH - rows;
  const top = padY ? 1 : 0;
  const start = logStart(view, count, rows);
  const blank = fill(width, THEME.ctxFg, THEME.ctxBg, color);
  const body = [];
  for (let i = 0; i < top; i++) body.push(blank);
  for (let i = 0; i < rows; i++) {
    body.push(paintLogRow(view, lines, start + i, width, color));
  }
  for (let i = 0; i < padY - top; i++) body.push(blank);
  const overflow = view.logScroller === true && color && count > rows;
  if (!overflow) return paneResult({ body });
  const barred = body.map((line, index) => {
    const at = index - top;
    const onText = at >= 0 && at < rows;
    const mark = onText ? scrollMark(at, count, rows, start) : 'track';
    return withLogScroller(line, mark, width, color);
  });
  const scrollBar = {
    col: width,
    row: 0,
    height: barred.length,
    track: top,
    rows,
    count,
    start,
  };
  return paneResult({ body: barred, scrollBar });
};

const HISTORY_SHARE = 0.7;
const ELLIPSIS = '…';

const sessionSplit = (width) => {
  const rightW = Math.max(1, Math.floor(width * HISTORY_SHARE));
  const leftW = Math.max(0, width - rightW);
  return { leftW, rightW };
};

const rightFill = (width, color) => panelFill(width, color, THEME.ctxBg);

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

const fitText = (text, width) => {
  const raw = `${text ?? ''}`;
  if (width <= 0) return '';
  if (visibleWidth(raw) <= width) return raw;
  if (width === 1) return ELLIPSIS;
  return `${truncateVisible(raw, width - 1)}${ELLIPSIS}`;
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
  const shown = fitText(text, width);
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
  const name = fitText(`${row.name ?? ''}`, nameW);
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
    const none = fitText('none', budget);
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

const spanHits = (hits, origin, width, side) => {
  const placed = [];
  for (const hit of hits) {
    const x0 = (hit.x0 ?? 0) + origin;
    const x1 = (hit.x1 ?? width) + origin;
    placed.push({ ...hit, x0, x1, side });
  }
  return placed;
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
    ...spanHits(left.fileHits, 0, leftW, 'commands'),
    ...spanHits(right.fileHits, leftW, rightW, 'runs'),
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

module.exports = {
  paintBodyNpm,
  logViewRows,
  expandLogLines,
  paintNpmLog,
  scrollThumb,
  scrollAtThumb,
  scrollMark,
  withLogScroller,
};
