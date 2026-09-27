'use strict';

const ansi = require('../ansi.js');
const chrome = require('./chrome.js');
const primitives = require('./primitives.js');
const npmCommands = require('../npm-commands.js');

const { THEME, paint, visibleWidth, truncateVisible, seq, EL } = ansi;
const { clipAnsi, stripAnsi, RESET, foregroundOn } = ansi;
const { formatBusyStatus } = chrome;
const { TABLE_KEY, TABLE_VAL } = npmCommands;
const { fill, FILE_MARK, paneResult, paintCursorList } = primitives;
const { paintListEdit } = primitives;

const EDGE = 2;
const TAIL = 1;
const LOG_PAD_Y = 1;
const LOG_PAD_X = 2;
const NPM_NAME_MAX = 24;

const logViewRows = (bodyH) => {
  const height = Math.max(1, bodyH);
  if (height >= LOG_PAD_Y * 2 + 1) return height - LOG_PAD_Y * 2;
  return height;
};

const rowFg = (selected) => (selected ? THEME.chromeFg : THEME.mutedFg);

const npmNameWidth = (commands) => {
  let width = 0;
  for (const entry of commands) {
    width = Math.max(width, visibleWidth(`${entry.name ?? ''}`));
  }
  return Math.min(NPM_NAME_MAX, width);
};

const paintNpmRow = (entry, width, color, selected, nameCol = 0) => {
  const inner = Math.max(1, width - EDGE - TAIL);
  const mark = selected ? FILE_MARK : ' ';
  const prefix = ` ${mark} `;
  const prefixW = visibleWidth(prefix);
  const rest = Math.max(1, inner - prefixW);
  const detail = entry.kind === 'bin' ? 'bin' : entry.command;
  const nameW = Math.min(Math.max(0, nameCol), rest);
  const name = truncateVisible(entry.name, nameW);
  const gap = rest > nameW + 2 ? '  ' : '';
  const detailW = Math.max(0, rest - nameW - visibleWidth(gap));
  const shown = truncateVisible(detail, detailW);
  const mid = `${name}${' '.repeat(Math.max(0, nameW - visibleWidth(name)))}`;
  const after = `${gap}${shown}`;
  const pad = Math.max(0, rest - visibleWidth(mid + after));
  const left = `${prefix}${mid}${after}${' '.repeat(pad)}`;
  const fgRgb = rowFg(selected);
  const bgRgb = selected ? THEME.buttonBg : THEME.ctxBg;
  const tail = ' '.repeat(TAIL);
  const edge = fill(EDGE, fgRgb, THEME.ctxBg, color);
  if (!color) return `${left}${tail}${edge}`;
  let out = `${seq(fgRgb, bgRgb)}${EL}`;
  out += paint(prefix, fgRgb, bgRgb, color);
  const bin = entry.kind === 'bin';
  const nameFg = bin ? THEME.shaFg : THEME.buttonHotFg;
  out += paint(mid, nameFg, bgRgb, color, !bin);
  out += paint(`${after}${' '.repeat(pad)}${tail}`, fgRgb, bgRgb, color);
  return out + edge;
};

const paintNpmList = (view, width, color, bodyH, headerLines) => {
  const commands = view.npmCommands ?? [];
  const nameW = npmNameWidth(commands);
  const cursor = view.npmCursor ?? 0;
  const compose = view.compose;
  const editing = compose && compose.kind === 'npm';
  const paintRow = (entry, rowWidth, rowColor, selected) =>
    paintNpmRow(entry, rowWidth, rowColor, selected, nameW);
  let extra = null;
  if (editing) {
    const painted = paintListEdit(compose, width, color, EDGE);
    const at = view.npmEditName ? 'replace' : 'end';
    extra = { row: painted.row, cursor: painted.cursor, at, index: cursor };
  }
  return paintCursorList(
    commands,
    cursor,
    width,
    color,
    bodyH,
    headerLines,
    paintRow,
    extra,
    view.listScroll,
  );
};

const logStart = (view, count, rows) => {
  const maxStart = Math.max(0, count - rows);
  let start = maxStart;
  if (!view.npmFollow) start = view.npmScroll ?? 0;
  if (start > maxStart) start = maxStart;
  if (start < 0) start = 0;
  return start;
};

const isTableLine = (line) => `${line ?? ''}`.startsWith(TABLE_KEY);

const mixRgb = (from, to, part) => {
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const next = from[i] + (to[i] - from[i]) * part;
    out[i] = Math.round(next);
  }
  return out;
};

