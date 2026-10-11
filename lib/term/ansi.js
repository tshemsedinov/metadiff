'use strict';

const { resource } = require('../common/utilities.js');

const ASCII_RE = /^[\x20-\x7e]*$/;

let segmenter = null;

const segments = (text) => {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return segmenter.segment(text);
};

const ESC = String.fromCodePoint(0x1b);
const CSI_RE = `${ESC}\\[[0-9;?]*[ -/]*[@-~]`;
const OSC_RE = `${ESC}\\][^\x07\x1b]*(?:\x07|${ESC}\\\\)`;
const ANSI_RE = new RegExp(`${CSI_RE}|${OSC_RE}`, 'g');
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const EL = `${ESC}[K`;
const ST = `${ESC}\\`;

const WIDE_CP = resource(__dirname, 'wide.txt')
  .split(/[\s-]+/)
  .filter(Boolean)
  .map((cp) => parseInt(cp, 16));

const rgbOf = (hex) =>
  [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));

const colorsOf = (map) => {
  const colors = {};
  for (const key of Object.keys(map)) colors[key] = rgbOf(map[key]);
  return colors;
};

const paletteOf = ({ ui, code, logCols }) => ({
  ui: colorsOf(ui),
  code: colorsOf(code),
  logCols: logCols.map(rgbOf),
});

const PALETTES = {
  dark: paletteOf(require('./themes/dark.json')),
  light: paletteOf(require('./themes/light.json')),
};
const THEME_NAMES = Object.keys(PALETTES);

const applyColors = (into, from) => {
  for (const key of Object.keys(from)) {
    const src = from[key];
    const dst = into[key];
    dst[0] = src[0];
    dst[1] = src[1];
    dst[2] = src[2];
  }
};

const THEME = structuredClone(PALETTES.dark.ui);
const CODE_FG = structuredClone(PALETTES.dark.code);
const LOG_COL_FG = structuredClone(PALETTES.dark.logCols);
let currentTheme = 'dark';

const setTheme = (name) => {
  if (!Object.hasOwn(PALETTES, name)) {
    throw new Error(`unknown theme ${name}`);
  }
  const palette = PALETTES[name];
  applyColors(THEME, palette.ui);
  applyColors(CODE_FG, palette.code);
  applyColors(LOG_COL_FG, palette.logCols);
  currentTheme = name;
};

const themeName = () => currentTheme;

const codeFg = (style) => {
  if (typeof style !== 'string') return CODE_FG.plain;
  if (Object.hasOwn(CODE_FG, style)) return CODE_FG[style];
  if (style.startsWith('logCol')) {
    const i = parseInt(style.slice(6), 10);
    return LOG_COL_FG[i % LOG_COL_FG.length];
  }
  return CODE_FG.plain;
};

const channels = (rgb) => {
  if (typeof rgb === 'number') return `${rgb};${rgb};${rgb}`;
  return `${rgb[0]};${rgb[1]};${rgb[2]}`;
};

const fg = (rgb) => `${ESC}[38;2;${channels(rgb)}m`;

const bg = (rgb) => `${ESC}[48;2;${channels(rgb)}m`;

const seq = (fgRgb, bgRgb) => `${fg(fgRgb)}${bg(bgRgb)}`;

const paint = (text, fgRgb, bgRgb, color, bold) => {
  if (!color || text === '') return text;
  const mark = bold ? BOLD : '';
  return `${mark}${seq(fgRgb, bgRgb)}${text}${RESET}`;
};

const hyperlink = (href, label) => {
  const uri = `${href ?? ''}`.replaceAll(ESC, '').replaceAll('\x07', '');
  const text = `${label ?? ''}`;
  if (!uri || !text) return text;
  return `${ESC}]8;;${uri}${ST}${text}${ESC}]8;;${ST}`;
};

const stripAnsi = (text) => text.replace(ANSI_RE, '');

