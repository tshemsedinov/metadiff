'use strict';

const { clamp } = require('../common/utilities.js');

const SCROLL_KEEP = 4000;

const blankCell = () => ({ ch: ' ', sgr: '' });

const blankRow = (cols) => Array.from({ length: cols }, blankCell);

const blankGrid = (rows, cols) =>
  Array.from({ length: rows }, () => blankRow(cols));

const createScreen = (cols, rows) => ({
  cols: Math.max(1, cols),
  rows: Math.max(1, rows),
  cx: 0,
  cy: 0,
  mode: 'ground',
  params: '',
  saved: { cx: 0, cy: 0 },
  sgr: '',
  scrollback: [],
  grid: blankGrid(Math.max(1, rows), Math.max(1, cols)),
});

const resizeScreen = (screen, cols, rows) => {
  const nextCols = Math.max(1, cols);
  const nextRows = Math.max(1, rows);
  const grid = blankGrid(nextRows, nextCols);
  const copyRows = Math.min(screen.rows, nextRows);
  const copyCols = Math.min(screen.cols, nextCols);
  for (let y = 0; y < copyRows; y += 1) {
    for (let x = 0; x < copyCols; x += 1) {
      const cell = screen.grid[y][x];
      grid[y][x] = { ch: cell.ch, sgr: cell.sgr };
    }
  }
  screen.cols = nextCols;
  screen.rows = nextRows;
  screen.grid = grid;
  screen.cx = clamp(screen.cx, 0, nextCols - 1);
  screen.cy = clamp(screen.cy, 0, nextRows - 1);
};

const applySgr = (current, params) => {
  const parts = `${params ?? ''}`.split(';').filter((part) => part !== '');
  if (!parts.length || parts.includes('0')) {
    return parts.filter((part) => part !== '0').join(';');
  }
  const prev = current ? current.split(';') : [];
  return [...prev, ...parts].join(';');
};

const paintStyled = (row) => {
  let end = row.length;
  while (end > 0 && row[end - 1].ch === ' ') end -= 1;
  let out = '';
  let prev = '';
  let styled = false;
  for (let x = 0; x < end; x += 1) {
    const sgr = row[x].sgr || '';
    if (sgr !== prev) {
      styled = true;
      out += `\x1b[${sgr || '0'}m`;
      prev = sgr;
    }
    out += row[x].ch;
  }
  if (styled && prev) out += '\x1b[0m';
  return out;
};

const rememberLine = (screen) => {
  const line = paintStyled(screen.grid[0]);
  if (screen.scrollback.length >= SCROLL_KEEP) screen.scrollback.shift();
  screen.scrollback.push(line);
};

const scrollScreen = (screen) => {
  rememberLine(screen);
  screen.grid.shift();
  screen.grid.push(blankRow(screen.cols));
  screen.cy = screen.rows - 1;
};

const putChar = (screen, ch) => {
  if (screen.cx >= screen.cols) {
    screen.cx = 0;
    screen.cy += 1;
  }
  if (screen.cy >= screen.rows) scrollScreen(screen);
  const sgr = screen.sgr || '';
  screen.grid[screen.cy][screen.cx] = { ch, sgr };
  screen.cx += 1;
};

const linefeed = (screen) => {
  screen.cx = 0;
  screen.cy += 1;
  if (screen.cy >= screen.rows) scrollScreen(screen);
};

const fill = (row, from, to, ch) => {
  for (let x = from; x < to; x += 1) row[x] = { ch, sgr: '' };
};

const eraseLine = (screen, mode) => {
  const row = screen.grid[screen.cy];
  if (!row) return;
  if (mode === 1) fill(row, 0, screen.cx + 1, ' ');
  else if (mode === 2) fill(row, 0, screen.cols, ' ');
  else fill(row, screen.cx, screen.cols, ' ');
};

const eraseDisplay = (screen, mode) => {
  if (mode === 2 || mode === 3) {
    screen.grid = blankGrid(screen.rows, screen.cols);
    return;
  }
  if (mode === 1) {
    for (let y = 0; y < screen.cy; y += 1) {
      fill(screen.grid[y], 0, screen.cols, ' ');
    }
    eraseLine(screen, 1);
    return;
  }
  eraseLine(screen, 0);
  for (let y = screen.cy + 1; y < screen.rows; y += 1) {
    fill(screen.grid[y], 0, screen.cols, ' ');
  }
};

const csiNumber = (params, index, fallback) => {
  const cleaned = params.replace(/^[?>]/, '');
  const part = cleaned.split(';')[index] ?? '';
  if (!part) return fallback;
  const value = parseInt(part, 10);
  return Number.isFinite(value) ? value : fallback;
};

const placeCursor = (screen, params) => {
  const row = csiNumber(params, 0, 1);
  const col = csiNumber(params, 1, 1);
  screen.cy = clamp(row - 1, 0, screen.rows - 1);
  screen.cx = clamp(col - 1, 0, screen.cols - 1);
};

