'use strict';

const ansi = require('../ansi.js');
const select = require('../select.js');
const { overlayRows } = select;
const primitives = require('./primitives.js');
const chrome = require('./chrome.js');
const files = require('./files.js');
const branches = require('./branches.js');
const commits = require('./commits.js');
const notes = require('./notes.js');
const npm = require('./npm.js');
const diff = require('./diff.js');
const unit = require('./unit.js');

const { RESET } = ansi;
const { LIST_PANES, paintBodyFill, paneResult } = primitives;
const { paintHeader, paintFooter, footerHits, paintStatusLine } = chrome;
const { layoutButtons, statusBranchHit, statusChoiceHits } = chrome;
const { hiddenActions, dimFooterActions, extraFooterActions } = chrome;
const { paintNotePanel, paintBodyTodo } = notes;
const { paintBodyFiles } = files;
const { paintBodyBranches } = branches;
const { paintBodyCommits } = commits;
const { paintBodyNpm } = npm;
const { paintBodyDiff } = diff;
const { paintBodyUnit } = unit;

const bodyKind = (view) => {
  const pane = view.pane ?? 'diff';
  if (pane === 'files' || pane === 'branches' || pane === 'commits') {
    return pane;
  }
  if (pane === 'npm') return 'npm';
  if (pane === 'unit') return 'unit';
  if (!view.item) return 'empty';
  if (view.item.origin === 'todo') return 'todo';
  return 'diff';
};

const paintBodyEmpty = () => paneResult();

const BODY_PAINT = {
  files: paintBodyFiles,
  branches: paintBodyBranches,
  commits: paintBodyCommits,
  npm: paintBodyNpm,
  empty: paintBodyEmpty,
  todo: paintBodyTodo,
  diff: paintBodyDiff,
  unit: paintBodyUnit,
};

const paintFrameBody = (view, width, color, bodyH, headerLines) => {
  const paint = BODY_PAINT[bodyKind(view)];
  return paint(view, width, color, bodyH, headerLines);
};

const frameNotes = (view, width, height, color) => {
  const notesCap = Math.max(0, height - 4);
  const notesWanted = paintNotePanel(view, width, color, notesCap);
  const noteRows = notesWanted.rows.slice(0, notesCap);
  let noteCursor = notesWanted.cursor;
  if (noteCursor && noteCursor.row >= noteRows.length) noteCursor = null;
  const chrome = 3 + noteRows.length;
  const bodyH = Math.max(1, height - chrome);
  return { notesWanted, noteRows, noteCursor, bodyH };
};

const bodyFillKind = (listPane, splitBody) => {
  if (listPane) return 'files';
  if (splitBody) return 'split';
  return 'plain';
};

const ownerSpan = (owners, focus) => {
  let first = -1;
  let last = -1;
  for (let i = 0; i < owners.length; i++) {
    if (owners[i] !== focus) continue;
    if (first < 0) first = i;
    last = i;
  }
  return { first, last };
};

const revealScroll = (owners, focus, height, prefer) => {
  const span = ownerSpan(owners, focus);
  if (span.first < 0) return prefer;
  const room = Math.max(1, height);
  let start = prefer;
  if (span.first < start) start = span.first;
  if (span.last >= start + room) {
    const fits = span.last - span.first + 1 <= room;
    start = fits ? span.last - room + 1 : span.first;
  }
  const maxStart = Math.max(0, owners.length - room);
  if (start > maxStart) start = maxStart;
  if (start < 0) start = 0;
  return start;
};

const mapBodyCursor = (cursor, shift, scroll, headerLines, shown) => {
  if (!cursor) return null;
  const row = cursor.row + shift;
  if (row < scroll || row >= scroll + shown) return null;
  return {
    x: cursor.x,
    y: headerLines + (row - scroll) + 1,
  };
};

