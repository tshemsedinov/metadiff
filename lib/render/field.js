'use strict';

const ansi = require('../ansi.js');

const { THEME, paint, graphemes, graphemeWidth, visibleWidth } = ansi;
const { fileMatches } = require('../find.js');

const pieceKind = (index, cursor, lo, hi) => {
  if (index === cursor) return 'caret';
  if (lo >= 0 && index >= lo && index < hi) return 'select';
  return 'plain';
};

const pushPiece = (pieces, kind, ch) => {
  const last = pieces[pieces.length - 1];
  if (last && last.kind === kind) last.text += ch;
  else pieces.push({ kind, text: ch });
};

const fieldPieces = (text, cursor, anchor, scroll, room) => {
  const raw = `${text ?? ''}`;
  const selected = typeof anchor === 'number' && anchor !== cursor;
  const lo = selected ? Math.min(anchor, cursor) : -1;
  const hi = selected ? Math.max(anchor, cursor) : -1;
  const pieces = [];
  let index = 0;
  let col = 0;
  for (const ch of graphemes(raw)) {
    const width = graphemeWidth(ch, col);
    const startCol = col;
    const start = index;
    index += ch.length;
    col += width;
    if (col <= scroll) continue;
    if (startCol >= scroll + room) break;
    const kind = pieceKind(start, cursor, lo, hi);
    pushPiece(pieces, kind, ch);
  }
  const caretAt = visibleWidth(raw.slice(0, Math.min(cursor, raw.length)));
  const atEnd = cursor >= raw.length;
  const caretFits = caretAt >= scroll && caretAt < scroll + room;
  if (atEnd && caretFits) pushPiece(pieces, 'caret', ' ');
  return pieces;
};

const paintField = (text, editor, room, color, tones) => {
  const cursor = editor ? editor.cursor : `${text ?? ''}`.length;
  const anchor = editor ? editor.anchor : null;
  const scroll = editor ? editor.scrollCol : 0;
  const pieces = fieldPieces(text, cursor, anchor, scroll, room);
  let used = 0;
  let out = '';
  for (const piece of pieces) {
    used += visibleWidth(piece.text);
    const tone = tones[piece.kind] ?? tones.plain;
    const painted = paint(piece.text, tone.fg, tone.bg, color);
    out += color ? painted : piece.text;
  }
  const pad = ' '.repeat(Math.max(0, room - used));
  const plain = tones.plain;
  if (!color) return out + pad;
  return out + paint(pad, plain.fg, plain.bg, color);
};

const paintPlanFace = (view, face, fgRgb, bgRgb, color) => {
  const editor = view.planEditor;
  if (!editor || !view.planQuery) {
    return paint(face, fgRgb, bgRgb, color, true);
  }
  const room = visibleWidth(face);
  if (room) editor.reveal(room);
  const tones = {
    plain: { fg: THEME.searchFg, bg: THEME.searchBg },
    select: { fg: THEME.chromeFg, bg: THEME.checkBg },
    caret: { fg: THEME.searchOnFg, bg: THEME.searchOnBg },
  };
  return paintField(view.planQuery, editor, room, color, tones);
};

const fieldTones = (fgRgb, bgRgb) => ({
  plain: { fg: fgRgb, bg: bgRgb },
  select: { fg: THEME.searchFg, bg: THEME.searchBg },
  caret: { fg: THEME.searchOnFg, bg: THEME.searchOnBg },
});

const paintPromptLine = (lead, leadFg, text, editor, width, color, fgRgb) => {
  const room = Math.max(0, width - lead.length);
  if (editor && room) editor.reveal(room);
  const bgRgb = THEME.chromeBg;
  const body = paintField(text, editor, room, color, fieldTones(fgRgb, bgRgb));
  if (!color) return `${lead}${body}`;
  return paint(lead, leadFg, bgRgb, color, true) + body;
};

const paintImportStatus = (view, width, color) => {
  const state = view.import ?? {};
  const query = state.url ?? '';
  return paintPromptLine(
    ' url ',
    THEME.warnFg,
    query,
    state.editor,
    width,
    color,
    THEME.chromeFg,
  );
};

const paintFindStatus = (view, width, color) => {
  const find = view.find ?? {};
  const query = find.query ?? '';
  const hits = fileMatches(view.files ?? [], query);
  const miss = query.length > 0 && hits.length === 0;
  const tone = miss ? THEME.errorFg : THEME.chromeFg;
  return paintPromptLine(
    ' /',
    THEME.warnFg,
    query,
    find.editor,
    width,
    color,
    tone,
  );
};

module.exports = {
  paintField,
  paintPlanFace,
  paintImportStatus,
  paintFindStatus,
};
