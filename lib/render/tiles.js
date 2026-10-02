'use strict';

const ansi = require('../ansi.js');
const { THEME, paint, visibleWidth, truncateVisible } = ansi;

const GAP_X = 2;
const GAP_Y = 1;
const MIN_W = 34;
const MIN_H = 6;
const MAX_COLS = 4;
const RULE = '─';
const ELLIPSIS = '…';
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

const headColors = () => ({
  ...toneColors(),
  muted: THEME.dashHeadMuted,
  del: THEME.dashDelFg,
});

const segmentsWidth = (segs) => {
  let width = 0;
  for (const item of segs) width += visibleWidth(item.text);
  return width;
};

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
  if (!out.length) return [seg(ELLIPSIS)];
  out[out.length - 1].text += ELLIPSIS;
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

const barSegments = (ratio, width, tone = 'add') => {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0));
  const on = Math.round(clamped * width);
  return [
    seg(BAR_ON.repeat(on), tone),
    seg(BAR_OFF.repeat(width - on), 'muted'),
  ];
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

const titleSegments = (tile, badge = []) => {
  const keyed = tile.title.startsWith(tile.key);
  const rest = keyed ? tile.title.slice(tile.key.length) : ` ${tile.title}`;
  const segs = [seg(tile.key, 'key', true), seg(rest)];
  return badge.length ? [...segs, seg(' '), ...badge] : segs;
};

const paintFramed = (line, width, bg, color, fill = ' ', colors = null) => {
  const edge = paintSegments([seg(' ')], 1, bg, color);
  const inner = Math.max(0, width - 2);
  return edge + paintSegments(line, inner, bg, color, fill, colors) + edge;
};

const paintHead = (tile, content, width, color, headBg) => {
  const fill = color ? ' ' : RULE;
  const bg = headBg;
  const colors = headColors();
  if (content.titleLine) {
    return paintFramed(content.titleLine, width, bg, color, fill, colors);
  }
  const segs = [seg(' '), ...titleSegments(tile, content.badge)];
  return paintSegments(segs, width, bg, color, fill, colors);
};

const rowBackground = (index, filled, backs) => {
  if (filled && index % 2 === 1) return backs.row;
  return backs.tile;
};

const paintTile = (tile, content, width, height, color, backs = null) => {
  const shade = backs ?? {
    head: THEME.dashHeadBg,
    tile: THEME.dashTileBg,
    row: THEME.dashRowBg,
  };
  const { lines, footer } = content;
  const rows = [paintHead(tile, content, width, color, shade.head)];
  const bodyRoom = footer ? height - 2 : height - 1;
  for (let i = 0; i < bodyRoom; i++) {
    const bg = rowBackground(i, i < lines.length, shade);
    rows.push(paintFramed(lines[i] ?? [], width, bg, color));
  }
  if (footer && height > 1) {
    const bg = rowBackground(bodyRoom, true, shade);
    rows.push(paintFramed(footer, width, bg, color));
  }
  return rows;
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
    const last = band.tiles.at(-1);
    const rest = pageFill(width - last.x - last.w, color);
    for (let line = 0; line < band.h; line++) {
      let row = '';
      for (let i = 0; i < band.tiles.length; i++) {
        if (i) row += pageFill(GAP_X, color);
        row += painted.get(band.tiles[i].id)[line];
      }
      rows.push(row + rest);
    }
  }
  while (rows.length < height) rows.push(blank);
  return rows.slice(0, height);
};

const gridSize = (width, height, cols, rows) => ({
  tileW: Math.floor((width - (cols - 1) * GAP_X) / cols),
  tileH: Math.floor((height - (rows - 1) * GAP_Y) / rows),
});

const equalGrid = (width, height, count, minW = MIN_W, minH = MIN_H) => {
  const safe = Math.max(1, count);
  const colCap = Math.max(
    1,
    Math.min(safe, Math.floor((width + GAP_X) / (minW + GAP_X)) || 1),
  );
  const rowCap = Math.max(
    1,
    Math.min(safe, Math.floor((height + GAP_Y) / (minH + GAP_Y)) || 1),
  );
  let best = null;
  for (let cols = 1; cols <= colCap; cols++) {
    for (let rows = 1; rows <= rowCap; rows++) {
      const size = gridSize(width, height, cols, rows);
      if (size.tileW < minW || size.tileH < minH) continue;
      const cap = cols * rows;
      const shown = Math.min(safe, cap);
      const score = shown * 1000000 + size.tileW * size.tileH;
      if (!best || score > best.score) {
        best = { cols, rows, cap, ...size, score };
      }
    }
  }
  if (best) return best;
  return {
    cols: 1,
    rows: 1,
    cap: 1,
    tileW: Math.max(1, width),
    tileH: Math.max(1, height),
    score: 0,
  };
};

const pageWindow = (count, cursor, cap) => {
  const room = Math.max(1, cap);
  if (count <= room) return { start: 0, end: count };
  const at = Math.min(Math.max(0, cursor), count - 1);
  let start = Math.floor(at / room) * room;
  if (start + room > count) start = count - room;
  return { start, end: start + room };
};

const placeEqualTiles = (tiles, grid) => {
  const bands = [];
  const cols = Math.max(1, grid.cols);
  const rows = Math.ceil(tiles.length / cols);
  for (let row = 0; row < rows; row++) {
    const slice = tiles.slice(row * cols, (row + 1) * cols);
    if (!slice.length) break;
    const placed = [];
    for (let i = 0; i < slice.length; i++) {
      placed.push({
        id: slice[i].id,
        x: i * (grid.tileW + GAP_X),
        w: grid.tileW,
      });
    }
    bands.push({
      y: row * (grid.tileH + GAP_Y),
      h: grid.tileH,
      tiles: placed,
    });
  }
  return bands;
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
  seg,
  segmentsWidth,
  clipSegments,
  barSegments,
  sparkline,
  spinner,
  titleSegments,
  layoutTiles,
  equalGrid,
  pageWindow,
  placeEqualTiles,
  paintTile,
  composeBands,
  tileHits,
  pageFill,
};
