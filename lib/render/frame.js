'use strict';

const { clamp } = require('../common/utilities.js');
const { ESC, RESET, stampVisible } = require('../term/ansi.js');
const { overlayRows, markEditorSelection } = require('../term/select.js');
const primitives = require('./primitives.js');
const { paintHeader } = require('./header.js');
const { paintFooter, footerHits, footerLayout } = require('./footer.js');
const status = require('./status.js');
const files = require('./files.js');
const branches = require('./branches.js');
const commits = require('./commits.js');
const { paintNotePanel, paintBodyTodo } = require('./notes.js');
const npm = require('./npm.js');
const { paintBodyDiff, viewDigits, paintNumberFill } = require('./diff.js');
const unit = require('./unit.js');
const dashboard = require('./dashboard/dashboard.js');
const packages = require('./packages.js');
const agents = require('./agents.js');
const repos = require('./repos.js');

const { isListPane, isTaskView, paintBodyFill, paneResult } = primitives;
const { paintStatusLine, statusBranchHit, statusChoiceHits } = status;
const { statusPlanHit, planMenu } = status;

const PANE_BODY = {
  dashboard: dashboard.paintBodyDashboard,
  repos: repos.paintBodyRepos,
  files: files.paintBodyFiles,
  branches: branches.paintBodyBranches,
  commits: commits.paintBodyCommits,
  npm: npm.paintBodyNpm,
  packages: packages.paintBodyPackages,
  agents: agents.paintBodyAgents,
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

const headsOnly = (owners, first) => {
  for (let i = 0; i < first; i++) {
    if (owners[i] !== null && owners[i] !== undefined) return false;
  }
  return true;
};

const tailBlank = (owners, last) => {
  for (let i = last + 1; i < owners.length; i++) {
    if (owners[i] !== null && owners[i] !== undefined) return last;
  }
  return Math.max(last, owners.length - 1);
};

const revealScroll = (owners, focus, height, prefer) => {
  const first = owners.indexOf(focus);
  if (first < 0) return prefer;
  const last = owners.lastIndexOf(focus);
  const room = Math.max(1, height);
  const end = tailBlank(owners, last);
  const top = headsOnly(owners, first) ? 0 : first;
  let start = Math.min(prefer, top);
  if (end >= start + room) {
    const fits = end - top + 1 <= room;
    if (fits || end > last) start = end - room + 1;
    else start = first;
  }
  const max = Math.max(0, owners.length - room);
  return clamp(start, 0, max);
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

const numberDigits = (view) => {
  if (!view || view.lineNumbers !== true) return 0;
  if (view.pane !== 'diff' && view.pane !== 'unit') return 0;
  return viewDigits(view);
};

const bodyFillKind = (listPane, splitBody) => {
  if (listPane) return 'files';
  return splitBody ? 'split' : 'plain';
};

const mapScrollBar = (bar, win) => {
  if (!bar) return null;
  const row = bar.row + win.shift - win.scroll;
  if (row < 0 || row >= win.shown) return null;
  const height = Math.min(bar.height, win.shown - row);
  return {
    x: bar.col,
    y: win.headerLines + row + 1,
    height,
    track: bar.track,
    rows: bar.rows,
    count: bar.count,
    start: bar.start,
  };
};

const windowBody = (view, painted, frame) => {
  const { width, color, bodyH, headerLines } = frame;
  const listPane = isListPane(view.pane);
  const fillKind = bodyFillKind(listPane, painted.splitBody);
  const digits = numberDigits(view);
  const filler = digits
    ? paintNumberFill(width, color, digits, painted.splitBody)
    : paintBodyFill(width, color, fillKind);
  const shift = !listPane && painted.body.length > 0 ? 1 : 0;
  const lead = (items, first) =>
    shift && items.length ? [first, ...items] : items;
  let body = lead(painted.body, filler);
  let taskOwners = lead(painted.taskOwners, null);
  let taskChecks = lead(painted.taskChecks, false);
  if (isTaskView(view) && body.length > bodyH) {
    body = body.concat(filler);
    taskOwners = taskOwners.concat(null);
    taskChecks = taskChecks.concat(false);
  }
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
    scrollBar: mapScrollBar(painted.scrollBar, win),
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
  const planHit = statusPlanHit(view, width, statusY);
  const choices = statusChoiceHits(view, statusY);
  const statusHits = [];
  if (branchHit) statusHits.push(branchHit);
  if (planHit) statusHits.push(planHit);
  if (!statusHits.length) statusHits.push(...choices);
  const menu = planMenu(view, width, color, statusY);
  if (menu) {
    for (const line of menu.lines) {
      const index = line.y - 1;
      if (index <= 0 || index >= rows.length) continue;
      rows[index] = stampVisible(rows[index], menu.x, line.text);
    }
    statusHits.push(...menu.hits);
  }
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
    menuScroll: menu ? menu.scroll : painted.menuScroll,
    runScroll: painted.runScroll,
    cursor: hits.cursor ?? windowed.cursor,
    scrollBar: windowed.scrollBar,
    bodyH,
  };
};

const presentCursor = (cursor) => {
  if (!cursor || cursor.x <= 0 || cursor.y <= 0) return `${ESC}[?25l`;
  const pos = `${ESC}[${cursor.y};${cursor.x}H`;
  return `${pos}${ESC}[1 q${ESC}[?12h${ESC}[?25h`;
};

const presentRows = (rows, options = {}) => {
  let out = `${ESC}[?25l${ESC}[?2026h`;
  if (options.clear === true) out += `${ESC}[H${ESC}[2J`;
  const prev = options.prev;
  const same = prev && prev.length === rows.length ? prev : null;
  for (let i = 0; i < rows.length; i++) {
    if (same && same[i] === rows[i]) continue;
    out += `${ESC}[${i + 1};1H${rows[i]}`;
  }
  return `${out}${ESC}[?2026l${presentCursor(options.cursor)}`;
};

module.exports = {
  renderFrame,
  presentCursor,
  presentRows,
};