const graphemes = (text) => {
  if (ASCII_RE.test(text)) return text.split('');
  const parts = new Array(text.length);
  let n = 0;
  for (const { segment } of segments(text)) parts[n++] = segment;
  parts.length = n;
  return parts;
};

const isWide = (cp) => {
  let lo = 0;
  let hi = WIDE_CP.length >> 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const start = WIDE_CP[mid << 1];
    const end = WIDE_CP[(mid << 1) + 1];
    if (cp < start) hi = mid;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
};

const graphemeWidth = (ch, col) => {
  if (ch === '\t') return 8 - (col % 8);
  if (ch === '\n' || ch === '\r') return 0;
  const cp = ch.codePointAt(0);
  if (cp >= 0x20 && cp < 0x7f) return 1;
  if (cp <= 0x1f || cp === 0x7f) return 0;
  if (cp === 0x200d) return 0;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 0;
  if (isWide(cp)) return 2;
  return 1;
};

const plainText = (text) => (text.includes(ESC) ? stripAnsi(text) : text);

const visibleWidth = (text) => {
  const plain = plainText(text);
  if (ASCII_RE.test(plain)) return plain.length;
  let width = 0;
  for (const ch of graphemes(plain)) {
    width += graphemeWidth(ch, width);
  }
  return width;
};

const truncateVisible = (text, width, mark = '') => {
  if (width <= 0) return '';
  const plain = plainText(text);
  if (visibleWidth(plain) <= width) return text;
  const markW = mark ? visibleWidth(mark) : 0;
  const fits = markW > 0 && markW <= width;
  const limit = fits ? width - markW : width;
  let out = '';
  if (ASCII_RE.test(plain)) {
    out = plain.slice(0, limit);
  } else {
    let used = 0;
    for (const ch of graphemes(plain)) {
      const w = graphemeWidth(ch, used);
      if (used + w > limit) break;
      out += ch;
      used += w;
    }
  }
  return fits ? `${out}${mark}` : out;
};

const trimVisible = (text, width) => truncateVisible(text, width, '…');

const csiLength = (text, index) => {
  if (text[index] !== ESC || text[index + 1] !== '[') return 0;
  let at = index + 2;
  while (at < text.length) {
    const code = text.charCodeAt(at);
    at += 1;
    if (code >= 64 && code <= 126) return at - index;
  }
  return 0;
};

const oscLength = (text, index) => {
  if (text[index] !== ESC || text[index + 1] !== ']') return 0;
  let at = index + 2;
  while (at < text.length) {
    if (text[at] === '\x07') return at + 1 - index;
    if (text[at] === ESC && text[at + 1] === '\\') return at + 2 - index;
    at += 1;
  }
  return 0;
};

const ansiLength = (text, index) =>
  csiLength(text, index) || oscLength(text, index);

const firstGrapheme = (text) => {
  const next = segments(text)[Symbol.iterator]().next();
  if (next.done || !next.value) return '';
  return next.value.segment;
};

const graphemeAt = (text, index) => {
  const code = text.charCodeAt(index);
  const plain = code >= 0x20 && code < 0x7f;
  if (plain && !(text.charCodeAt(index + 1) >= 0x300)) return text[index];
  return firstGrapheme(text.slice(index));
};

const takeVisible = (text, width) => {
  const raw = `${text ?? ''}`;
  if (width <= 0) return '';
  let used = 0;
  let index = 0;
  let fits = true;
  while (fits && index < raw.length && used < width) {
    const skip = ansiLength(raw, index);
    if (skip) {
      index += skip;
      continue;
    }
    const next = raw.indexOf(ESC, index + 1);
    const run = raw.slice(index, next < 0 ? raw.length : next);
    for (const { segment } of segments(run)) {
      const w = graphemeWidth(segment, used);
      fits = used + w <= width;
      if (!fits) break;
      used += w;
      index += segment.length;
      if (used >= width) break;
    }
  }
  return raw.slice(0, index);
};

