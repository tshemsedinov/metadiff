'use strict';

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const ESC = String.fromCodePoint(0x1b);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const EL = `${ESC}[K`;

const WIDE_CP = [
  0x1100, 0x115f, 0x231a, 0x231b, 0x2329, 0x232a, 0x23e9, 0x23ec, 0x23f0,
  0x23f0, 0x23f3, 0x23f3, 0x25fd, 0x25fe, 0x2614, 0x2615, 0x2630, 0x2637,
  0x2648, 0x2653, 0x267f, 0x267f, 0x268a, 0x268f, 0x2693, 0x2693, 0x26a1,
  0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26ce,
  0x26d4, 0x26d4, 0x26ea, 0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26f5, 0x26fa,
  0x26fa, 0x26fd, 0x26fd, 0x2705, 0x2705, 0x270a, 0x270b, 0x2728, 0x2728,
  0x274c, 0x274c, 0x274e, 0x274e, 0x2753, 0x2755, 0x2757, 0x2757, 0x2795,
  0x2797, 0x27b0, 0x27b0, 0x27bf, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b50,
  0x2b55, 0x2b55, 0x2e80, 0x2e99, 0x2e9b, 0x2ef3, 0x2f00, 0x2fd5, 0x2ff0,
  0x303e, 0x3041, 0x3096, 0x3099, 0x30ff, 0x3105, 0x312f, 0x3131, 0x318e,
  0x3190, 0x31e5, 0x31ef, 0x321e, 0x3220, 0x3247, 0x3250, 0xa48c, 0xa490,
  0xa4c6, 0xa960, 0xa97c, 0xac00, 0xd7a3, 0xf900, 0xfaff, 0xfe10, 0xfe19,
  0xfe30, 0xfe52, 0xfe54, 0xfe66, 0xfe68, 0xfe6b, 0xff01, 0xff60, 0xffe0,
  0xffe6, 0x16fe0, 0x16fe4, 0x16ff0, 0x16ff1, 0x17000, 0x187f7, 0x18800,
  0x18cd5, 0x18cff, 0x18d08, 0x1aff0, 0x1aff3, 0x1aff5, 0x1affb, 0x1affd,
  0x1affe, 0x1b000, 0x1b122, 0x1b132, 0x1b132, 0x1b150, 0x1b152, 0x1b155,
  0x1b155, 0x1b164, 0x1b167, 0x1b170, 0x1b2fb, 0x1d300, 0x1d356, 0x1d360,
  0x1d376, 0x1f004, 0x1f004, 0x1f0cf, 0x1f0cf, 0x1f18e, 0x1f18e, 0x1f191,
  0x1f19a, 0x1f200, 0x1f202, 0x1f210, 0x1f23b, 0x1f240, 0x1f248, 0x1f250,
  0x1f251, 0x1f260, 0x1f265, 0x1f300, 0x1f320, 0x1f32d, 0x1f335, 0x1f337,
  0x1f37c, 0x1f37e, 0x1f393, 0x1f3a0, 0x1f3ca, 0x1f3cf, 0x1f3d3, 0x1f3e0,
  0x1f3f0, 0x1f3f4, 0x1f3f4, 0x1f3f8, 0x1f43e, 0x1f440, 0x1f440, 0x1f442,
  0x1f4fc, 0x1f4ff, 0x1f53d, 0x1f54b, 0x1f54e, 0x1f550, 0x1f567, 0x1f57a,
  0x1f57a, 0x1f595, 0x1f596, 0x1f5a4, 0x1f5a4, 0x1f5fb, 0x1f64f, 0x1f680,
  0x1f6c5, 0x1f6cc, 0x1f6cc, 0x1f6d0, 0x1f6d2, 0x1f6d5, 0x1f6d7, 0x1f6dc,
  0x1f6df, 0x1f6eb, 0x1f6ec, 0x1f6f4, 0x1f6fc, 0x1f7e0, 0x1f7eb, 0x1f7f0,
  0x1f7f0, 0x1f90c, 0x1f93a, 0x1f93c, 0x1f945, 0x1f947, 0x1f9ff, 0x1fa70,
  0x1fa7c, 0x1fa80, 0x1fa89, 0x1fa8f, 0x1fac6, 0x1face, 0x1fadc, 0x1fadf,
  0x1fae9, 0x1faf0, 0x1faf8, 0x20000, 0x2fffd, 0x30000, 0x3fffd,
];

