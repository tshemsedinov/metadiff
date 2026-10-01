'use strict';

const metautil = require('metautil');
const { bytesToSize } = metautil;
const files = require('../files.js');
const { relativeAge } = files;
const ansi = require('../ansi.js');
const { visibleWidth, graphemes, graphemeWidth } = ansi;
const tiles = require('./tiles.js');
const { seg, segmentsWidth, clipSegments } = tiles;
const tree = require('../dashboard/tree.js');
const { HEAT_MS } = tree;

const MIN_FLEX = 6;

const trimmed = (value) =>
  value >= 10 ? `${Math.round(value)}` : `${Math.round(value * 10) / 10}`;

const num = (value) => {
  const n = Math.max(0, Math.round(value));
  if (n >= 1e6) return `${trimmed(n / 1e6)}m`;
  if (n >= 1e4) return `${trimmed(n / 1e3)}k`;
  return `${n}`;
};

const size = (bytes) => bytesToSize(bytes > 0 ? bytes : 0);

const SECONDS_AGO = /^\d+s ago$/;

const ago = (at, now) => {
  if (!at) return '';
  const text = relativeAge(at, now);
  if (SECONDS_AGO.test(text)) return '<1m ago';
  return text;
};

const duration = (ms) => {
  const value = Math.max(0, ms);
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60000);
  const seconds = Math.floor((value % 60000) / 1000);
  return `${minutes}m${`${seconds}`.padStart(2, '0')}s`;
};

const isHot = (at, now) => at > 0 && now - at < HEAT_MS;

const delta = (value, now, at) => {
  if (!at || now - at >= HEAT_MS || !value) return null;
  if (value > 0) return seg(`▲+${num(value)}`, 'add', true);
  return seg(`▼${num(-value)}`, 'del', true);
};

const cell = (text, tone = 'text', align = 'l', bold = false) => ({
  segs: [seg(text, tone, bold)],
  align,
  flex: false,
});

const cellSegs = (segs, align = 'l') => ({ segs, align, flex: false });

const flexCell = (text, tone = 'muted') => ({
  segs: [seg(text, tone)],
  align: 'l',
  flex: true,
});

const blankCell = { segs: [], align: 'l', flex: false };

const columnWidths = (rows, count) => {
  const widths = new Array(count).fill(0);
  for (const row of rows) {
    for (let c = 0; c < count; c++) {
      const item = row[c];
      if (!item || (item.flex && !item.keep)) continue;
      widths[c] = Math.max(widths[c], segmentsWidth(item.segs));
    }
  }
  return widths;
};

const flexColumn = (rows, count) => {
  for (let c = 0; c < count; c++) {
    if (rows.some((row) => row[c] && row[c].flex)) return c;
  }
  return -1;
};

const usedWidth = (widths, use, gaps) => {
  let total = 0;
  for (let c = 0; c < use; c++) total += widths[c] + gaps[c];
  return total;
};

const columnGaps = (rows, count, fallback) => {
  const gaps = new Array(count).fill(fallback);
  const fixed = new Array(count).fill(false);
  gaps[0] = 0;
  fixed[0] = true;
  for (let c = 1; c < count; c++) {
    for (const row of rows) {
      const item = row[c];
      if (!item || typeof item.gap !== 'number') continue;
      gaps[c] = item.gap;
      fixed[c] = true;
      break;
    }
  }
  return { gaps, fixed };
};

const closeEmpty = (widths, gaps, fixed) => {
  for (let c = 1; c < widths.length; c++) {
    if (widths[c - 1] !== 0) continue;
    gaps[c] = 0;
    fixed[c] = true;
  }
};

const widenGaps = (gaps, fixed, use, room) => {
  if (room <= 0) return;
  const open = [];
  for (let c = 1; c < use; c++) {
    if (!fixed[c]) open.push(c);
  }
  if (!open.length) return;
  const share = Math.floor(room / open.length);
  let extra = room - share * open.length;
  for (const index of open) {
    gaps[index] += share;
    if (extra <= 0) continue;
    gaps[index] += 1;
    extra -= 1;
  }
};

const columnKept = (rows, index) =>
  index >= 0 && rows.some((row) => row[index] && row[index].keep);

const customFloor = (rows, index) => {
  let floor = null;
  if (index < 0) return floor;
  for (const row of rows) {
    const item = row[index];
    if (!item || !item.flex || typeof item.min !== 'number') continue;
    floor = floor === null ? item.min : Math.min(floor, item.min);
  }
  return floor;
};

const pickColumns = (rows, width, gap = 2, spread = false) => {
  const count = Math.max(0, ...rows.map((row) => row.length));
  const widths = columnWidths(rows, count);
  const flex = flexColumn(rows, count);
  const protect = columnKept(rows, flex);
  const spec = columnGaps(rows, count, gap);
  const gaps = spec.gaps;
  closeEmpty(widths, gaps, spec.fixed);
  let use = count;
  while (use > 1) {
    const flexHere = flex >= 0 && flex < use;
    const asked = flexHere && !protect ? customFloor(rows, flex) : null;
    const base = asked === null ? MIN_FLEX : asked;
    const need = flexHere && !protect ? base : 0;
    const used = usedWidth(widths, use, gaps);
    if (used + need <= width) break;
    const trailing = flexHere && !protect && flex < use - 1;
    const reserve = asked === null ? 0 : asked;
    if (trailing && used + reserve <= width) break;
    if (protect && flex === use - 1) break;
    use -= 1;
  }
  const room = width - usedWidth(widths, use, gaps);
  if (flex >= 0 && flex < use) {
    widths[flex] = Math.max(0, widths[flex] + room);
  } else if (spread) {
    widenGaps(gaps, spec.fixed, use, room);
  }
  return { use, widths, flex, gaps };
};

