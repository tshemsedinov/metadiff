'use strict';

const { clamp } = require('../common/utilities.js');

const SCROLL_KEEP = 4000;

const blankCell = () => ({ ch: ' ', sgr: '' });

const blankRow = (cols) => Array.from({ length: cols }, blankCell);

const blankGrid = (rows, cols) =>
  Array.from({ length: rows }, () => blankRow(cols));

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

const fill = (row, from, to, ch) => {
  for (let x = from; x < to; x += 1) row[x] = { ch, sgr: '' };
};

const csiNumber = (params, index, fallback) => {
  const cleaned = params.replace(/^[?>]/, '');
  const part = cleaned.split(';')[index] ?? '';
  if (!part) return fallback;
  const value = parseInt(part, 10);
  return Number.isFinite(value) ? value : fallback;
};

const csiCount = (params) => Math.max(1, csiNumber(params, 0, 1));

const isCsiParam = (code) => code >= 0x20 && code <= 0x3f;

const isCsiFinal = (code) => code >= 0x40 && code <= 0x7e;

const CSI = {
  A: (screen, params) => screen.moveAxis('cy', screen.cy - csiCount(params)),
  B: (screen, params) => screen.moveAxis('cy', screen.cy + csiCount(params)),
  C: (screen, params) => screen.moveAxis('cx', screen.cx + csiCount(params)),
  D: (screen, params) => screen.moveAxis('cx', screen.cx - csiCount(params)),
  G: (screen, params) => screen.moveAxis('cx', csiNumber(params, 0, 1) - 1),
  d: (screen, params) => screen.moveAxis('cy', csiNumber(params, 0, 1) - 1),
  H: (screen, params) => screen.placeCursor(params),
  f: (screen, params) => screen.placeCursor(params),
  J: (screen, params) => screen.eraseDisplay(csiNumber(params, 0, 0)),
  K: (screen, params) => screen.eraseLine(csiNumber(params, 0, 0)),
  s: (screen) => screen.saveCursor(),
  u: (screen) => screen.restoreCursor(),
  m: (screen, params) => screen.styleText(params),
};

const GROUND = {
  '\x1b': (screen) => screen.enter('esc'),
  '\r': (screen) => screen.moveAxis('cx', 0),
  '\n': (screen) => screen.linefeed(),
  '\b': (screen) => screen.moveAxis('cx', screen.cx - 1),
  '\t': (screen) => screen.moveAxis('cx', screen.cx + 8 - (screen.cx % 8)),
};

class Screen {
  constructor(cols, rows) {
    this.cols = Math.max(1, cols);
    this.rows = Math.max(1, rows);
    this.cx = 0;
    this.cy = 0;
    this.mode = 'ground';
    this.params = '';
    this.saved = { cx: 0, cy: 0 };
    this.sgr = '';
    this.scrollback = [];
    this.grid = blankGrid(this.rows, this.cols);
  }

  resize(cols, rows) {
    const nextCols = Math.max(1, cols);
    const nextRows = Math.max(1, rows);
    const grid = blankGrid(nextRows, nextCols);
    const copyRows = Math.min(this.rows, nextRows);
    const copyCols = Math.min(this.cols, nextCols);
    for (let y = 0; y < copyRows; y += 1) {
      for (let x = 0; x < copyCols; x += 1) {
        const cell = this.grid[y][x];
        grid[y][x] = { ch: cell.ch, sgr: cell.sgr };
      }
    }
    this.cols = nextCols;
    this.rows = nextRows;
    this.grid = grid;
    this.cx = clamp(this.cx, 0, nextCols - 1);
    this.cy = clamp(this.cy, 0, nextRows - 1);
  }

  enter(mode) {
    this.mode = mode;
  }

  scroll() {
    const line = paintStyled(this.grid[0]);
    if (this.scrollback.length >= SCROLL_KEEP) this.scrollback.shift();
    this.scrollback.push(line);
    this.grid.shift();
    this.grid.push(blankRow(this.cols));
    this.cy = this.rows - 1;
  }