const moveAxis = (screen, axis, value) => {
  const max = axis === 'cy' ? screen.rows : screen.cols;
  screen[axis] = clamp(value, 0, max - 1);
};

const saveCursor = (screen) => {
  screen.saved = { cx: screen.cx, cy: screen.cy };
};

const restoreCursor = (screen) => {
  screen.cx = screen.saved.cx;
  screen.cy = screen.saved.cy;
};

const csiCount = (params) => Math.max(1, csiNumber(params, 0, 1));

const CSI = {
  A(screen, params) {
    moveAxis(screen, 'cy', screen.cy - csiCount(params));
  },
  B(screen, params) {
    moveAxis(screen, 'cy', screen.cy + csiCount(params));
  },
  C(screen, params) {
    moveAxis(screen, 'cx', screen.cx + csiCount(params));
  },
  D(screen, params) {
    moveAxis(screen, 'cx', screen.cx - csiCount(params));
  },
  G(screen, params) {
    moveAxis(screen, 'cx', csiNumber(params, 0, 1) - 1);
  },
  d(screen, params) {
    moveAxis(screen, 'cy', csiNumber(params, 0, 1) - 1);
  },
  J(screen, params) {
    eraseDisplay(screen, csiNumber(params, 0, 0));
  },
  K(screen, params) {
    eraseLine(screen, csiNumber(params, 0, 0));
  },
  s(screen) {
    saveCursor(screen);
  },
  u(screen) {
    restoreCursor(screen);
  },
  m(screen, params) {
    screen.sgr = applySgr(screen.sgr, params);
  },
};

const runCsi = (screen, params, final) => {
  if (final === 'H' || final === 'f') {
    placeCursor(screen, params);
    return;
  }
  const step = CSI[final];
  if (!step) {
    return;
  }
  step(screen, params);
};

const isCsiParam = (code) => code >= 0x20 && code <= 0x3f;

const isCsiFinal = (code) => code >= 0x40 && code <= 0x7e;

const feedOsc = (screen, ch) => {
  if (ch === '\x07') {
    screen.mode = 'ground';
  }
  if (ch === '\x1b') {
    screen.mode = 'osc-esc';
  }
};

const feedCsi = (screen, ch, code) => {
  if (isCsiParam(code)) {
    screen.params += ch;
    return;
  }
  if (isCsiFinal(code)) {
    runCsi(screen, screen.params, ch);
  }
  screen.mode = 'ground';
};

const feedEsc = (screen, ch) => {
  screen.mode = 'ground';
  if (ch === '[') {
    screen.mode = 'csi';
    screen.params = '';
    return;
  }
  if (ch === ']') {
    screen.mode = 'osc';
  }
  if (ch === '7') {
    saveCursor(screen);
  }
  if (ch === '8') {
    restoreCursor(screen);
  }
};

const feedOscEsc = (screen, ch) => {
  if (ch === '\\') {
    screen.mode = 'ground';
    return;
  }
  screen.mode = 'esc';
  feedEsc(screen, ch);
};

const GROUND = {
  '\x1b'(screen) {
    screen.mode = 'esc';
  },
  '\r'(screen) {
    screen.cx = 0;
  },
  '\n': linefeed,
  '\b'(screen) {
    screen.cx = clamp(screen.cx - 1, 0, screen.cols - 1);
  },
  '\t'(screen) {
    const tab = screen.cx + 8 - (screen.cx % 8);
    screen.cx = clamp(tab, 0, screen.cols - 1);
  },
};

const feedGround = (screen, ch, code) => {
  const step = GROUND[ch];
  if (step) {
    step(screen);
    return;
  }
  if (code < 0x20 || code === 0x7f) {
    return;
  }
  putChar(screen, ch);
};

const feedChar = (screen, ch) => {
  const code = ch.charCodeAt(0);
  if (screen.mode === 'osc') {
    feedOsc(screen, ch);
    return;
  }
  if (screen.mode === 'osc-esc') {
    feedOscEsc(screen, ch);
    return;
  }
  if (screen.mode === 'csi') {
    feedCsi(screen, ch, code);
    return;
  }
  if (screen.mode === 'esc') {
    feedEsc(screen, ch);
    return;
  }
  feedGround(screen, ch, code);
};

const writeScreen = (screen, text) => {
  const source = `${text ?? ''}`;
  for (let i = 0; i < source.length; i += 1) feedChar(screen, source[i]);
};

const plainScreen = (screen) => {
  const lines = [];
  for (const row of screen.grid) {
    let end = row.length;
    while (end > 0 && row[end - 1].ch === ' ') end -= 1;
    const text = row
      .slice(0, end)
      .map((cell) => cell.ch)
      .join('');
    lines.push(text);
  }
  while (lines.length && lines.at(-1) === '') lines.pop();
  return lines.join('\n');
};

