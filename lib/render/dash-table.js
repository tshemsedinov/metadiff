'use strict';

const commands = require('../npm-commands.js');
const { formatSize } = commands;
const files = require('../files.js');
const { relativeAge } = files;
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

const size = (bytes) => formatSize(bytes);

const ago = (at, now) => (at ? relativeAge(at, now) : '');

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
      if (!item || item.flex) continue;
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

const usedWidth = (widths, use, gap) => {
  let total = 0;
  for (let c = 0; c < use; c++) total += widths[c] + (c ? gap : 0);
  return total;
};

const pickColumns = (rows, width, gap) => {
  const count = Math.max(0, ...rows.map((row) => row.length));
  const widths = columnWidths(rows, count);
  const flex = flexColumn(rows, count);
  let use = count;
  while (use > 1) {
    const need = flex >= 0 && flex < use ? MIN_FLEX : 0;
    if (usedWidth(widths, use, gap) + need <= width) break;
    use -= 1;
  }
  const room = width - usedWidth(widths, use, gap);
  if (flex >= 0 && flex < use) widths[flex] = Math.max(0, room);
  return { use, widths, flex };
};

const flexSegments = (item, room) => {
  const clipped = clipSegments(item.segs, room);
  const pad = Math.max(0, room - segmentsWidth(clipped));
  return [...clipped, seg(' '.repeat(pad))];
};

const tableLines = (rows, width, gap = 2) => {
  if (!rows.length) return [];
  const { use, widths, flex } = pickColumns(rows, width, gap);
  return rows.map((row) => {
    const line = [];
    for (let c = 0; c < use; c++) {
      const item = row[c] ?? blankCell;
      if (c) line.push(seg(' '.repeat(gap)));
      if (c === flex) {
        line.push(...flexSegments(item, widths[c]));
        continue;
      }
      const pad = ' '.repeat(Math.max(0, widths[c] - segmentsWidth(item.segs)));
      if (item.align === 'r') line.push(seg(pad), ...item.segs);
      else line.push(...item.segs, seg(pad));
    }
    return line;
  });
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
  let dirs = Math.min(folders.length, Math.ceil(rows / 2));
  const extra = Math.min(exts.length, Math.max(0, rows - dirs));
  dirs = Math.min(folders.length, Math.max(0, rows - extra));
  return { dirs: folders.slice(0, dirs), exts: exts.slice(0, extra) };
};

const labelOf = (key, isDir) => {
  if (!isDir) return key;
  return key === '.' ? './' : `${key}/`;
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
};