const tableTone = (index) => {
  const lift = index % 2 === 0 ? 0.035 : 0.07;
  const valueBg = mixRgb(THEME.ctxBg, THEME.chromeFg, lift);
  const keyBg = mixRgb(THEME.ctxBg, THEME.chromeFg, lift + 0.025);
  const frame = mixRgb(THEME.ctxBg, THEME.chromeFg, lift * 0.4);
  return { valueBg, keyBg, frame };
};

const tableIndex = (lines, index) => {
  let at = index;
  let row = 0;
  while (at > 0 && isTableLine(lines[at - 1])) {
    at -= 1;
    row += 1;
  }
  return row;
};

const paintTableLine = (line, width, index) => {
  const raw = line.slice(TABLE_KEY.length);
  const at = raw.indexOf(TABLE_VAL);
  const key = at < 0 ? raw : raw.slice(0, at);
  const rest = at < 0 ? '' : raw.slice(at + TABLE_VAL.length);
  const gap = rest.startsWith('  ') ? '  ' : '';
  const value = rest.slice(gap.length);
  const edge = 1;
  const inner = Math.max(1, width - edge * 2);
  const keyW = visibleWidth(key);
  const gapW = visibleWidth(gap);
  const valueW = Math.max(0, inner - keyW - gapW);
  const shown = truncateVisible(value, valueW);
  const pad = ' '.repeat(Math.max(0, valueW - visibleWidth(shown)));
  const tone = tableTone(index);
  const ink = THEME.ctxFg;
  let out = fill(edge, ink, tone.frame, true);
  out += paint(key, ink, tone.keyBg, true);
  out += paint(gap, ink, tone.frame, true);
  out += paint(`${shown}${pad}`, ink, tone.valueBg, true);
  return `${out}${fill(edge, ink, tone.frame, true)}`;
};

const paintLogLine = (line, width, color, fgRgb = THEME.ctxFg) => {
  const inner = Math.max(1, width - LOG_PAD_X * 2);
  const source = color ? `${line ?? ''}` : stripAnsi(line);
  const clip = (value) =>
    color ? clipAnsi(value, inner) : truncateVisible(value, inner);
  const body = color ? foregroundOn(clip(source), THEME.ctxBg) : clip(source);
  const lead = ' '.repeat(LOG_PAD_X);
  const pad = Math.max(0, width - LOG_PAD_X - visibleWidth(body));
  const tail = ' '.repeat(pad);
  if (!color) return `${lead}${body}${tail}`;
  const base = seq(fgRgb, THEME.ctxBg);
  let out = `${base}${EL}${lead}${body}`;
  if (pad) out += `${RESET}${base}${tail}`;
  return `${out}${RESET}`;
};

const paintRunBar = (width, color, frame) => {
  const label = formatBusyStatus('running', frame);
  return paintLogLine(label, width, color, THEME.chromeFg);
};

const paintNpmLog = (view, width, color, bodyH) => {
  const text = view.npmOutput ?? '';
  const lines = text.split('\n');
  if (lines.length && lines.at(-1) === '') lines.pop();
  const running = view.npmRunning === true;
  const count = lines.length + (running ? 1 : 0);
  const rows = logViewRows(bodyH);
  const padY = bodyH - rows;
  const top = padY ? 1 : 0;
  const start = logStart(view, count, rows);
  const blank = fill(width, THEME.ctxFg, THEME.ctxBg, color);
  const body = [];
  for (let i = 0; i < top; i++) body.push(blank);
  for (let i = 0; i < rows; i++) {
    const index = start + i;
    if (index < lines.length) {
      const line = lines[index];
      if (color && isTableLine(line)) {
        const row = tableIndex(lines, index);
        body.push(paintTableLine(line, width, row));
      } else {
        body.push(paintLogLine(line, width, color));
      }
    } else if (running && index === lines.length) {
      body.push(paintRunBar(width, color, view.progressFrame ?? 0));
    } else {
      body.push(blank);
    }
  }
  for (let i = 0; i < padY - top; i++) body.push(blank);
  return paneResult({
    body,
  });
};

const paintBodyNpm = (view, width, color, bodyH, headerLines) => {
  if (view.npmView) return paintNpmLog(view, width, color, bodyH);
  return paintNpmList(view, width, color, bodyH, headerLines);
};

module.exports = { paintBodyNpm, logViewRows };