  putChar(ch) {
    if (this.cx >= this.cols) {
      this.cx = 0;
      this.cy += 1;
    }
    if (this.cy >= this.rows) this.scroll();
    this.grid[this.cy][this.cx] = { ch, sgr: this.sgr || '' };
    this.cx += 1;
  }

  linefeed() {
    this.cx = 0;
    this.cy += 1;
    if (this.cy >= this.rows) this.scroll();
  }

  eraseLine(mode) {
    const row = this.grid[this.cy];
    if (!row) return;
    if (mode === 1) fill(row, 0, this.cx + 1, ' ');
    else if (mode === 2) fill(row, 0, this.cols, ' ');
    else fill(row, this.cx, this.cols, ' ');
  }

  eraseDisplay(mode) {
    if (mode === 2 || mode === 3) {
      this.grid = blankGrid(this.rows, this.cols);
      return;
    }
    if (mode === 1) {
      for (let y = 0; y < this.cy; y += 1) {
        fill(this.grid[y], 0, this.cols, ' ');
      }
      this.eraseLine(1);
      return;
    }
    this.eraseLine(0);
    for (let y = this.cy + 1; y < this.rows; y += 1) {
      fill(this.grid[y], 0, this.cols, ' ');
    }
  }

  placeCursor(params) {
    this.moveAxis('cy', csiNumber(params, 0, 1) - 1);
    this.moveAxis('cx', csiNumber(params, 1, 1) - 1);
  }

  moveAxis(axis, value) {
    const max = axis === 'cy' ? this.rows : this.cols;
    this[axis] = clamp(value, 0, max - 1);
  }

  saveCursor() {
    this.saved = { cx: this.cx, cy: this.cy };
  }

  restoreCursor() {
    this.cx = this.saved.cx;
    this.cy = this.saved.cy;
  }

  styleText(params) {
    this.sgr = applySgr(this.sgr, params);
  }

  feedOsc(ch) {
    if (ch === '\x07') this.mode = 'ground';
    if (ch === '\x1b') this.mode = 'osc-esc';
  }

  feedCsi(ch, code) {
    if (isCsiParam(code)) {
      this.params += ch;
      return;
    }
    const step = isCsiFinal(code) ? CSI[ch] : null;
    if (step) step(this, this.params);
    this.mode = 'ground';
  }

  feedEsc(ch) {
    this.mode = 'ground';
    if (ch === '[') {
      this.mode = 'csi';
      this.params = '';
    }
    if (ch === ']') this.mode = 'osc';
    if (ch === '7') this.saveCursor();
    if (ch === '8') this.restoreCursor();
  }

  feedOscEsc(ch) {
    if (ch === '\\') this.mode = 'ground';
    else this.feedEsc(ch);
  }

  feedGround(ch, code) {
    const step = GROUND[ch];
    if (step) step(this);
    else if (code >= 0x20 && code !== 0x7f) this.putChar(ch);
  }

  feed(ch) {
    const code = ch.charCodeAt(0);
    if (this.mode === 'osc') this.feedOsc(ch);
    else if (this.mode === 'osc-esc') this.feedOscEsc(ch);
    else if (this.mode === 'csi') this.feedCsi(ch, code);
    else if (this.mode === 'esc') this.feedEsc(ch);
    else this.feedGround(ch, code);
  }

  write(text) {
    const source = `${text ?? ''}`;
    for (let i = 0; i < source.length; i += 1) this.feed(source[i]);
  }

  plain() {
    const lines = [];
    for (const row of this.grid) {
      let end = row.length;
      while (end > 0 && row[end - 1].ch === ' ') end -= 1;
      const cells = row.slice(0, end);
      lines.push(cells.map((cell) => cell.ch).join(''));
    }
    while (lines.length && lines.at(-1) === '') lines.pop();
    return lines.join('\n');
  }

  styled() {
    const lines = this.scrollback.slice();
    for (const row of this.grid) lines.push(paintStyled(row));
    while (lines.length && lines.at(-1) === '') lines.pop();
    return lines.join('\n');
  }
}

module.exports = { Screen };
