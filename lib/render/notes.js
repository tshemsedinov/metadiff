'use strict';

const ansi = require('../ansi.js');
const wrap = require('../wrap.js');
const files = require('../files.js');
const primitives = require('./primitives.js');

const { REPO_TASKS_LABEL } = files;
const { wrapMultiline, wrapDoc, cursorInWrap } = wrap;
const { THEME, paint, visibleWidth, truncateVisible, seq, EL, RESET } = ansi;
const { isListPane, paneResult, editSpan } = primitives;

const INPUT_MAX = 4;
const NOTE_MAX = 4;
const NOTE_PAD = 1;
const CHECK_DONE = 'xX';
const CHECK_TOKEN = /\[([ xX])\]/;
const CHECK_LEAD = /^\[[ xX]\] /;
const TODO_LEAD_W = '[ ] '.length;
const NO_NOTE = { rows: [], cursor: null, templateHits: [], editHits: [] };

const paintBar = (text, width, fgRgb, bgRgb, color) => {
  const clipped = truncateVisible(text, width);
  const pad = Math.max(0, width - visibleWidth(clipped));
  const filled = clipped + ' '.repeat(pad);
  if (!color) return filled;
  return `${seq(fgRgb, bgRgb)}${EL}${filled}${RESET}`;
};

const checkChip = (mark, fgRgb, bgRgb, plain) => {
  if (plain) return { fgRgb, bgRgb };
  if (CHECK_DONE.includes(mark)) {
    return { fgRgb: THEME.checkDoneFg, bgRgb: THEME.checkDoneBg };
  }
  return { fgRgb: THEME.checkFg, bgRgb: THEME.checkBg };
};

const paintCheckBar = (text, width, fgRgb, bgRgb, color, plain = false) => {
  const clipped = truncateVisible(text, width);
  const match = color ? CHECK_TOKEN.exec(clipped) : null;
  if (!match) return paintBar(text, width, fgRgb, bgRgb, color);
  const token = match[0];
  const pad = Math.max(0, width - visibleWidth(clipped));
  const before = clipped.slice(0, match.index);
  const after = clipped.slice(match.index + token.length) + ' '.repeat(pad);
  const chip = checkChip(match[1], fgRgb, bgRgb, plain);
  let out = `${seq(fgRgb, bgRgb)}${EL}`;
  out += paint(before, fgRgb, bgRgb, color);
  out += paint(token, chip.fgRgb, chip.bgRgb, color);
  return out + paint(after, fgRgb, bgRgb, color);
};

const windowRows = (rows, focus, cap) => {
  if (rows.length <= cap) return { rows, offset: 0 };
  const start = Math.min(Math.max(0, focus - cap + 1), rows.length - cap);
  return { rows: rows.slice(start, start + cap), offset: start };
};

const todoInnerWidth = (width) => Math.max(1, width - 2);

const todoBodyWidth = (width) =>
  Math.max(1, todoInnerWidth(width) - TODO_LEAD_W);

const noteInnerWidth = (width) => Math.max(1, width - NOTE_PAD * 2);

const todoParts = (text, inner) => {
  const match = CHECK_LEAD.exec(text);
  const lead = match ? match[0].length : 0;
  return { lead, body: text.slice(lead), bodyW: Math.max(1, inner - lead) };
};

const wrapTodoItem = (text, todo) => {
  const mark = text.slice(0, todo.lead);
  const hang = ' '.repeat(todo.lead);
  const lines = wrapMultiline(todo.body, todo.bodyW);
  return lines.map((line, index) => `${index ? hang : mark}${line}`);
};

const todoEdit = (todo, edit, rowStart, width) => {
  const pos = cursorInWrap(todo.body, edit.cursor ?? 0, todo.bodyW);
  const cursor = { x: pos.col + todo.lead + 2, row: rowStart + pos.row };
  const x0 = todo.lead + 1;
  const doc = wrapDoc(todo.body, todo.bodyW);
  const hits = doc.map((piece, line) => ({
    row: rowStart + line,
    ...editSpan(x0, x0 + 1, width + 1, piece.start, piece.text),
  }));
  return { cursor, hits };
};

