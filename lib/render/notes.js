'use strict';

const { clamp } = require('../common/utilities.js');
const ansi = require('../term/ansi.js');
const { wrapMultiline, wrapDoc, cursorInWrap } = require('../term/wrap.js');
const { isListPane, paneResult, editSpan } = require('./primitives.js');
const { THEME, paint, visibleWidth, truncateVisible, seq, EL, RESET } = ansi;

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
  const start = clamp(focus - cap + 1, 0, rows.length - cap);
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

const taskLists = (view) => {
  const sections = view.taskSections;
  if (sections && sections.length) return sections;
  const tasks = view.tasks ?? [];
  const texts = !tasks.length && view.noteText ? [view.noteText] : tasks;
  return [{ title: '', texts }];
};

const paintSectionHead = (title, width, color) =>
  paintBar(` ${title}`, width, THEME.taskHeadFg, THEME.taskHeadBg, color);

const paintSectionGap = (width, color) =>
  paintBar('', width, THEME.ctxFg, THEME.ctxBg, color);

const paintBodyTodo = (view, width, color) => {
  const focus = view.tasksFocus ?? 0;
  const inner = todoInnerWidth(width);
  const body = [];
  const taskOwners = [];
  const taskChecks = [];
  let editHits = [];
  let cursor = null;
  let index = 0;
  const sections = taskLists(view);
  for (let sectionAt = 0; sectionAt < sections.length; sectionAt++) {
    const section = sections[sectionAt];
    if (section.title) {
      body.push(paintSectionHead(section.title, width, color));
      taskOwners.push(null);
      taskChecks.push(false);
    }
    for (const text of section.texts) {
      const selected = index === focus;
      const fgRgb = selected ? THEME.chromeFg : THEME.mutedFg;
      const bgRgb = selected ? THEME.buttonBg : THEME.ctxBg;
      const todo = todoParts(text, inner);
      const rowStart = body.length;
      const wrapped = wrapTodoItem(text, todo);
      for (let line = 0; line < wrapped.length; line++) {
        const row = ` ${wrapped[line]}`;
        body.push(paintCheckBar(row, width, fgRgb, bgRgb, color, true));
        taskOwners.push(index);
        taskChecks.push(line === 0);
      }
      if (view.taskEdit && selected) {
        const edit = todoEdit(todo, view.taskEdit, rowStart, width);
        cursor = edit.cursor;
        editHits = edit.hits;
      }
      index += 1;
    }
    const last = sectionAt === sections.length - 1;
    if (section.title && !last) {
      body.push(paintSectionGap(width, color));
      taskOwners.push(null);
      taskChecks.push(false);
    }
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
