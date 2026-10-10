'use strict';

const { extractText, isRange } = require('../select.js');
const { scrollAtThumb, scrollThumb } = require('../render/npm.js');
const editClick = require('./edit-click.js');
const filesPane = require('./files-pane.js');
const { hitAction } = require('../keys.js');
const { copyText } = require('../clipboard.js');
const { stopImport } = require('./import.js');

const mouseCell = (ui, event) => {
  const size = ui.lastSize ?? ui.getSize();
  const x = Math.min(Math.max(1, event.x), size.width);
  const y = Math.min(Math.max(1, event.y), size.height);
  return { x, y };
};

const onLogBar = (bar, cell) => {
  if (!bar || cell.x !== bar.x) return false;
  const index = cell.y - bar.y;
  return index >= 0 && index < bar.height;
};

const logLocal = (bar, cell) => {
  const local = cell.y - bar.y - bar.track;
  if (local < 0) return 0;
  const last = bar.rows - 1;
  if (local > last) return last;
  return local;
};

const logGrab = (local, thumb) => {
  if (local <= thumb.at) return 0;
  const end = thumb.at + thumb.size - 1;
  if (local >= end) return thumb.size - 1;
  return local - thumb.at;
};

const moveLogBar = (ui, cell) => {
  const bar = ui.lastFrame && ui.lastFrame.scrollBar;
  const drag = ui.nav.scrollDrag;
  if (!bar || !drag) return;
  const top = logLocal(bar, cell) - drag.grab;
  const at = scrollAtThumb(top, drag.thumb);
  if (ui.agents.viewing) ui.agents.placeLog(at);
  else ui.agents.placeRuns(at);
};

const startLogDrag = (ui, cell) => {
  const bar = ui.lastFrame && ui.lastFrame.scrollBar;
  if (!onLogBar(bar, cell)) return false;
  const thumb = scrollThumb(bar.count, bar.rows, bar.start);
  if (!thumb) return false;
  const nav = ui.nav;
  const local = logLocal(bar, cell);
  nav.scrollDrag = { grab: logGrab(local, thumb), thumb };
  nav.mouseAnchor = null;
  nav.pendingClick = null;
  nav.selection = null;
  moveLogBar(ui, cell);
  return true;
};

const dismissImport = (ui, event) => {
  if (ui.mode !== 'import') return;
  const frame = ui.lastFrame;
  const cell = mouseCell(ui, event);
  const onField = frame && cell.y === frame.height - 1;
  if (onField) return;
  stopImport(ui);
};