const styledText = (screen) => {
  const lines = screen.scrollback.slice();
  for (const row of screen.grid) lines.push(paintStyled(row));
  while (lines.length && lines.at(-1) === '') lines.pop();
  return lines.join('\n');
};

const screenWrite = (screen, text) => {
  writeScreen(screen, `${text ?? ''}`);
  return plainScreen(screen);
};

const BUSY_MARK = 'ctrl+c to stop';
const FOLLOW_UP = 'Add a follow-up';
const FILES_EDITED = /(\d[\d,]*)\s+files?\s+edited/i;

const sawWork = (text) => {
  const body = `${text ?? ''}`;
  if (body.includes(BUSY_MARK)) return true;
  const match = FILES_EDITED.exec(body);
  if (!match) return false;
  const count = Number(match[1].replaceAll(',', ''));
  return count > 0;
};

const DECISION_TITLES = [
  'Run this command outside the sandbox?',
  'Run this command?',
  'Run this MCP tool?',
  'Delete this file?',
  'Write to this file?',
  'Read this file?',
  'Allow this web search?',
  'Allow this web fetch?',
  'Proceed with this edit?',
  'Approve mode switch',
  'Waiting for decision',
];

const pendingKind = (text) => {
  const body = `${text ?? ''}`;
  if (!body.trim()) return '';
  if (body.includes('empty to skip') || body.includes('Enter to send')) {
    return 'text';
  }
  if (body.includes('Edit the image prompt')) return 'text';
  if (body.includes('Describe how to revise')) return 'text';
  if (body.includes('Answer questions (')) return 'question';
  for (const title of DECISION_TITLES) {
    if (body.includes(title)) return 'decision';
  }
  if (body.includes(FOLLOW_UP) && !body.includes(BUSY_MARK)) return 'idle';
  return '';
};

const agentBusy = (text, kind) => {
  if (kind === 'decision' || kind === 'question' || kind === 'text') {
    return true;
  }
  return `${text ?? ''}`.includes(BUSY_MARK);
};

const requestTitle = (text) => {
  const body = `${text ?? ''}`;
  for (const title of DECISION_TITLES) {
    if (body.includes(title)) return title.replace(/\?$/, '');
  }
  if (pendingKind(body) === 'question') return 'Answer questions';
  if (pendingKind(body) === 'text') return 'Reply to the agent';
  return 'Approval';
};

const HINTS = {
  decision: 'y once   a always   n reject',
  question: 'arrows select   enter next   esc skip   ctrl-q log',
  text: 'type a reply   enter send   esc cancel   ctrl-q log',
};

const pendingHint = (kind) => HINTS[kind] || '';

const NAV_BYTES = {
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  enter: '\r',
  escape: '\x1b',
  tab: '\t',
  backspace: '\x7f',
};

const DECISION_BYTES = {
  y: 'y',
  Y: 'Y',
  n: 'n',
  N: 'N',
  p: 'p',
  P: 'P',
  a: '\t',
  A: '\t',
  tab: '\t',
  enter: '\r',
};

const answerBytes = (key, kind) => {
  if (kind === 'decision') return DECISION_BYTES[key] ?? null;
  if (kind !== 'question' && kind !== 'text') return null;
  if (NAV_BYTES[key]) return NAV_BYTES[key];
  if (key.length === 1) return key;
  return null;
};

const remembersAnswer = (key) => key === 'a' || key === 'A' || key === 'tab';

const PERMISSION = /\b(Shell|Write|Read|Delete|Mcp|WebFetch)\(([^)\n]+)\)/g;

const permissionTokens = (text) => {
  const found = [];
  const body = `${text ?? ''}`;
  for (const match of body.matchAll(PERMISSION)) {
    const token = `${match[1]}(${match[2].trim()})`;
    if (!found.includes(token)) found.push(token);
  }
  return found;
};

const shellBin = (token) => {
  const match = /^Shell\((.*)\)$/.exec(token);
  if (!match) return '';
  return match[1].split(/\s+/)[0] || '';
};

const rememberedTokens = (tokens) => {
  const out = [];
  const add = (token) => {
    if (token && !out.includes(token)) out.push(token);
  };
  for (const token of tokens) {
    add(token);
    const bin = shellBin(token);
    if (bin === 'npm' || bin === 'npx' || bin === 'node' || bin === 'reslop') {
      add(`Shell(${bin})`);
    }
    const write = /^Write\((.*)\)$/.exec(token);
    if (!write) continue;
    const file = write[1].replaceAll('\\', '/');
    if (!file.includes('.plan/') || !file.endsWith('.md')) continue;
    add('Write(.plan/**/*.md)');
    add('Write(**/.plan/**/*.md)');
  }
  return out;
};

module.exports = {
  createScreen,
  resizeScreen,
  screenWrite,
  plainScreen,
  styledText,
  pendingKind,
  sawWork,
  agentBusy,
  pendingHint,
  requestTitle,
  answerBytes,
  remembersAnswer,
  permissionTokens,
  rememberedTokens,
};