const DARK_UI = {
  delLineFg: [0xcc, 0x7a, 0x7a],
  delLineBg: [0x3a, 0x1a, 0x1a],
  delCharFg: [0xff, 0xff, 0xff],
  delCharBg: [0x75, 0x22, 0x22],
  addLineFg: [0x7a, 0xcc, 0x8a],
  addLineBg: [0x14, 0x28, 0x14],
  addCharFg: [0xff, 0xff, 0xff],
  addCharBg: [0x1a, 0x4c, 0x26],
  ctxFg: [0x8a, 0x8a, 0x8a],
  ctxBg: [0x12, 0x12, 0x18],
  splitGutterFg: [0x18, 0x18, 0x24],
  splitGutterBg: [0x18, 0x18, 0x24],
  headerFg: [0x3a, 0x3a, 0x3a],
  headerBg: [0xe6, 0xe6, 0xee],
  headerChromeFg: [0x5a, 0x5a, 0x5a],
  headerRepoFg: [0x3a, 0x3a, 0x3a],
  headerDirFg: [0x6e, 0x6e, 0x6e],
  headerSlashFg: [0x8a, 0x8a, 0x8a],
  headerFileFg: [0x4e, 0x4e, 0x4e],
  chromeFg: [0xd0, 0xd0, 0xe0],
  chromeBg: [0x18, 0x18, 0x24],
  noteBg: [0x24, 0x24, 0x36],
  buttonFg: [0x6a, 0x6a, 0x7e],
  buttonBg: [0x2a, 0x2a, 0x40],
  buttonHotFg: [0xff, 0xff, 0xff],
  currentBg: [0xa8, 0xcc, 0xb4],
  checkFg: [0xf4, 0xf4, 0xfc],
  checkBg: [0x52, 0x52, 0x74],
  checkDoneFg: [0xf0, 0xff, 0xf4],
  checkDoneBg: [0x22, 0x58, 0x34],
  errorFg: [0xff, 0x80, 0x80],
  warnFg: [0xe8, 0xc8, 0x4a],
  mutedFg: [0x7a, 0x7a, 0x8a],
  shaFg: [0x56, 0x9c, 0xd6],
  shaDarkFg: [0x15, 0x4a, 0x8c],
  stagedDelLineFg: [0xa0, 0xa0, 0xa8],
  stagedDelLineBg: [0x20, 0x20, 0x26],
  stagedDelCharFg: [0xf0, 0xf0, 0xf4],
  stagedDelCharBg: [0x44, 0x44, 0x4e],
  stagedAddLineFg: [0xb0, 0xb0, 0xb8],
  stagedAddLineBg: [0x26, 0x26, 0x2e],
  stagedAddCharFg: [0xff, 0xff, 0xff],
  stagedAddCharBg: [0x4e, 0x4e, 0x58],
  dashBg: [0x00, 0x00, 0x00],
  dashTileBg: [0x26, 0x26, 0x2a],
  dashRowBg: [0x1c, 0x1c, 0x1f],
  dashHeadBg: [0x70, 0x70, 0x7c],
  dashHeadMuted: [0xf2, 0xf2, 0xfa],
  dashDelFg: [0xff, 0xd2, 0xd2],
  dashTrendFg: [0x4a, 0x62, 0x70],
  dashKeyFg: [0xff, 0xff, 0xff],
};

const DARK_CODE = {
  keyword: [197, 134, 192],
  control: [197, 134, 192],
  storage: [86, 156, 214],
  literal: [86, 156, 214],
  string: [206, 145, 120],
  template: [206, 145, 120],
  escape: [209, 105, 105],
  interpolation: [156, 220, 254],
  number: [181, 206, 168],
  comment: [106, 153, 85],
  function: [220, 220, 170],
  method: [220, 220, 170],
  className: [78, 201, 176],
  type: [78, 201, 176],
  interface: [78, 201, 176],
  property: [156, 220, 254],
  variable: [156, 220, 254],
  parameter: [156, 220, 254],
  constant: [79, 193, 255],
  operator: [212, 212, 212],
  punct: [212, 212, 212],
  regex: [209, 105, 105],
  decorator: [220, 220, 170],
  tag: [86, 156, 214],
  attr: [156, 220, 254],
  plain: [212, 212, 212],
  punctDim: [128, 128, 128],
  logDate: [210, 210, 220],
  logError: [230, 90, 90],
  logWarn: [230, 180, 80],
  logInfo: [100, 170, 230],
  logDebug: [140, 160, 180],
};