const flexSegments = (item, room) => {
  const clipped = clipSegments(item.segs, room);
  const pad = Math.max(0, room - segmentsWidth(clipped));
  return [...clipped, seg(' '.repeat(pad))];
};

const renderRow = (row, use, widths, flex, gaps) => {
  const line = [];
  for (let c = 0; c < use; c++) {
    const item = row[c] ?? blankCell;
    if (c) line.push(seg(' '.repeat(gaps[c])));
    if (c === flex) {
      line.push(...flexSegments(item, widths[c]));
      continue;
    }
    const pad = ' '.repeat(Math.max(0, widths[c] - segmentsWidth(item.segs)));
    if (item.align === 'r') line.push(seg(pad), ...item.segs);
    else line.push(...item.segs, seg(pad));
  }
  return line;
};

const tableLines = (rows, width, gap = 2, spread = false) => {
  if (!rows.length) return [];
  const picked = pickColumns(rows, width, gap, spread);
  return rows.map((row) =>
    renderRow(row, picked.use, picked.widths, picked.flex, picked.gaps),
  );
};

const titleSegs = (tile, badge = []) => {
  const segs = [];
  if (tile.title.startsWith(tile.key)) {
    segs.push(seg(tile.key, 'key', true));
    segs.push(seg(tile.title.slice(tile.key.length)));
  } else {
    segs.push(seg(tile.key, 'key', true));
    segs.push(seg(` ${tile.title}`));
  }
  if (badge.length) segs.push(seg(' '), ...badge);
  return segs;
};

const withTitle = (tile, tail, rows, width, badge = [], lead = 0) => {
  const gap = 2;
  const title = cellSegs(titleSegs(tile, badge));
  title.flex = true;
  const head = [];
  for (let i = 0; i < lead; i++) head.push(cell(''));
  head.push(title, ...tail);
  const picked = pickColumns([head, ...rows], width, gap);
  const paint = (row) =>
    renderRow(row, picked.use, picked.widths, picked.flex, picked.gaps);
  return { titleLine: paint(head), lines: rows.map(paint) };
};

const tailVisible = (text, skip) => {
  let left = skip;
  let col = 0;
  let out = '';
  for (const ch of graphemes(text)) {
    const w = graphemeWidth(ch, col);
    col += w;
    if (left > 0) {
      left -= w;
      continue;
    }
    out += ch;
  }
  return out;
};

const skipSegments = (segs, skip) => {
  const out = [];
  let left = skip;
  for (const part of segs) {
    if (left <= 0) {
      out.push(part);
      continue;
    }
    const w = visibleWidth(part.text);
    if (w <= left) {
      left -= w;
      continue;
    }
    const text = tailVisible(part.text, left);
    left = 0;
    if (text) out.push(seg(text, part.tone, part.bold));
  }
  return out;
};

const captionOver = (tile, line, badge = []) => {
  const caption = titleSegs(tile, badge);
  const rest = skipSegments(line, segmentsWidth(caption));
  return [...caption, ...rest];
};

const layoutRows = (rows, width, gap = 2, spread = false) => {
  if (!rows.length) return { lines: [], paint: () => [] };
  const picked = pickColumns(rows, width, gap, spread);
  const paint = (row) =>
    renderRow(row, picked.use, picked.widths, picked.flex, picked.gaps);
  return { lines: rows.map(paint), paint };
};

const titleAside = (tile, aside, width, badge = []) => {
  const left = titleSegs(tile, badge);
  const right = aside ?? [];
  const gap = width - segmentsWidth(left) - segmentsWidth(right);
  return [...left, seg(' '.repeat(Math.max(1, gap))), ...right];
};

const stat = (label, value, tone = 'text', bold = false) => ({
  label,
  value: typeof value === 'string' ? [seg(value, tone, bold)] : value,
});

const pairRows = (items, perRow = 2) => {
  const rows = [];
  for (let i = 0; i < items.length; i += perRow) {
    const row = [];
    for (const item of items.slice(i, i + perRow)) {
      row.push(cell(item.label, 'muted'), cellSegs(item.value));
    }
    rows.push(row);
  }
  return rows;
};

const pickGroups = (folders, exts, rows) => {
  const count = Math.max(0, rows);
  const dirs = folders.slice(0, count);
  const left = Math.max(0, count - dirs.length);
  return { dirs, exts: exts.slice(0, left) };
};

const labelOf = (key, isDir) => {
  if (isDir) return key === '.' ? '/' : key;
  return key.startsWith('.') ? `*${key}` : key;
};

module.exports = {
  HEAT_MS,
  num,
  size,
  ago,
  duration,
  isHot,
  delta,
  cell,
  cellSegs,
  flexCell,
  tableLines,
  stat,
  pairRows,
  pickGroups,
  labelOf,
  withTitle,
  titleAside,
  captionOver,
  layoutRows,
};
