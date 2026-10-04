'use strict';

const ansi = require('../ansi.js');
const npmCommands = require('../npm-commands.js');
const wrap = require('../wrap.js');
const chrome = require('./chrome.js');
const primitives = require('./primitives.js');

const { THEME, CODE_FG, paint, visibleWidth, truncateVisible } = ansi;
const { trimVisible, seq, EL, RESET, fg, hyperlink } = ansi;
const { clipAnsi, stripAnsi, foregroundOn } = ansi;
const { TABLE_KEY, TABLE_VAL } = npmCommands;
const { wrapPlain } = wrap;
const { formatBusyStatus } = chrome;
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

const npmColumns = (width, nameCol) => {
  const rest = Math.max(1, width - EDGE - TAIL - MARK_W);
  const nameW = Math.min(nameCol, rest);
  const gap = rest > nameW + 2 ? '  ' : '';
  return { rest, nameW, gap, detailW: rest - nameW - gap.length };
};

const paintNpmLine = (cols, name, detail, color, selected, bin) => {
  const prefix = markPrefix(selected);
  const namePad = ' '.repeat(Math.max(0, cols.nameW - visibleWidth(name)));
  const mid = `${name}${namePad}`;
  const after = `${cols.gap}${detail}`;
  const pad = ' '.repeat(Math.max(0, cols.rest - visibleWidth(mid + after)));
  const tail = ' '.repeat(TAIL);
  const fgRgb = selected ? THEME.chromeFg : THEME.mutedFg;
  const bgRgb = selected ? THEME.buttonBg : THEME.ctxBg;
  const edge = fill(EDGE, fgRgb, THEME.ctxBg, color);
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

const paintNpmList = (view, width, color, bodyH, headerLines) => {
  const commands = view.npmCommands ?? [];
  const { compose } = view;
  const editing = compose?.kind === 'npm';
  const typed = editingName(view) ? compose?.text : view.npmDraftName;
  const nameW = npmNameWidth(commands, editing ? `${typed ?? ''}` : '');
  const cursor = view.npmCursor ?? 0;
  const pane = { width, color, bodyH, headerLines, offset: view.listScroll };
  const paintRow = (entry, selected) =>
    paintNpmRow(entry, width, color, selected, nameW);
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
  return paneResult({ body });
};

const paintBodyNpm = (view, width, color, bodyH, headerLines) => {
  if (view.npmView) return paintNpmLog(view, width, color, bodyH);
  return paintNpmList(view, width, color, bodyH, headerLines);
};

module.exports = { paintBodyNpm, logViewRows, expandLogLines, paintNpmLog };
