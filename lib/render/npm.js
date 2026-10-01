'use strict';

const ansi = require('../ansi.js');
const chrome = require('./chrome.js');
const primitives = require('./primitives.js');
const npmCommands = require('../npm-commands.js');
const wrap = require('../wrap.js');

const { THEME, paint, visibleWidth, truncateVisible, trimVisible } = ansi;
const { seq, EL } = ansi;
const { clipAnsi, stripAnsi, RESET, foregroundOn } = ansi;
const { fg, CODE_FG } = ansi;
const { formatBusyStatus } = chrome;
const { TABLE_KEY, TABLE_VAL } = npmCommands;
const { fill, FILE_MARK, paneResult, paintCursorList } = primitives;
const { fieldWindow } = primitives;
const { wrapPlain } = wrap;

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
  const name = trimVisible(entry.name, nameW);
  const gap = rest > nameW + 2 ? '  ' : '';
  const detailW = Math.max(0, rest - nameW - visibleWidth(gap));
  const shown = trimVisible(detail, detailW);
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

const editNameSource = (view, compose, field) => {
  if (field === 'name') return compose.text;
  return view.npmDraftName ?? '';
};

const editNameWidth = (commands, live) => {
  const typed = visibleWidth(`${live ?? ''}`);
  return Math.min(NPM_NAME_MAX, Math.max(npmNameWidth(commands), typed));
};

const paintNpmEdit = (view, width, color, nameW) => {
  const compose = view.compose;
  const field = view.npmEditField === 'command' ? 'command' : 'name';
  const nameSource = editNameSource(view, compose, field);
  const draft = view.npmDraftCommand ?? '';
  const commandSource = field === 'command' ? compose.text : draft;
  const inner = Math.max(1, width - EDGE - TAIL);
  const prefix = ` ${FILE_MARK} `;
  const prefixW = visibleWidth(prefix);
  const rest = Math.max(1, inner - prefixW);
  const colW = Math.min(Math.max(0, nameW), rest);
  const flatName = `${nameSource ?? ''}`.replaceAll('\n', ' ');
  const nameAt = field === 'name' ? compose.cursor : 0;
  const nameScroll = field === 'name' ? compose.scrollCol : 0;
  const nameWin = fieldWindow(flatName, nameAt, nameScroll, colW);
  const name = nameWin.text;
  const gap = rest > colW + 2 ? '  ' : '';
  const gapW = visibleWidth(gap);
  const detailW = Math.max(0, rest - colW - gapW);
  const flatCommand = `${commandSource ?? ''}`.replaceAll('\n', ' ');
  const commandAt = field === 'command' ? compose.cursor : 0;
  const commandScroll = field === 'command' ? compose.scrollCol : 0;
  const commandWin = fieldWindow(
    flatCommand,
    commandAt,
    commandScroll,
    detailW,
  );
  const command = commandWin.text;
  const namePad = ' '.repeat(Math.max(0, colW - visibleWidth(name)));
  const mid = `${name}${namePad}`;
  const after = `${gap}${command}`;
  const pad = Math.max(0, rest - visibleWidth(mid + after));
  const tail = ' '.repeat(TAIL);
  const left = `${prefix}${mid}${after}${' '.repeat(pad)}`;
  const fgRgb = THEME.chromeFg;
  const bgRgb = THEME.buttonBg;
  const edge = fill(EDGE, fgRgb, THEME.ctxBg, color);
  let row = `${left}${tail}${edge}`;
  if (color) {
    row = `${seq(fgRgb, bgRgb)}${EL}`;
    row += paint(prefix, fgRgb, bgRgb, color);
    row += paint(mid, THEME.buttonHotFg, bgRgb, color, true);
    row += paint(`${after}${' '.repeat(pad)}${tail}`, fgRgb, bgRgb, color);
    row += edge;
  }
  const active = field === 'name' ? nameWin : commandWin;
  const lead = field === 'name' ? 0 : colW + gapW;
  const nameX = prefixW + 1;
  const commandX = prefixW + colW + gapW + 1;
  const edits = [
    {
      field: 'name',
      x0: 1,
      textX: nameX,
      x1: commandX,
      start: 0,
      text: flatName,
      limit: flatName.length,
      scroll: nameWin.scroll,
      live: field === 'name',
    },
    {
      field: 'command',
      x0: commandX,
      textX: commandX,
      x1: width + 1,
      start: 0,
      text: flatCommand,
      limit: flatCommand.length,
      scroll: commandWin.scroll,
      live: field === 'command',
    },
  ];
  const cursor = {
    x: prefixW + lead + active.col + 1,
    scroll: active.scroll,
  };
  return { row, cursor, edits };
};