const windowBody = (view, width, color, bodyH, headerLines, paintedBody) => {
  const sourceBody = paintedBody.body;
  const sourceOwners = paintedBody.todoOwners;
  const sourceChecks = paintedBody.todoChecks ?? [];
  const splitBody = paintedBody.splitBody === true;
  const pane = view.pane ?? 'diff';
  const listPane = LIST_PANES.includes(pane);
  const fillKind = bodyFillKind(listPane, splitBody);
  const filler = paintBodyFill(width, color, fillKind);
  const lead = !listPane && sourceBody.length > 0;
  const body = new Array(sourceBody.length + (lead ? 1 : 0));
  let bodyAt = 0;
  let shift = 0;
  if (lead) {
    body[bodyAt++] = filler;
    shift = 1;
  }
  for (let i = 0; i < sourceBody.length; i++) body[bodyAt++] = sourceBody[i];
  const ownerLead = lead && sourceOwners.length;
  const todoOwners = new Array(sourceOwners.length + (ownerLead ? 1 : 0));
  let ownerAt = 0;
  if (ownerLead) todoOwners[ownerAt++] = null;
  for (let i = 0; i < sourceOwners.length; i++) {
    todoOwners[ownerAt++] = sourceOwners[i];
  }
  const checkLead = lead && sourceChecks.length;
  const todoChecks = new Array(sourceChecks.length + (checkLead ? 1 : 0));
  let checkAt = 0;
  if (checkLead) todoChecks[checkAt++] = false;
  for (let i = 0; i < sourceChecks.length; i++) {
    todoChecks[checkAt++] = sourceChecks[i];
  }
  const scrollRaw = view.scroll ?? 0;
  const scrollMax = Math.max(0, body.length - bodyH);
  let scroll = listPane ? 0 : Math.min(scrollRaw, scrollMax);
  if (view.item && view.item.origin === 'todo') {
    scroll = revealScroll(todoOwners, view.todoFocus ?? 0, bodyH, scroll);
  }
  const end = Math.min(body.length, scroll + bodyH);
  const copied = Math.max(0, end - scroll);
  const slice = new Array(bodyH);
  for (let i = 0; i < copied; i++) slice[i] = body[scroll + i];
  const todoHits = [];
  for (let i = 0; i < copied; i++) {
    const owner = todoOwners[scroll + i];
    if (owner === undefined || owner === null) continue;
    const y = headerLines + i + 1;
    if (todoChecks[scroll + i]) {
      todoHits.push({ y, cursor: owner, x0: 1, x1: 4, check: true });
    }
    todoHits.push({ y, cursor: owner });
  }
  const cursor = mapBodyCursor(
    paintedBody.cursor,
    shift,
    scroll,
    headerLines,
    copied,
  );
  for (let i = copied; i < bodyH; i++) slice[i] = filler;
  const listScroll = paintedBody.listScroll ?? 0;
  const fileHits = paintedBody.fileHits;
  return { slice, scroll, scrollMax, listScroll, todoHits, fileHits, cursor };
};

const notePointerHits = (notesWanted, noteRows, noteCursor, bodyH) => {
  let cursor = null;
  if (noteCursor) {
    cursor = { x: noteCursor.x, y: 2 + bodyH + noteCursor.row };
  }
  const templateHits = [];
  for (const hit of notesWanted.templateHits ?? []) {
    if (hit.row >= noteRows.length) continue;
    templateHits.push({ y: 2 + bodyH + hit.row, cursor: hit.cursor });
  }
  return { cursor, templateHits };
};

const stackFrame = (view, width, color, rows, layout, windowed, notes) => {
  for (const row of windowed.slice) rows.push(row);
  for (const row of notes.noteRows) rows.push(row);
  const status = view.status ?? '';
  rows.push(paintStatusLine(view, status, width, color));
  rows.push(paintFooter(view, layout, width, color));
  return overlayRows(rows, view.selection);
};

const renderFrame = (view, options = {}) => {
  const width = Math.max(20, options.width ?? 80);
  const height = Math.max(6, options.height ?? 24);
  const color = options.color ?? true;
  const rows = [paintHeader(view, width, color)];
  const extra = extraFooterActions(view);
  const hidden = hiddenActions(view);
  const dimmed = dimFooterActions(view);
  const layout = layoutButtons(width, false, hidden, extra, dimmed);
  const notes = frameNotes(view, width, height, color);
  const headerLines = rows.length;
  const bodyH = notes.bodyH;
  const paintedBody = paintFrameBody(view, width, color, bodyH, headerLines);
  const windowed = windowBody(
    view,
    width,
    color,
    bodyH,
    headerLines,
    paintedBody,
  );
  const painted = stackFrame(view, width, color, rows, layout, windowed, notes);
  const text = painted.map((row) => (color ? row + RESET : row)).join('\n');
  const hits = notePointerHits(
    notes.notesWanted,
    notes.noteRows,
    notes.noteCursor,
    bodyH,
  );
  const statusY = painted.length - 1;
  const branchHit = statusBranchHit(view, width, statusY);
  const statusHits = branchHit ? [branchHit] : statusChoiceHits(view, statusY);
  const { fileHits, todoHits, scroll, scrollMax, listScroll } = windowed;
  const { templateHits } = hits;
  const footerY = painted.length;
  return {
    text,
    rows: painted,
    buttons: footerHits(view, layout),
    fileHits,
    todoHits,
    templateHits,
    statusHits,
    footerY,
    height: footerY,
    scroll,
    scrollMax,
    listScroll,
    cursor: hits.cursor ?? windowed.cursor,
    bodyH,
  };
};

module.exports = { BODY_PAINT, renderFrame };
