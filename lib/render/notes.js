'use strict';

const ansi = require('../ansi.js');
const wrap = require('../wrap.js');
const files = require('../files.js');
const primitives = require('./primitives.js');

const { REPO_TODOS_LABEL } = files;
const { wrapMultiline, cursorInWrap } = wrap;
const { THEME, truncateVisible } = ansi;
const { paintBar, paintCheckBar, windowRows } = primitives;
const { LIST_PANES, CHECK_LEAD, paneResult } = primitives;

const NOTE_COMPOSE = ['feedback'];
const INPUT_MAX = 4;
const NOTE_MAX = 4;
const NOTE_PAD = 1;

const todoInnerWidth = (width) => Math.max(1, width - 2);

const checkLeadLen = (text) => {
  const match = CHECK_LEAD.exec(text);
  return match ? match[0].length : 0;
};

const TODO_LEAD_W = checkLeadLen('[ ] ');

const todoBodyWidth = (width) =>
  Math.max(1, todoInnerWidth(width) - TODO_LEAD_W);

const wrapTodoItem = (text, inner) => {
  const lead = checkLeadLen(text);
  if (!lead) return wrapMultiline(text, inner);
  const mark = text.slice(0, lead);
  const body = text.slice(lead);
  const bodyWidth = Math.max(1, inner - lead);
  const hang = ' '.repeat(lead);
  const wrapped = wrapMultiline(body, bodyWidth);
  const { length } = wrapped;
  const lines = new Array(length);
  for (let i = 0; i < length; i++) {
    const prefix = i === 0 ? mark : hang;
    lines[i] = `${prefix}${wrapped[i]}`;
  }
  return lines;
};

const todoCursor = (text, edit, inner, rowStart) => {
  const lead = checkLeadLen(text);
  const body = text.slice(lead);
  const bodyWidth = Math.max(1, inner - lead);
  const pos = cursorInWrap(body, edit.cursor ?? 0, bodyWidth);
  return { x: pos.col + lead + 2, row: rowStart + pos.row };
};

const paintTodoList = (texts, focus, width, color, edit) => {
  const inner = todoInnerWidth(width);
  const rows = [];
  const owners = [];
  const checks = [];
  let cursor = null;
  for (let i = 0; i < texts.length; i++) {
    const selected = i === focus;
    const fgRgb = selected ? THEME.chromeFg : THEME.mutedFg;
    const bgRgb = selected ? THEME.buttonBg : THEME.ctxBg;
    const text = texts[i];
    const wrapped = wrapTodoItem(text, inner);
    const rowStart = rows.length;
    for (let line = 0; line < wrapped.length; line++) {
      const painted = paintCheckBar(
        ` ${wrapped[line]}`,
        width,
        fgRgb,
        bgRgb,
        color,
        true,
      );
      rows.push(painted);
      owners.push(i);
      checks.push(line === 0);
    }
    if (!edit || !selected) continue;
    cursor = todoCursor(text, edit, inner, rowStart);
  }
  return { rows, owners, checks, cursor };
};

const noteInnerWidth = (width) => Math.max(1, width - NOTE_PAD * 2);

const paintNoteLine = (text, width, fgRgb, bgRgb, color, withCheck) => {
  const inner = noteInnerWidth(width);
  const clipped = truncateVisible(text, inner);
  const line = `${' '.repeat(NOTE_PAD)}${clipped}`;
  if (withCheck) return paintCheckBar(line, width, fgRgb, bgRgb, color);
  return paintBar(line, width, fgRgb, bgRgb, color);
};

const paintTemplateRow = (text, selected, width, color) => {
  const fgRgb = selected ? THEME.chromeFg : THEME.mutedFg;
  const bgRgb = selected ? THEME.buttonBg : THEME.noteBg;
  return paintNoteLine(text, width, fgRgb, bgRgb, color);
};

const paintComposeNote = (view, width, color, cap) => {
  const inner = noteInnerWidth(width);
  const bgRgb = THEME.noteBg;
  const compose = view.compose;
  const wrapped = wrapMultiline(compose.text, inner);
  const { row, col } = cursorInWrap(compose.text, compose.cursor ?? 0, inner);
  const shown = windowRows(wrapped, row, INPUT_MAX);
  const rows = [];
  const templateHits = [];
  if (compose.kind === 'feedback') {
    const all = view.templates ?? [];
    const room =
      cap === undefined ? all.length : Math.max(0, cap - shown.rows.length);
    const n = Math.min(all.length, room);
    const focus = view.templateIndex ?? -1;
    for (let i = 0; i < n; i++) {
      const text = all[i].text ?? '';
      const selected = i === focus;
      rows.push(paintTemplateRow(text, selected, width, color));
      templateHits.push({ row: i, cursor: i });
    }
  }
  const templateCount = rows.length;
  for (const line of shown.rows) {
    rows.push(paintNoteLine(line, width, THEME.chromeFg, bgRgb, color));
  }
  return {
    rows,
    cursor: {
      x: NOTE_PAD + col + 1,
      row: templateCount + row - shown.offset,
    },
    templateHits,
  };
};

const paintIdleNote = (view, width, color) => {
  const empty = { rows: [], cursor: null, templateHits: [] };
  const text = view.noteText;
  if (!text) return empty;
  const inner = noteInnerWidth(width);
  const wrapped = wrapMultiline(`feedback: ${text}`, inner);
  const rows = [];
  for (const line of wrapped.slice(0, NOTE_MAX)) {
    const painted = paintNoteLine(
      line,
      width,
      THEME.chromeFg,
      THEME.noteBg,
      color,
      true,
    );
    rows.push(painted);
  }
  return { rows, cursor: null, templateHits: [] };
};

const paintNotePanel = (view, width, color, cap) => {
  const empty = { rows: [], cursor: null, templateHits: [] };
  const compose = view.compose;
  if (compose && NOTE_COMPOSE.includes(compose.kind)) {
    return paintComposeNote(view, width, color, cap);
  }
  const pane = view.pane ?? 'diff';
  if (LIST_PANES.includes(pane)) return empty;
  return paintIdleNote(view, width, color);
};

const paintTodoCaption = (width, color) =>
  paintBar(` ${REPO_TODOS_LABEL}`, width, THEME.mutedFg, THEME.ctxBg, color);

const paintBodyTodo = (view, width, color) => {
  const texts = view.todos ?? [];
  let lines = texts;
  if (!lines.length && view.noteText) lines = [view.noteText];
  const painted = paintTodoList(
    lines,
    view.todoFocus ?? 0,
    width,
    color,
    view.todoEdit,
  );
  const caption = paintTodoCaption(width, color);
  const body = [caption, ...painted.rows];
  const todoOwners = [null, ...painted.owners];
  const todoChecks = [false, ...painted.checks];
  let cursor = null;
  if (painted.cursor) {
    cursor = { x: painted.cursor.x, row: painted.cursor.row + 1 };
  }
  const fileHits = [];
  const splitBody = false;
  return paneResult({
    body,
    fileHits,
    todoOwners,
    todoChecks,
    cursor,
    splitBody,
  });
};

module.exports = {
  todoInnerWidth,
  todoBodyWidth,
  noteInnerWidth,
  paintNotePanel,
  paintBodyTodo,
};