const paintNpmList = (view, width, color, bodyH, headerLines) => {
  const commands = view.npmCommands ?? [];
  const compose = view.compose;
  const editing = compose && compose.kind === 'npm';
  const field = view.npmEditField === 'command' ? 'command' : 'name';
  const live = editing ? editNameSource(view, compose, field) : '';
  const nameW = editing
    ? editNameWidth(commands, live)
    : npmNameWidth(commands);
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

const countInk = (active, idle) => (value) => {
  if (Number(value) > 0) return active();
  return idle();
};

const errorInk = countInk(
  () => THEME.errorFg,
  () => THEME.mutedFg,
);
const passInk = countInk(
  () => THEME.addLineFg,
  () => THEME.mutedFg,
);

const TABLE_INK = {
  actual: () => THEME.errorFg,
  expected: () => THEME.addLineFg,
  code: () => THEME.shaFg,
  type: () => CODE_FG.className,
  count: () => THEME.warnFg,
  omitted: () => THEME.warnFg,
  failed: errorInk,
  errors: errorInk,
  passed: passInk,
};

const tableInk = (key, value) => {
  const name = key.trim();
  if (!Object.hasOwn(TABLE_INK, name)) return THEME.chromeFg;
  return TABLE_INK[name](value);
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
  const pieces = wrapPlain(body, budget);
  const blank = ' '.repeat(visibleWidth(part.key));
  const rows = [];
  for (let i = 0; i < pieces.length; i++) {
    const name = i === 0 ? part.key : blank;
    const cell = `${lead}${pieces[i]}`;
    rows.push(`${TABLE_KEY}${name}${TABLE_VAL}${part.gap}${cell}`);
  }
  return rows;
};

const wrapLogText = (line, inner) => {
  const mark = line.startsWith('│ ') ? '│ ' : '';
  const rest = mark ? line.slice(mark.length) : line;
  const budget = Math.max(1, inner - visibleWidth(mark));
  if (visibleWidth(rest) <= budget) return [line];
  const pieces = wrapPlain(rest, budget);
  if (!mark) return pieces;
  const rows = [];
  for (const piece of pieces) rows.push(`${mark}${piece}`);
  return rows;
};

const expandLogLines = (text, width) => {
  const lines = `${text ?? ''}`.split('\n');
  if (lines.length && lines.at(-1) === '') lines.pop();
  const inner = Math.max(1, width - LOG_PAD_X * 2);
  const out = [];
  for (const line of lines) {
    const rows = isTableLine(line)
      ? wrapTableLine(line, width)
      : wrapLogText(line, inner);
    for (const row of rows) out.push(row);
  }
  return out;
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
  let out = fill(part.edge, ink, tone.frame, true);
  out += paint(shownKey, ink, tone.keyBg, true);
  out += paint(part.gap.slice(0, part.gapW), ink, tone.frame, true);
  const cell = `${shown}${pad}`;
  out += paint(cell, tableInk(part.key, part.value), tone.valueBg, true);
  return `${out}${fill(part.edge, ink, tone.frame, true)}`;
};

const paintLogSource = (line) => {
  if (line !== stripAnsi(line)) return line;
  if (/^[✖✔△] /.test(line)) {
    const ink = line[0] === '✔' ? THEME.addLineFg : THEME.errorFg;
    const color = line[0] === '△' ? THEME.warnFg : ink;
    return paint(line, color, THEME.ctxBg, true, true);
  }
  if (line.startsWith('│')) {
    const bar = `${fg(THEME.shaFg)}│${fg(THEME.ctxFg)}`;
    return `${bar}${line.slice(1)}`;
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
  const source = color ? paintLogSource(`${line ?? ''}`) : stripAnsi(line);
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
  const lines = expandLogLines(view.npmOutput ?? '', width);
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
      if (isTableLine(line)) {
        const row = tableIndex(lines, index);
        const painted = color
          ? paintTableLine(line, width, row)
          : paintPlainTable(line, width);
        body.push(painted);
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

module.exports = { paintBodyNpm, logViewRows, expandLogLines };