const paintBodyTodo = (view, width, color) => {
  const tasks = view.tasks ?? [];
  const texts = !tasks.length && view.noteText ? [view.noteText] : tasks;
  const focus = view.tasksFocus ?? 0;
  const inner = todoInnerWidth(width);
  const caption = ` ${REPO_TASKS_LABEL}`;
  const body = [paintBar(caption, width, THEME.mutedFg, THEME.ctxBg, color)];
  const taskOwners = [null];
  const taskChecks = [false];
  let editHits = [];
  let cursor = null;
  for (let i = 0; i < texts.length; i++) {
    const selected = i === focus;
    const fgRgb = selected ? THEME.chromeFg : THEME.mutedFg;
    const bgRgb = selected ? THEME.buttonBg : THEME.ctxBg;
    const todo = todoParts(texts[i], inner);
    const rowStart = body.length;
    const wrapped = wrapTodoItem(texts[i], todo);
    for (let line = 0; line < wrapped.length; line++) {
      const text = ` ${wrapped[line]}`;
      body.push(paintCheckBar(text, width, fgRgb, bgRgb, color, true));
      taskOwners.push(i);
      taskChecks.push(line === 0);
    }
    if (!view.taskEdit || !selected) continue;
    const edit = todoEdit(todo, view.taskEdit, rowStart, width);
    cursor = edit.cursor;
    editHits = edit.hits;
  }
  return paneResult({ body, editHits, taskOwners, taskChecks, cursor });
};

const noteLine = (text, width) =>
  `${' '.repeat(NOTE_PAD)}${truncateVisible(text, noteInnerWidth(width))}`;

const paintComposeNote = (view, width, color, cap) => {
  const inner = noteInnerWidth(width);
  const { compose } = view;
  const doc = wrapDoc(compose.text ?? '', inner);
  const { row, col } = cursorInWrap(compose.text, compose.cursor ?? 0, inner);
  const shown = windowRows(doc, row, INPUT_MAX);
  const templates = view.templates ?? [];
  const room = Math.max(0, cap - shown.rows.length);
  const count = Math.min(templates.length, room);
  const focus = view.templateIndex ?? -1;
  const rows = [];
  const templateHits = [];
  for (let i = 0; i < count; i++) {
    const selected = i === focus;
    const fgRgb = selected ? THEME.chromeFg : THEME.mutedFg;
    const bgRgb = selected ? THEME.buttonBg : THEME.noteBg;
    const line = noteLine(templates[i].text ?? '', width);
    rows.push(paintBar(line, width, fgRgb, bgRgb, color));
    templateHits.push({ row: i, cursor: i });
  }
  const editHits = [];
  for (const piece of shown.rows) {
    const span = editSpan(1, NOTE_PAD + 1, width + 1, piece.start, piece.text);
    editHits.push({ row: rows.length, ...span });
    const line = noteLine(piece.text, width);
    rows.push(paintBar(line, width, THEME.chromeFg, THEME.noteBg, color));
  }
  const cursor = { x: NOTE_PAD + col + 1, row: count + row - shown.offset };
  return { rows, cursor, templateHits, editHits };
};

const paintIdleNote = (view, width, color) => {
  if (!view.noteText) return NO_NOTE;
  const note = `feedback: ${view.noteText}`;
  const wrapped = wrapMultiline(note, noteInnerWidth(width));
  const rows = wrapped.slice(0, NOTE_MAX).map((text) => {
    const line = noteLine(text, width);
    return paintCheckBar(line, width, THEME.chromeFg, THEME.noteBg, color);
  });
  return { rows, cursor: null, templateHits: [], editHits: [] };
};

const paintNotePanel = (view, width, color, cap) => {
  if (view.compose?.kind === 'feedback') {
    return paintComposeNote(view, width, color, cap);
  }
  if (isListPane(view.pane)) return NO_NOTE;
  return paintIdleNote(view, width, color);
};

module.exports = {
  todoBodyWidth,
  noteInnerWidth,
  paintNotePanel,
  paintBodyTodo,
};