const clipAnsi = (text, width) => {
  const raw = `${text ?? ''}`;
  if (width <= 0) return '';
  if (visibleWidth(raw) <= width) return raw;
  let out = takeVisible(raw, width);
  if (stripAnsi(out) !== stripAnsi(raw)) out += RESET;
  return out;
};

const dropVisible = (text, skip) => {
  const raw = `${text ?? ''}`;
  if (skip <= 0) return raw;
  let used = 0;
  let index = 0;
  let style = '';
  while (index < raw.length && used < skip) {
    const ansi = ansiLength(raw, index);
    if (ansi) {
      const seq = raw.slice(index, index + ansi);
      if (seq[1] === '[' && seq.endsWith('m')) style = seq;
      index += ansi;
      continue;
    }
    const ch = graphemeAt(raw, index);
    if (!ch) break;
    const w = graphemeWidth(ch, used);
    if (used + w > skip) break;
    used += w;
    index += ch.length;
  }
  const rest = raw.slice(index);
  if (!style) return rest;
  return `${style}${rest}`;
};

const stampVisible = (line, x, face) => {
  const raw = `${line ?? ''}`;
  const mark = `${face ?? ''}`;
  const at = Math.max(0, x);
  const left = takeVisible(raw, at);
  const right = dropVisible(raw, at + visibleWidth(mark));
  return `${left}${mark}${right}`;
};

const sgrParams = (seq) => {
  const inner = seq.slice(2, -1);
  if (!inner) return [0];
  return inner.split(';').map((part) => (part === '' ? 0 : Number(part)));
};

const colorSpan = (params, index) => {
  const mode = params[index + 1];
  if (mode === 5) return 2;
  if (mode === 2) return 4;
  return 0;
};

const keepFgParams = (params) => {
  const kept = [];
  for (let i = 0; i < params.length; i++) {
    const code = params[i];
    if (code === 38 || code === 48) {
      const extra = colorSpan(params, i);
      if (code === 38 && extra) {
        kept.push(code, ...params.slice(i + 1, i + 1 + extra));
      }
      i += extra;
      continue;
    }
    if (code >= 40 && code <= 49) continue;
    if (code >= 100 && code <= 107) continue;
    if (code === 7 || code === 27) continue;
    kept.push(code);
  }
  return kept;
};

const foregroundOn = (text, bgRgb) => {
  const raw = `${text ?? ''}`;
  const ground = bg(bgRgb);
  let out = '';
  let index = 0;
  while (index < raw.length) {
    if (raw[index] !== ESC) {
      const next = raw.indexOf(ESC, index);
      const end = next < 0 ? raw.length : next;
      out += raw.slice(index, end);
      index = end;
      continue;
    }
    const skip = ansiLength(raw, index);
    if (!skip) {
      out += raw[index];
      index += 1;
      continue;
    }
    const seq = raw.slice(index, index + skip);
    index += skip;
    if (seq[1] !== '[' || !seq.endsWith('m')) {
      out += seq;
      continue;
    }
    const kept = keepFgParams(sgrParams(seq));
    const reset = kept.includes(0);
    const rest = kept.filter((code) => code !== 0);
    if (reset) out += RESET;
    out += ground;
    if (rest.length) out += `${ESC}[${rest.join(';')}m`;
  }
  return out;
};

module.exports = {
  ESC,
  RESET,
  BOLD,
  EL,
  THEME,
  CODE_FG,
  PALETTES,
  THEME_NAMES,
  setTheme,
  themeName,
  codeFg,
  fg,
  bg,
  seq,
  paint,
  hyperlink,
  stripAnsi,
  graphemes,
  graphemeWidth,
  visibleWidth,
  truncateVisible,
  trimVisible,
  firstGrapheme,
  graphemeAt,
  clipAnsi,
  stampVisible,
  foregroundOn,
};
