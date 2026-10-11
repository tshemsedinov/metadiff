'use strict';

const { clamp } = require('../common/utilities.js');
const ansi = require('../term/ansi.js');
const { TABLE_KEY, TABLE_VAL } = require('../runs/output.js');
const { wrapPlain } = require('../term/wrap.js');
const { formatBusyStatus } = require('./status.js');
const primitives = require('./primitives.js');
const { scrollMark } = primitives;
const { THEME, CODE_FG, paint, visibleWidth, truncateVisible } = ansi;
const { trimVisible, seq, EL, RESET, fg, hyperlink } = ansi;
const { clipAnsi, stripAnsi, foregroundOn } = ansi;
const { fill } = primitives;
const { paneResult } = primitives;

const LOG_PAD_Y = 1;

const LOG_PAD_X = 2;

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

const logStart = (view, count, rows) => {
  const maxStart = Math.max(0, count - rows);
  const start = view.npmFollow ? maxStart : view.npmScroll;
  return clamp(start ?? 0, 0, maxStart);
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
  const gapW = clamp(inner - keyW, 0, visibleWidth(gap));
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

const logLines = (text) => {
  const lines = `${text ?? ''}`.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

let expanded = { text: '', width: 0, lines: [] };

const expandLogLines = (text, width) => {
  const source = `${text ?? ''}`;
  if (expanded.width === width && expanded.text === source) {
    return expanded.lines;
  }
  const inner = Math.max(1, width - LOG_PAD_X * 2);
  const lines = logLines(source).flatMap((line) => {
    if (isTableLine(line)) return wrapTableLine(line, width);
    return wrapLogText(line, inner);
  });
  expanded = { text: source, width, lines };
  return lines;
};

const logRowCount = (text, width, running) => {
  const lines = width > 0 ? expandLogLines(text, width) : logLines(text);
  return lines.length + (running ? 1 : 0);
};

const logScrollMax = (text, size, frame, running) => {
  const count = logRowCount(text, size?.width || 0, running);
  return Math.max(0, count - logViewRows(frame?.bodyH || 1));
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

module.exports = {
  LOG_PAD_X,
  logViewRows,
  mixRgb,
  expandLogLines,
  logRowCount,
  logScrollMax,
  withLogScroller,
  paintNpmLog,
};
