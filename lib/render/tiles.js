'use strict';

const ansi = require('../ansi.js');
const { THEME, paint, visibleWidth, truncateVisible } = ansi;

const GAP_X = 2;
const GAP_Y = 1;
const MIN_W = 34;
const MIN_H = 6;
const MAX_COLS = 4;
const RULE = '─';
const BAR_ON = '█';
const BAR_OFF = '░';
const SPARK = '▁▂▃▄▅▆▇█';
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

const seg = (text, tone = 'text', bold = false) => ({
  text: `${text}`,
  tone,
  bold,
});

const toneColors = () => ({
  text: THEME.chromeFg,
  muted: THEME.mutedFg,
  hot: THEME.buttonHotFg,
  add: THEME.addLineFg,
  del: THEME.delLineFg,
  warn: THEME.warnFg,
  error: THEME.errorFg,
  sha: THEME.shaFg,
  trend: THEME.dashTrendFg,
  key: THEME.dashKeyFg,
});

const segmentsWidth = (segs) => {
  let width = 0;
  for (const item of segs) width += visibleWidth(item.text);
  return width;
};

const ELLIPSIS = '…';

const clipSegments = (segs, width) => {
  if (segmentsWidth(segs) <= width) {
    return segs.map((item) => ({ ...item }));
  }
  const markW = visibleWidth(ELLIPSIS);
  const budget = markW <= width ? width - markW : width;
  const out = [];
  let used = 0;
  for (const item of segs) {
    const room = budget - used;
    if (room <= 0) break;
    const text = truncateVisible(item.text, room);
    if (!text) continue;
    used += visibleWidth(text);
    out.push({ ...item, text });
    if (visibleWidth(text) < visibleWidth(item.text)) break;
  }
  if (markW > width) return out;
  if (!out.length) return [{ text: ELLIPSIS, tone: 'text', bold: false }];
  const last = out[out.length - 1];
  last.text += ELLIPSIS;
  return out;
};

const paintSegments = (segs, width, bg, color, fill = ' ', colors = null) => {
  const clipped = clipSegments(segs, width);
  const pad = Math.max(0, width - segmentsWidth(clipped));
  const ink = colors ?? toneColors();
  if (!color) {
    return clipped.map((item) => item.text).join('') + fill.repeat(pad);
  }
  let out = '';
  for (const item of clipped) {
    out += paint(item.text, ink[item.tone], bg, color, item.bold);
  }
  return out + paint(fill.repeat(pad), ink.muted, bg, color);
};

const headColors = () => {
  const colors = toneColors();
  colors.muted = THEME.dashHeadMuted;
  colors.del = THEME.dashDelFg;
  return colors;
};

const padText = (text, width, align = 'l') => {
  const pad = Math.max(0, width - visibleWidth(text));
  const gap = ' '.repeat(pad);
  return align === 'r' ? `${gap}${text}` : `${text}${gap}`;
};

const bar = (ratio, width) => {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0));
  const on = Math.round(clamped * width);
  return { on: BAR_ON.repeat(on), off: BAR_OFF.repeat(width - on) };
};

const barSegments = (ratio, width, tone = 'add') => {
  const parts = bar(ratio, width);
  return [seg(parts.on, tone), seg(parts.off, 'muted')];
};

const sparkline = (values, width) => {
  const count = values.length;
  if (!count || width < 1) return '';
  const max = Math.max(...values);
  const top = SPARK.length - 1;
  let out = '';
  for (let i = 0; i < width; i++) {
    const span = width <= 1 ? count - 1 : (i * (count - 1)) / (width - 1);
    const at = Math.round(span);
    const level = max > 0 ? Math.round((values[at] / max) * top) : 0;
    out += SPARK[level];
  }
  return out;
};

const spinner = (frame) => SPINNER[Math.abs(frame ?? 0) % SPINNER.length];

const spread = (total, parts) => {
  const base = Math.floor(total / parts);
  const extra = total % parts;
  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0));
};

const placeBand = (shown, from, size, width) => {
  const room = Math.max(0, width - (size - 1) * GAP_X);
  const widths = spread(room, size);
  const tiles = [];
  let x = 0;
  for (let i = 0; i < size; i++) {
    tiles.push({ id: shown[from + i].id, x, w: widths[i] });
    x += widths[i] + GAP_X;
  }
  return tiles;
};

const placeTiles = (shown, cols, width, height) => {
  const rows = Math.ceil(shown.length / cols);
  const sizes = spread(shown.length, rows);
  const heights = spread(height - (rows - 1) * GAP_Y, rows);
  const bands = [];
  let from = 0;
  let y = 0;
  for (let row = 0; row < rows; row++) {
    const tiles = placeBand(shown, from, sizes[row], width);
    bands.push({ y, h: Math.max(1, heights[row]), tiles });
    from += sizes[row];
    y += heights[row] + GAP_Y;
  }
  return bands;
};

