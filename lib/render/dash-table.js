'use strict';

const metautil = require('metautil');
const { bytesToSize } = metautil;
const files = require('../files.js');
const { relativeAge } = files;
const ansi = require('../ansi.js');
const { visibleWidth, graphemes, graphemeWidth } = ansi;
const tiles = require('./tiles.js');
const { seg, segmentsWidth, clipSegments, titleSegments } = tiles;
const tree = require('../dashboard/tree.js');
const { HEAT_MS } = tree;

const MIN_FLEX = 6;
const SECONDS_AGO = /^\d+s ago$/;

const trimmed = (value) =>
  value >= 10 ? `${Math.round(value)}` : `${Math.round(value * 10) / 10}`;

const num = (value) => {
  const n = Math.max(0, Math.round(value));
  if (n >= 1e6) return `${trimmed(n / 1e6)}m`;
  if (n >= 1e4) return `${trimmed(n / 1e3)}k`;
  return `${n}`;
};

const size = (bytes) => bytesToSize(bytes > 0 ? bytes : 0);

const ago = (at, now) => {
  if (!at) return '';
  const text = relativeAge(at, now);
  return SECONDS_AGO.test(text) ? '<1m ago' : text;
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

const waiting = (text) => ({ badge: [], lines: [[seg(text, 'muted')]] });

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
    const owner = rows.find((row) => row[c] && typeof row[c].gap === 'number');
    if (!owner) continue;
    gaps[c] = owner[c].gap;
    fixed[c] = true;
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

const flexFloor = (rows, index) => {
  let floor = null;
  for (const row of rows) {
    const item = row[index];
    if (!item || !item.flex || typeof item.min !== 'number') continue;
    floor = floor === null ? item.min : Math.min(floor, item.min);
  }
  return floor;
};

const pickColumns = (rows, width, gap, spread) => {
  const count = Math.max(0, ...rows.map((row) => row.length));
  const widths = columnWidths(rows, count);
  const flex = flexColumn(rows, count);
  const keep = flex >= 0 && rows.some((row) => row[flex] && row[flex].keep);
  const floor = flex >= 0 && !keep ? flexFloor(rows, flex) : null;
  const minFlex = floor ?? MIN_FLEX;
  const reserve = floor ?? 0;
  const { gaps, fixed } = columnGaps(rows, count, gap);
  closeEmpty(widths, gaps, fixed);
  let use = count;
  while (use > 1) {
    const shrinks = flex >= 0 && flex < use && !keep;
    const used = usedWidth(widths, use, gaps);
    const need = shrinks ? minFlex : 0;
    if (used + need <= width) break;
    const trailing = shrinks && flex < use - 1;
    if (trailing && used + reserve <= width) break;
    if (keep && flex === use - 1) break;
    use -= 1;
  }
  const room = width - usedWidth(widths, use, gaps);
  if (flex >= 0 && flex < use) widths[flex] = Math.max(0, widths[flex] + room);
  else if (spread) widenGaps(gaps, fixed, use, room);
  return { use, widths, flex, gaps };
};

const flexSegments = (item, room) => {
  const clipped = clipSegments(item.segs, room);
  const pad = Math.max(0, room - segmentsWidth(clipped));
  return [...clipped, seg(' '.repeat(pad))];
};

const renderRow = (row, columns) => {
  const { use, widths, flex, gaps } = columns;
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
  const columns = pickColumns(rows, width, gap, spread);
  return rows.map((row) => renderRow(row, columns));
};

const tailVisible = (text, skip) => {
  let left = skip;
  let col = 0;
  let out = '';
  for (const ch of graphemes(text)) {
    const w = graphemeWidth(ch, col);
    col += w;
    if (left > 0) left -= w;
    else out += ch;
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
  const caption = titleSegments(tile, badge);
  return [...caption, ...skipSegments(line, segmentsWidth(caption))];
};

const titleAside = (tile, aside, width, badge = []) => {
  const left = titleSegments(tile, badge);
  const gap = width - segmentsWidth(left) - segmentsWidth(aside);
  return [...left, seg(' '.repeat(Math.max(1, gap))), ...aside];
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
  return { dirs, exts: exts.slice(0, count - dirs.length) };
};

const labelOf = (key, isDir) => {
  if (isDir) return key === '.' ? '/' : key;
  return key.startsWith('.') ? `*${key}` : key;
};

module.exports = {
  num,
  size,
  ago,
  duration,
  isHot,
  delta,
  waiting,
  cell,
  cellSegs,
  flexCell,
  tableLines,
  stat,
  pairRows,
  pickGroups,
  labelOf,
  titleAside,
  captionOver,
};
