'use strict';

const { THEME, paint, visibleWidth } = require('../term/ansi.js');
const { paintSegments } = require('./tiles.js');
const { npmContent } = require('./dashboard/blocks.js');
const primitives = require('./primitives.js');
const { MARK_W, markPrefix, paintCursorList, fieldWindow, editSpan } =
  primitives;

const TILE = { key: 'n', title: 'npm' };
const TAIL = 1;
const LIST_PAD = 1;

const paintMarginRow = (line, width, color, selected) => {
  const bg = selected ? THEME.buttonBg : THEME.ctxBg;
  const fg = selected ? THEME.chromeFg : THEME.mutedFg;
  const inner = Math.max(1, width - MARK_W - TAIL);
  const body = paintSegments(line, inner, bg, color);
  const prefix = markPrefix(selected);
  const tail = ' '.repeat(TAIL);
  if (!color) return `${prefix}${body}${tail}`;
  return paint(prefix, fg, bg, color) + body + paint(tail, fg, bg, color);
};

const paintPackageEdit = (compose, width, color) => {
  const prefix = markPrefix(true);
  const rest = Math.max(1, width - MARK_W - TAIL);
  const text = `${compose.text ?? ''}`.replaceAll('\n', ' ');
  const win = fieldWindow(text, compose.cursor, compose.scrollCol, rest);
  const gap = ' '.repeat(Math.max(0, rest - visibleWidth(win.text)));
  const tail = ' '.repeat(TAIL);
  const fg = THEME.chromeFg;
  const bg = THEME.buttonBg;
  let row = `${prefix}${win.text}${gap}${tail}`;
  if (color) {
    row = paint(prefix, fg, bg, color);
    row += paint(win.text, THEME.buttonHotFg, bg, color);
    row += paint(`${gap}${tail}`, fg, bg, color);
  }
  const textX = MARK_W + 1;
  const edit = editSpan(1, textX, textX + rest, 0, text);
  const cursor = { x: textX + win.col, scroll: win.scroll };
  return { row, cursor, edits: [{ ...edit, scroll: win.scroll }] };
};

const paintBodyPackages = (view, width, color, bodyH, headerLines) => {
  const ctx = { frame: view.progressFrame ?? 0 };
  const inner = Math.max(1, width - MARK_W - TAIL);
  const content = npmContent(view.packages, inner, null, ctx, TILE);
  const headed = Boolean(content.titleLine) && content.lines.length > 0;
  const rows = headed ? content.lines.slice(1) : content.lines;
  const reserved = headed ? 1 : 0;
  const last = Math.max(0, rows.length - 1);
  const cursor = Math.min(view.packagesCursor ?? 0, last);
  const pane = {
    width,
    color,
    bodyH: Math.max(1, bodyH - reserved),
    headerLines: headerLines + reserved,
    offset: view.listScroll,
  };
  const paintRow = (line, selected) =>
    paintMarginRow(line, width, color, selected);
  const editing = view.compose && view.compose.kind === 'package';
  const extra = editing
    ? {
        ...paintPackageEdit(view.compose, width, color),
        at: 'index',
        index: cursor,
      }
    : null;
  const painted = paintCursorList(rows, cursor, pane, paintRow, extra);
  if (!headed) return painted;
  const head = paintMarginRow(content.lines[0], width, color, false);
  const body = painted.body.slice();
  const pad = pane.bodyH >= LIST_PAD * 2 + 1 ? LIST_PAD : 0;
  body.splice(pad, 0, head);
  const nudge = (point) => {
    if (!point || point.row < pad) return point;
    return { ...point, row: point.row + 1 };
  };
  return {
    ...painted,
    body,
    editHits: painted.editHits.map(nudge),
    cursor: nudge(painted.cursor),
  };
};

module.exports = { paintBodyPackages };
