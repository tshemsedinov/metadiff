'use strict';

const select = require('../select.js');
const { extractText, isRange } = select;
const keys = require('../keys.js');
const { hitAction } = keys;
const clipboard = require('../clipboard.js');
const { copyText } = clipboard;

const mouseCell = (ui, event) => {
  const size = ui.lastSize ?? ui.getSize();
  const x = Math.min(Math.max(1, event.x), size.width);
  const y = Math.min(Math.max(1, event.y), size.height);
  return { x, y };
};

const onPress = (ui, event) => {
  const nav = ui.nav;
  const cell = mouseCell(ui, event);
  nav.mouseAnchor = cell;
  nav.pendingClick = null;
  nav.selection = null;
  const frame = ui.lastFrame;
  if (frame && cell.y === frame.height) {
    nav.pendingClick = hitAction(frame.buttons, cell.x - 1);
  }
};

const onDrag = (ui, event) => {
  const nav = ui.nav;
  if (!nav.mouseAnchor) return;
  nav.pendingClick = null;
  nav.selection = {
    start: nav.mouseAnchor,
    end: mouseCell(ui, event),
  };
};

const clickButton = (ui, cell, clickId) => {
  const nav = ui.nav;
  const frame = ui.lastFrame;
  if (!clickId || !frame || isRange(nav.selection)) return false;
  const id = hitAction(frame.buttons, cell.x - 1);
  if (id === clickId && cell.y === frame.height) {
    ui.dispatch(id);
  }
  nav.selection = null;
  return true;
};

const clickHit = (ui, hits, cell, onHit) => {
  const nav = ui.nav;
  if (!hits || isRange(nav.selection)) return false;
  const x = cell.x - 1;
  const hit = hits.find((row) => {
    if (row.y !== cell.y) return false;
    if (row.x0 === undefined) return true;
    return x >= row.x0 && x < row.x1;
  });
  if (!hit) return false;
  onHit(ui, hit);
  nav.selection = null;
  return true;
};

const copySelection = (ui) => {
  const nav = ui.nav;
  const frame = ui.lastFrame;
  if (!isRange(nav.selection) || !frame) return;
  const text = extractText(frame.rows, nav.selection);
  if (!text) return;
  const ok = copyText(text, ui.stdout);
  ui.status = ok ? 'copied' : 'copy failed';
};

const RELEASE_TARGETS = [
  {
    match: () => true,
    hits: 'statusHits',
    onHit: (ui, hit) => {
      if (hit.id === 'branch') return void ui.gitBranches.onBranch();
      ui.input.confirmChoice(hit.id);
    },
  },
  {
    match: (ui) => ui.pane === 'files',
    hits: 'fileHits',
    onHit: (ui, hit) => {
      ui.nav.fileCursor = hit.cursor;
      ui.filesPane.onOpenFile();
    },
  },
  {
    match: (ui) => ui.pane === 'branches',
    hits: 'fileHits',
    onHit: (ui, hit) => {
      ui.nav.branchCursor = hit.cursor;
      ui.gitBranches.onCheckoutBranch();
    },
  },
  {
    match: (ui) => ui.pane === 'commits',
    hits: 'fileHits',
    onHit: (ui, hit) => {
      if (ui.mode === 'compose') return;
      ui.nav.commitCursor = hit.cursor;
    },
  },
  {
    match: (ui) => ui.pane === 'npm',
    hits: 'fileHits',
    onHit: (ui, hit) => {
      ui.nav.npmCursor = hit.cursor;
    },
  },
  {
    match: (ui) => ui.pane === 'diff',
    hits: 'todoHits',
    onHit: (ui, hit) => {
      if (hit.check) return void ui.composer.onTodoCheck(hit.cursor);
      ui.composer.onTodoHit(hit.cursor);
    },
  },
  {
    match: (ui) => ui.mode === 'compose',
    hits: 'templateHits',
    onHit: (ui, hit) => ui.selectTemplate(hit.cursor),
  },
];

const onRelease = (ui, event) => {
  const nav = ui.nav;
  const cell = mouseCell(ui, event);
  if (nav.mouseAnchor) {
    nav.selection = { start: nav.mouseAnchor, end: cell };
  }
  const clickId = nav.pendingClick;
  nav.pendingClick = null;
  nav.mouseAnchor = null;
  if (clickButton(ui, cell, clickId)) return;
  const frame = ui.lastFrame;
  for (const target of RELEASE_TARGETS) {
    if (!target.match(ui)) continue;
    const hits = frame?.[target.hits];
    const opened = clickHit(ui, hits, cell, target.onHit);
    if (opened) return;
  }
  copySelection(ui);
};

const POINTER_HANDLERS = {
  wheelUp: (ui) => ui.filesPane.onScroll(-1),
  wheelDown: (ui) => ui.filesPane.onScroll(1),
  press: onPress,
  drag: onDrag,
  release: onRelease,
};

const handle = (ui, event) => {
  const kind = event.kind;
  const handler = POINTER_HANDLERS[kind];
  if (!handler) return;
  const isWheel = kind === 'wheelUp' || kind === 'wheelDown';
  if (!isWheel && event.btn !== 0 && event.btn !== undefined) return;
  handler(ui, event);
};

const createPointer = (ui) => ({
  handle: (event) => handle(ui, event),
});

module.exports = { createPointer };
