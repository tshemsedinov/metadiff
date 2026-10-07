'use strict';

const { extractText, isRange } = require('../select.js');
const editClick = require('./edit-click.js');
const filesPane = require('./files-pane.js');
const { hitAction } = require('../keys.js');
const { copyText } = require('../clipboard.js');

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

const RELEASE_TARGETS = [
  {
    match: () => true,
    hits: 'statusHits',
    onHit: (ui, hit) => {
      if (hit.id === 'branch') return void ui.gitBranches.onBranch();
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
    onHit: (ui, hit) => {
      if (hit.side === 'runs') {
        ui.agents.focus = 'runs';
        ui.agents.runCursor = hit.cursor;
        const again = armDoubleClick(ui.nav, 'agent-runs', hit.cursor);
        if (again && ui.mode === 'review') {
          const job = ui.agents.selectedRun();
          if (job) ui.agents.openView(job.id);
        }
        return;
      }
      ui.agents.focusCli();
      ui.agents.runCursor = 0;
      ui.agents.runScroll = 0;
      if (hit.field === 'fast') {
        ui.nav.agentCursor = hit.cursor;
        const again = armDoubleClick(ui.nav, 'agent-fast', hit.cursor);
        if (again) ui.agents.toggleFast();
        else ui.paint();
        return;
      }
      if (
        hit.field === 'model' ||
        hit.field === 'effort' ||
        hit.field === 'context' ||
        hit.field === 'plan'
      ) {
        ui.nav.agentCursor = hit.cursor;
        ui.agents.openPick(hit.field);
        return;
      }
      const again = armDoubleClick(ui.nav, 'agents', hit.cursor);
      ui.nav.agentCursor = hit.cursor;
      if (again && ui.mode === 'review') void ui.agents.start();
    },
  },
  {
    match: (ui) => ui.pane === 'npm',
    hits: 'fileHits',
    onHit: (ui, hit) => {
      const again = armDoubleClick(ui.nav, 'npm', hit.cursor);
      ui.nav.npmCursor = hit.cursor;
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

const COMBO_FIELDS = new Set(['model', 'effort', 'context', 'plan']);

const switchAgentCombo = (ui, cell) => {
  const frame = ui.lastFrame;
  const hits = (frame?.fileHits ?? []).filter((hit) =>
    COMBO_FIELDS.has(hit.field),
  );
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
  if (editClick.placeClick(ui, cell)) return;
  const frame = ui.lastFrame;
  if (ui.pane === 'agents' && ui.agents.pick) {
    const hits = (frame?.fileHits ?? []).filter((hit) => hit.field === 'menu');
    const opened = clickHit(ui, hits, cell, (ui, hit) => {
      const items = ui.agents.menuItems();
      const name = items[hit.cursor];
      if (ui.agents.pick.field === 'plan' && ui.agents.planBusy(name)) {
        const label = `${name ?? ''}`;
        const gap = label.indexOf('  ');
        const file = gap > 0 ? label.slice(0, gap) : label;
        ui.status = `busy ${file}`;
        ui.paint();
        return;
      }
      ui.agents.pick.cursor = hit.cursor;
      ui.agents.acceptPick();
    });
    if (opened) return;
    if (switchAgentCombo(ui, cell)) return;
    ui.agents.closePick();
    return;
  }
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