const DARK_LOG_COLS = [
  [210, 210, 220],
  [120, 180, 220],
  [180, 160, 220],
  [140, 200, 160],
  [220, 180, 120],
  [220, 140, 160],
  [160, 200, 200],
  [200, 170, 140],
];

const LIGHT_UI = {
  delLineFg: [0xb3, 0x1d, 0x28],
  delLineBg: [0xff, 0xeb, 0xe9],
  delCharFg: [0x1f, 0x23, 0x28],
  delCharBg: [0xff, 0xc1, 0xc0],
  addLineFg: [0x1a, 0x7f, 0x37],
  addLineBg: [0xe6, 0xff, 0xec],
  addCharFg: [0x1f, 0x23, 0x28],
  addCharBg: [0xab, 0xf2, 0xbc],
  ctxFg: [0x57, 0x60, 0x6a],
  ctxBg: [0xff, 0xff, 0xff],
  splitGutterFg: [0xea, 0xee, 0xf2],
  splitGutterBg: [0xea, 0xee, 0xf2],
  headerFg: [0x24, 0x29, 0x2f],
  headerBg: [0xd8, 0xde, 0xe4],
  headerChromeFg: [0x42, 0x4a, 0x53],
  headerRepoFg: [0x24, 0x29, 0x2f],
  headerDirFg: [0x57, 0x60, 0x6a],
  headerSlashFg: [0x8c, 0x95, 0x9f],
  headerFileFg: [0x1f, 0x23, 0x28],
  chromeFg: [0x24, 0x29, 0x2f],
  chromeBg: [0xf0, 0xf2, 0xf5],
  noteBg: [0xe8, 0xf0, 0xfe],
  buttonFg: [0x57, 0x60, 0x6a],
  buttonBg: [0xe1, 0xe5, 0xea],
  buttonHotFg: [0x0f, 0x14, 0x19],
  currentBg: [0xac, 0xe1, 0xc2],
  checkFg: [0x1f, 0x23, 0x28],
  checkBg: [0xc8, 0xcf, 0xd8],
  checkDoneFg: [0x0f, 0x3d, 0x1f],
  checkDoneBg: [0xab, 0xf2, 0xbc],
  errorFg: [0xcf, 0x22, 0x2e],
  warnFg: [0x9a, 0x67, 0x00],
  mutedFg: [0x6e, 0x77, 0x81],
  shaFg: [0x05, 0x50, 0xae],
  shaDarkFg: [0x0b, 0x3d, 0x70],
  stagedDelLineFg: [0x57, 0x60, 0x6a],
  stagedDelLineBg: [0xf3, 0xf4, 0xf6],
  stagedDelCharFg: [0x1f, 0x23, 0x28],
  stagedDelCharBg: [0xd8, 0xdc, 0xe1],
  stagedAddLineFg: [0x42, 0x4a, 0x53],
  stagedAddLineBg: [0xea, 0xec, 0xef],
  stagedAddCharFg: [0x0f, 0x14, 0x19],
  stagedAddCharBg: [0xcc, 0xd1, 0xd7],
  dashBg: [0xff, 0xff, 0xff],
  dashTileBg: [0xe4, 0xe7, 0xeb],
  dashRowBg: [0xd9, 0xdc, 0xe1],
  dashHeadBg: [0xe8, 0xeb, 0xef],
  dashHeadMuted: [0x3e, 0x46, 0x52],
  dashDelFg: [0xd0, 0x3a, 0x44],
  dashTrendFg: [0x8a, 0x98, 0xa6],
  dashKeyFg: [0x00, 0x00, 0x00],
};

const LIGHT_CODE = {
  keyword: [175, 0, 219],
  control: [175, 0, 219],
  storage: [0, 0, 255],
  literal: [0, 0, 255],
  string: [163, 21, 21],
  template: [163, 21, 21],
  escape: [238, 0, 0],
  interpolation: [0, 16, 128],
  number: [9, 134, 88],
  comment: [0, 128, 0],
  function: [121, 94, 38],
  method: [121, 94, 38],
  className: [38, 127, 153],
  type: [38, 127, 153],
  interface: [38, 127, 153],
  property: [0, 16, 128],
  variable: [0, 16, 128],
  parameter: [0, 16, 128],
  constant: [0, 112, 193],
  operator: [60, 60, 60],
  punct: [60, 60, 60],
  regex: [129, 31, 63],
  decorator: [121, 94, 38],
  tag: [128, 0, 0],
  attr: [229, 0, 0],
  plain: [31, 31, 31],
  punctDim: [140, 140, 140],
  logDate: [60, 60, 70],
  logError: [205, 49, 49],
  logWarn: [160, 110, 0],
  logInfo: [0, 90, 180],
  logDebug: [100, 110, 125],
};

