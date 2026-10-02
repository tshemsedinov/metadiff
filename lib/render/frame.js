'use strict';

const ansi = require('../ansi.js');
const select = require('../select.js');
const primitives = require('./primitives.js');
const chrome = require('./chrome.js');
const files = require('./files.js');
const branches = require('./branches.js');
const commits = require('./commits.js');
const notes = require('./notes.js');
const npm = require('./npm.js');
const diff = require('./diff.js');
const unit = require('./unit.js');
const dashboard = require('./dashboard.js');
const repos = require('./repos.js');

const { RESET } = ansi;
const { overlayRows, markEditorSelection } = select;
const { isListPane, isTaskView, paintBodyFill, paneResult } = primitives;
const { paintHeader, paintFooter, footerHits, paintStatusLine } = chrome;
const { footerLayout, statusBranchHit, statusChoiceHits } = chrome;
const { paintNotePanel, paintBodyTodo } = notes;
const { paintBodyDiff } = diff;

const PANE_BODY = {
  dashboard: dashboard.paintBodyDashboard,
  repos: repos.paintBodyRepos,
  files: files.paintBodyFiles,
  branches: branches.paintBodyBranches,
  commits: commits.paintBodyCommits,
  npm: npm.paintBodyNpm,
  unit: unit.paintBodyUnit,
  tasks: paintBodyTodo,
};

const paintBodyEmpty = () => paneResult();

const bodyPainter = (view) => {
  if (Object.hasOwn(PANE_BODY, view.pane)) return PANE_BODY[view.pane];
  if (!view.item) return paintBodyEmpty;
  return paintBodyDiff;
};

const frameNotes = (view, width, height, color) => {
  const notesCap = Math.max(0, height - 4);
  const panel = paintNotePanel(view, width, color, notesCap);
  const rows = panel.rows.slice(0, notesCap);
  const inside = panel.cursor && panel.cursor.row < rows.length;
  const cursor = inside ? panel.cursor : null;
  const bodyH = Math.max(1, height - 3 - rows.length);
  return { panel, rows, cursor, bodyH };
};

const revealScroll = (owners, focus, height, prefer) => {
  const first = owners.indexOf(focus);
  if (first < 0) return prefer;
  const last = owners.lastIndexOf(focus);
  const room = Math.max(1, height);
  let start = Math.min(prefer, first);
  if (last >= start + room) {
    start = last - first + 1 <= room ? last - room + 1 : first;
  }
  return Math.max(0, Math.min(start, owners.length - room));
};

const windowY = (win, row) => {
  const at = row + win.shift - win.scroll;
  if (at < 0 || at >= win.shown) return -1;
  return win.headerLines + at + 1;
};

const mapEditHits = (hits, win) => {
  const out = [];
  for (const hit of hits) {
    const y = windowY(win, hit.row);
    if (y >= 0) out.push({ ...hit, y });
  }
  return out;
};

const mapBodyCursor = (cursor, win) => {
  if (!cursor) return null;
  const y = windowY(win, cursor.row);
  if (y < 0) return null;
  const point = { x: cursor.x, y };
  if (typeof cursor.scroll === 'number') point.scroll = cursor.scroll;
  return point;
};

const bodyFillKind = (listPane, splitBody) => {
  if (listPane) return 'files';
  return splitBody ? 'split' : 'plain';
};

const windowBody = (view, painted, frame) => {
  const { width, color, bodyH, headerLines } = frame;
  const listPane = isListPane(view.pane);
  const fillKind = bodyFillKind(listPane, painted.splitBody);
  const filler = paintBodyFill(width, color, fillKind);
  const shift = !listPane && painted.body.length > 0 ? 1 : 0;
  const lead = (items, first) =>
    shift && items.length ? [first, ...items] : items;
  const body = lead(painted.body, filler);
  const taskOwners = lead(painted.taskOwners, null);
  const taskChecks = lead(painted.taskChecks, false);
  const scrollMax = Math.max(0, body.length - bodyH);
  let scroll = listPane ? 0 : Math.min(view.scroll ?? 0, scrollMax);
  if (isTaskView(view)) {
    scroll = revealScroll(taskOwners, view.tasksFocus ?? 0, bodyH, scroll);
  }
  const slice = body.slice(scroll, scroll + bodyH);
  const win = { shift, scroll, shown: slice.length, headerLines };
  const taskHits = [];
  for (let i = 0; i < slice.length; i++) {
    const owner = taskOwners[scroll + i];
    if (owner === undefined || owner === null) continue;
    const y = headerLines + i + 1;
    if (taskChecks[scroll + i]) {
      taskHits.push({ y, cursor: owner, x0: 1, x1: 4, check: true });
    }
    taskHits.push({ y, cursor: owner });
  }
  while (slice.length < bodyH) slice.push(filler);
  return {
    slice,
    scroll,
    scrollMax,
    listScroll: painted.listScroll,
    taskHits,
    fileHits: painted.fileHits,
    editHits: mapEditHits(painted.editHits, win),
    cursor: mapBodyCursor(painted.cursor, win),
  };
};

const notePointerHits = (notes, bodyH) => {
  const { panel, rows, cursor } = notes;
  const top = 2 + bodyH;
  const templateHits = [];
  for (const hit of panel.templateHits) {
    if (hit.row < rows.length) {
      templateHits.push({ y: top + hit.row, cursor: hit.cursor });
    }
  }
  const editHits = [];
  for (const hit of panel.editHits) {
    if (hit.row < rows.length) editHits.push({ ...hit, y: top + hit.row });
  }
  const point = cursor ? { x: cursor.x, y: top + cursor.row } : null;
  return { cursor: point, templateHits, editHits };
};

const renderFrame = (view, options = {}) => {
  const width = Math.max(20, options.width ?? 80);
  const height = Math.max(6, options.height ?? 24);
  const color = options.color ?? true;
  const headerLines = 1;
  const layout = footerLayout(view, width);
  const notes = frameNotes(view, width, height, color);
  const { bodyH } = notes;
  const paint = bodyPainter(view);
  const painted = paint(view, width, color, bodyH, headerLines);
  const frame = { width, color, bodyH, headerLines };
  const windowed = windowBody(view, painted, frame);
  const rows = overlayRows(
    [
      paintHeader(view, width, color),
      ...windowed.slice,
      ...notes.rows,
      paintStatusLine(view, view.status ?? '', width, color),
      paintFooter(view, layout, width, color),
    ],
    view.selection,
  );
  const hits = notePointerHits(notes, bodyH);
  const statusY = rows.length - 1;
  const branchHit = statusBranchHit(view, width, statusY);
  const statusHits = branchHit ? [branchHit] : statusChoiceHits(view, statusY);
  const editHits = [...windowed.editHits, ...hits.editHits];
  const shown = markEditorSelection(rows, view, editHits, color);
  const text = shown.map((row) => (color ? row + RESET : row)).join('\n');
  return {
    text,
    rows: shown,
    buttons: footerHits(view, layout),
    fileHits: windowed.fileHits,
    taskHits: windowed.taskHits,
    templateHits: hits.templateHits,
    editHits,
    statusHits,
    footerY: rows.length,
    height: rows.length,
    scroll: windowed.scroll,
    scrollMax: windowed.scrollMax,
    listScroll: windowed.listScroll,
    cursor: hits.cursor ?? windowed.cursor,
    bodyH,
  };
};

module.exports = { renderFrame };