const onPress = (ui, event) => {
  dismissImport(ui, event);
  const nav = ui.nav;
  const cell = mouseCell(ui, event);
  if (startLogDrag(ui, cell)) return;
  nav.scrollDrag = null;
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
  const cell = mouseCell(ui, event);
  if (nav.scrollDrag) return void moveLogBar(ui, cell);
  if (!nav.mouseAnchor) return;
  nav.pendingClick = null;
  nav.selection = {
    start: nav.mouseAnchor,
    end: cell,
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

const DOUBLE_CLICK_MS = 500;

const armDoubleClick = (nav, pane, cursor) => {
  const now = Date.now();
  const prev = nav.lastClick;
  const again =
    prev !== null &&
    prev.pane === pane &&
    prev.cursor === cursor &&
    now - prev.at <= DOUBLE_CLICK_MS;
  nav.lastClick = { pane, cursor, at: now };
  return again;
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

const COMBO_FIELDS = new Set(['model', 'effort', 'context', 'plan']);

const onAgentRunHit = (ui, hit) => {
  ui.agents.focus = 'runs';
  ui.agents.runCursor = hit.cursor;
  const again = armDoubleClick(ui.nav, 'agent-runs', hit.cursor);
  if (!again || ui.mode !== 'review') return;
  const session = ui.agents.selectedSession();
  if (session && session.id) ui.agents.openSession(session.id);
  else ui.agents.start();
};

const onAgentHit = (ui, hit) => {
  if (hit.side === 'runs') return void onAgentRunHit(ui, hit);
  ui.agents.focusCli();
  const changed = ui.nav.agentCursor !== hit.cursor;
  ui.nav.agentCursor = hit.cursor;
  if (changed) {
    ui.agents.runCursor = 0;
    ui.agents.runScroll = 0;
  }
  if (COMBO_FIELDS.has(hit.field)) return void ui.agents.openPick(hit.field);
  if (hit.field === 'fast') {
    ui.agents.toggleFast();
    return;
  }
  const again = armDoubleClick(ui.nav, 'agents', hit.cursor);
  if (again && ui.mode === 'review') ui.agents.start();
};

const RELEASE_TARGETS = [
  {
    match: () => true,
    hits: 'statusHits',
    onHit: (ui, hit) => {
      if (hit.id === 'branch') return void ui.gitBranches.onBranch();
      if (hit.id === 'plan') return void ui.composer.tasks.togglePlanMenu();
      if (hit.id === 'plan-item') {
        return void ui.composer.tasks.choosePlan(hit.cursor);
      }
      if (ui.nav.planOpen) ui.composer.tasks.closePlanMenu();
      ui.confirmChoice(hit.id);
    },
  },
  {
    match: (ui) => ui.pane === 'dashboard',
    hits: 'fileHits',
    onHit: (ui, hit) => ui.dashboard.open(hit.cursor),
  },
  {
    match: (ui) => ui.pane === 'repos',
    hits: 'fileHits',
    onHit: (ui, hit) => {
      void ui.workspace.openAt(hit.cursor);
    },
  },
  {
    match: (ui) => ui.pane === 'files',
    hits: 'fileHits',
    onHit: (ui, hit) => {
      const again = armDoubleClick(ui.nav, 'files', hit.cursor);
      ui.nav.fileCursor = hit.cursor;
      if (again) filesPane.onOpenFile(ui);
    },
  },
  {
    match: (ui) => ui.pane === 'branches',
    hits: 'fileHits',
    onHit: (ui, hit) => {
      const again = armDoubleClick(ui.nav, 'branches', hit.cursor);
      ui.nav.branchCursor = hit.cursor;
      if (again) ui.gitBranches.onCheckoutBranch();
    },
  },
  {
    match: (ui) => ui.pane === 'commits',
    hits: 'fileHits',
    onHit: (ui, hit) => {
      if (ui.mode === 'compose') return;
      const again = armDoubleClick(ui.nav, 'commits', hit.cursor);
      ui.nav.commitCursor = hit.cursor;
      if (again) filesPane.onOpenFile(ui);
    },
  },
  {
    match: (ui) => ui.pane === 'packages',
    hits: 'fileHits',
    onHit: (ui, hit) => {
      ui.nav.packagesCursor = hit.cursor;
    },
  },
  {
    match: (ui) => ui.pane === 'agents',
    hits: 'fileHits',
    onHit: onAgentHit,
  },
  {
    match: (ui) => ui.pane === 'npm',
    hits: 'fileHits',
    onHit: (ui, hit) => {
      if (hit.side === 'runs') {
        ui.npm.runCursor = hit.cursor;
        ui.npm.focusRuns();
        const again = armDoubleClick(ui.nav, 'npm-runs', hit.cursor);
        if (again && ui.mode === 'review') ui.npm.run();
        return;
      }
      ui.npm.focusCommands();
      const again = armDoubleClick(ui.nav, 'npm', hit.cursor);
      ui.nav.npmCursor = hit.cursor;
      ui.npm.clampRuns();
      if (again && ui.mode === 'review') ui.npm.run();
    },
  },
  {
    match: (ui) => ui.pane === 'tasks',
    hits: 'taskHits',
    onHit: (ui, hit) => {
      if (hit.check) return void ui.composer.tasks.onTaskCheck(hit.cursor);
      ui.composer.tasks.onTaskHit(hit.cursor);
    },
  },
  {
    match: (ui) => ui.mode === 'compose',
    hits: 'templateHits',
    onHit: (ui, hit) => ui.selectTemplate(hit.cursor),
  },
];

const frameHits = (ui, accept) => (ui.lastFrame?.fileHits ?? []).filter(accept);

const switchAgentCombo = (ui, cell) => {
  const hits = frameHits(ui, (hit) => COMBO_FIELDS.has(hit.field));
  return clickHit(ui, hits, cell, (ui, hit) => {
    const same =
      ui.agents.pick.field === hit.field && ui.nav.agentCursor === hit.cursor;
    if (same) {
      ui.agents.closePick();
      return;
    }
    ui.agents.dismissPick();
    ui.agents.focusCli();
    ui.nav.agentCursor = hit.cursor;
    ui.agents.openPick(hit.field);
    if (!ui.agents.pick) ui.paint();
  });
};

const releaseAgentMenu = (ui, cell) => {
  const hits = frameHits(ui, (hit) => hit.field === 'menu');
  const accept = (ui, hit) => ui.agents.acceptPick(hit.cursor);
  if (clickHit(ui, hits, cell, accept)) return;
  if (switchAgentCombo(ui, cell)) return;
  ui.agents.closePick();
};

const onRelease = (ui, event) => {
  dismissImport(ui, event);
  const nav = ui.nav;
  const cell = mouseCell(ui, event);
  if (nav.scrollDrag) {
    moveLogBar(ui, cell);
    nav.scrollDrag = null;
    nav.mouseAnchor = null;
    nav.pendingClick = null;
    nav.selection = null;
    return;
  }
  if (nav.mouseAnchor) {
    nav.selection = { start: nav.mouseAnchor, end: cell };
  }
  const clickId = nav.pendingClick;
  nav.pendingClick = null;
  nav.mouseAnchor = null;
  if (clickButton(ui, cell, clickId)) return;
  if (editClick.placeClick(ui, cell)) return;
  if (ui.pane === 'agents' && ui.agents.pick) {
    return void releaseAgentMenu(ui, cell);
  }
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
  wheelUp: (ui) => filesPane.onScroll(ui, -1),
  wheelDown: (ui) => filesPane.onScroll(ui, 1),
  press: onPress,
  drag: onDrag,
  release: onRelease,
};

const handlePointer = (ui, event) => {
  const kind = event.kind;
  const handler = POINTER_HANDLERS[kind];
  if (!handler) return;
  const isWheel = kind === 'wheelUp' || kind === 'wheelDown';
  if (!isWheel && event.btn !== 0 && event.btn !== undefined) return;
  handler(ui, event);
};

module.exports = { handlePointer };