const LIGHT_LOG_COLS = [
  [60, 60, 70],
  [0, 95, 150],
  [110, 70, 170],
  [30, 120, 60],
  [150, 95, 20],
  [170, 50, 90],
  [20, 120, 120],
  [130, 90, 50],
];

const PALETTES = {
  dark: { ui: DARK_UI, code: DARK_CODE, logCols: DARK_LOG_COLS },
  light: { ui: LIGHT_UI, code: LIGHT_CODE, logCols: LIGHT_LOG_COLS },
};
const THEME_NAMES = Object.keys(PALETTES);

const applyColors = (into, from) => {
  for (const key of Object.keys(from)) {
    const src = from[key];
    let dst = into[key];
    if (!dst) {
      dst = [0, 0, 0];
      into[key] = dst;
    }
    dst[0] = src[0];
    dst[1] = src[1];
    dst[2] = src[2];
  }
  return into;
};

const cloneColors = (colors) => {
  const into = Array.isArray(colors) ? [] : {};
  return applyColors(into, colors);
};

const THEME = cloneColors(DARK_UI);
const CODE_FG = cloneColors(DARK_CODE);
const LOG_COL_FG = cloneColors(DARK_LOG_COLS);
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

const stripAnsi = (text) => text.replace(ANSI_RE, '');

const graphemes = (text) => {
  const parts = new Array(text.length);
  let n = 0;
  for (const { segment } of SEGMENTER.segment(text)) parts[n++] = segment;
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
  if (cp <= 0x1f || cp === 0x7f) return 0;
  if (cp === 0x200d) return 0;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 0;
  if (isWide(cp)) return 2;
  return 1;
};

const visibleWidth = (text) => {
  const plain = stripAnsi(text);
  let width = 0;
  for (const ch of graphemes(plain)) {
    width += graphemeWidth(ch, width);
  }
  return width;
};

const truncateVisible = (text, width, mark = '') => {
  if (width <= 0) return '';
  const plain = stripAnsi(text);
  if (visibleWidth(plain) <= width) return text;
  const markW = mark ? visibleWidth(mark) : 0;
  const fits = markW > 0 && markW <= width;
  const limit = fits ? width - markW : width;
  const parts = graphemes(plain);
  let used = 0;
  let out = '';
  for (const ch of parts) {
    const w = graphemeWidth(ch, used);
    if (used + w > limit) break;
    out += ch;
    used += w;
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

const firstGrapheme = (text) => {
  const next = SEGMENTER.segment(text)[Symbol.iterator]().next();
  if (next.done || !next.value) return '';
  return next.value.segment;
};

const clipAnsi = (text, width) => {
  const raw = `${text ?? ''}`;
  if (width <= 0) return '';
  if (visibleWidth(raw) <= width) return raw;
  let used = 0;
  let out = '';
  let index = 0;
  while (index < raw.length && used < width) {
    const csi = csiLength(raw, index);
    if (csi) {
      out += raw.slice(index, index + csi);
      index += csi;
      continue;
    }
    const ch = firstGrapheme(raw.slice(index));
    if (!ch) break;
    const w = graphemeWidth(ch, used);
    if (used + w > width) break;
    out += ch;
    used += w;
    index += ch.length;
  }
  if (stripAnsi(out) !== stripAnsi(raw)) out += RESET;
  return out;
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
    const csi = csiLength(raw, index);
    if (!csi) {
      out += raw[index];
      index += 1;
      continue;
    }
    const seq = raw.slice(index, index + csi);
    index += csi;
    if (!seq.endsWith('m')) {
      out += seq;
      continue;
    }
    const kept = keepFgParams(sgrParams(seq));
    const reset = kept.includes(0);
    const rest = kept.filter((code) => code !== 0);
    if (reset) out += `${ESC}[0m`;
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
  stripAnsi,
  graphemes,
  graphemeWidth,
  visibleWidth,
  truncateVisible,
  trimVisible,
  clipAnsi,
  foregroundOn,
};