const layoutTiles = (width, height, tiles) => {
  const cap = Math.floor((width + GAP_X) / (MIN_W + GAP_X));
  const maxCols = Math.max(1, Math.min(MAX_COLS, cap));
  const ranked = [...tiles].sort((left, right) => left.rank - right.rank);
  for (let count = tiles.length; count >= 1; count--) {
    const keep = new Set(ranked.slice(0, count).map((tile) => tile.id));
    const shown = tiles.filter((tile) => keep.has(tile.id));
    const cols = Math.min(maxCols, count);
    const rows = Math.ceil(count / cols);
    const rowH = Math.floor((height - (rows - 1) * GAP_Y) / rows);
    if (rowH >= MIN_H || count === 1) {
      return placeTiles(shown, cols, width, height);
    }
  }
  return [];
};

const titleSegments = (tile, badge) => {
  const keyed = tile.title.startsWith(tile.key);
  const rest = keyed ? tile.title.slice(tile.key.length) : ` ${tile.title}`;
  const left = [seg(' '), seg(tile.key, 'key', true), seg(rest)];
  if (!badge.length) return left;
  return [...left, seg(' '), ...badge];
};

const paintTitle = (tile, badge, width, color) => {
  const fill = color ? ' ' : RULE;
  const segs = titleSegments(tile, badge);
  const colors = headColors();
  return paintSegments(segs, width, THEME.dashHeadBg, color, fill, colors);
};

const paintEdgeLine = (line, inner, bg, color) => {
  const edge = paintSegments([seg(' ')], 1, bg, color);
  return edge + paintSegments(line, inner, bg, color) + edge;
};

const paintHead = (tile, content, width, color) => {
  if (!content.titleLine) return paintTitle(tile, content.badge, width, color);
  const fill = color ? ' ' : RULE;
  const inner = Math.max(0, width - 2);
  const bg = THEME.dashHeadBg;
  const colors = headColors();
  const edge = paintSegments([seg(' ')], 1, bg, color, fill, colors);
  const body = paintSegments(content.titleLine, inner, bg, color, fill, colors);
  return edge + body + edge;
};

const rowBackground = (index, filled) => {
  if (filled && index % 2 === 1) return THEME.dashRowBg;
  return THEME.dashTileBg;
};

const paintTile = (tile, content, width, height, color) => {
  const inner = Math.max(0, width - 2);
  const lines = content.lines ?? [];
  const rows = [paintHead(tile, content, width, color)];
  const room = Math.max(0, height - 1);
  const footer = content.footer || null;
  const foot = footer && room > 0 ? 1 : 0;
  const bodyRoom = room - foot;
  for (let i = 0; i < bodyRoom; i++) {
    const line = lines[i] ?? [];
    const bg = rowBackground(i, i < lines.length);
    rows.push(paintEdgeLine(line, inner, bg, color));
  }
  if (foot) {
    const bg = rowBackground(bodyRoom, true);
    rows.push(paintEdgeLine(footer, inner, bg, color));
  }
  return rows.slice(0, height);
};

const pageFill = (width, color) =>
  paint(' '.repeat(Math.max(0, width)), THEME.chromeFg, THEME.dashBg, color);

const composeBands = (bands, painted, width, height, color) => {
  const rows = [];
  const blank = pageFill(width, color);
  for (const band of bands) {
    if (rows.length) {
      for (let gap = 0; gap < GAP_Y; gap++) rows.push(blank);
    }
    for (let line = 0; line < band.h; line++) {
      let row = '';
      let used = 0;
      for (let i = 0; i < band.tiles.length; i++) {
        const tile = band.tiles[i];
        if (i) row += pageFill(GAP_X, color);
        row += painted.get(tile.id)[line];
        used += tile.w + (i ? GAP_X : 0);
      }
      rows.push(row + pageFill(width - used, color));
    }
  }
  while (rows.length < height) rows.push(blank);
  return rows.slice(0, height);
};

const tileHits = (bands, headerLines) => {
  const hits = [];
  for (const band of bands) {
    for (const tile of band.tiles) {
      for (let line = 0; line < band.h; line++) {
        const y = headerLines + band.y + line + 1;
        hits.push({ y, x0: tile.x, x1: tile.x + tile.w, cursor: tile.id });
      }
    }
  }
  return hits;
};

module.exports = {
  GAP_X,
  GAP_Y,
  MIN_W,
  MIN_H,
  seg,
  segmentsWidth,
  clipSegments,
  paintSegments,
  padText,
  bar,
  barSegments,
  sparkline,
  spinner,
  spread,
  layoutTiles,
  paintTile,
  composeBands,
  tileHits,
  pageFill,
};
