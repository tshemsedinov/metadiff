'use strict';

const files = require('../files.js');
const { listPath, isTodoItem, isTodosEntry, isReadOnlyOrigin } = files;
const items = require('./items.js');
const { needsReload, npmBusyKind, sameBlock } = items;
const diff = require('../diff/diff.js');
const { hunkKey } = diff;

const nextUnstageOrigin = (item) => {
  if (item.file.isNew === true) return 'untracked';
  return 'unstaged';
};

const COMMANDS = {
  add: {
    skipStatus: 'already staged',
    match: (item) => item.origin !== 'staged',
  },
  unstage: {
    skipStatus: 'not staged',
    match: (item) => item.origin === 'staged',
  },
  revert: {
    match: () => true,
  },
};

const keepOrigin = (ui, item, origin) => {
  ui.collection.keepOrigin(item, origin);
  const idx = ui.collection.findRestoredIndex({ ...item, origin });
  if (idx >= 0) ui.nav.index = idx;
  if (ui.ignoreWatch) ui.ignoreWatch();
  ui.nav.clearSelection();
  ui.syncReviewPath();
  ui.syncFileCursor();
};

const fileCursorEntry = (ui) => {
  const list = ui.fileList();
  return list[ui.nav.fileCursor] ?? null;
};

const fileActionItems = (ui) => {
  const entry = fileCursorEntry(ui);
  if (!entry || isTodosEntry(entry)) return [];
  const rel = entry.path;
  const selected = [];
  for (const item of ui.items) {
    if (isTodoItem(item)) continue;
    if (listPath(item) !== rel) continue;
    selected.push(item);
  }
  return selected;
};

const activeDiffItem = (ui) => {
  const item = ui.current();
  if (!item) return null;
  if (isTodoItem(item)) {
    ui.status = 'not a diff block';
    return null;
  }
  return item;
};

const guardWritable = (ui, item) => {
  if (!item) return false;
  const caps = ui.capabilities;
  if (!caps.changes || isReadOnlyOrigin(item.origin)) {
    ui.status = 'read only';
    return false;
  }
  return true;
};

const selectNextFileAfter = (ui, rel) => {
  const list = ui.fileList();
  const nav = ui.nav;
  if (!list.length) {
    nav.fileCursor = 0;
    nav.reviewPath = null;
    return;
  }
  const idx = list.findIndex((entry) => entry.path === rel);
  let at = idx < 0 ? nav.fileCursor : idx + 1;
  if (at >= list.length) at = list.length - 1;
  const entry = list[at];
  nav.fileCursor = at;
  nav.reviewPath = entry.path;
  nav.index = entry.firstIndex;
};

const liveItem = (ui, item) => {
  for (const entry of ui.items) {
    if (sameBlock(entry, item)) return entry;
  }
  return item;
};

const applyGit = (ui, item, label, write, after) => {
  try {
    write(ui.top, item);
    ui.status = label;
    after();
  } catch (error) {
    ui.status = error.message;
  }
};

const applyFileGit = (ui, targets, label, write, afterItem) => {
  const { length } = targets;
  const completed = new Array(length);
  let n = 0;
  try {
    for (let i = 0; i < length; i++) {
      const current = liveItem(ui, targets[i]);
      write(ui.top, current);
      afterItem(current);
      completed[n++] = current;
    }
    completed.length = n;
    ui.status = label;
    return { ok: true, completed };
  } catch (error) {
    completed.length = n;
    ui.status = error.message;
    return { ok: false, completed };
  }
};

const reconcilePartial = (ui, result) => {
  if (result.ok) return false;
  if (result.completed.length) ui.reloadAfterChange();
  return true;
};

const applyBlockAdd = (ui, item) => {
  if (needsReload(item)) return void ui.reloadAfterChange();
  keepOrigin(ui, item, 'staged');
};

const onBlockAdd = (ui, item) => {
  const busy = npmBusyKind(item);
  const repo = ui.repo;
  if (ui.uiOpen && busy && repo.addAsync) {
    const after = () => applyBlockAdd(ui, item);
    const write = (top) => repo.addAsync(top, item);
    return void ui.ops.runBusy(busy, 'staged', write, after);
  }
  applyGit(
    ui,
    item,
    'staged',
    (top, current) => repo.add(top, current),
    () => {
      applyBlockAdd(ui, item);
    },
  );
};

const onBlockUnstage = (ui, item) => {
  const origin = nextUnstageOrigin(item);
  const repo = ui.repo;
  applyGit(
    ui,
    item,
    'unstaged',
    (top, current) => repo.unstage(top, current),
    () => keepOrigin(ui, item, origin),
  );
};

const onBlockRevert = (ui, item) => {
  const repo = ui.repo;
  applyGit(
    ui,
    item,
    'dropped',
    (top, current) => repo.revert(top, current),
    () => {
      if (needsReload(item)) ui.collection.dismiss(item);
      ui.reloadAfterChange();
    },
  );
};

const BLOCK = {
  add: onBlockAdd,
  unstage: onBlockUnstage,
  revert: onBlockRevert,
};

const onBlockCommand = (ui, name) => {
  const command = COMMANDS[name];
  const item = activeDiffItem(ui);
  if (!guardWritable(ui, item)) return;
  if (!command.match(item)) {
    ui.status = command.skipStatus;
    return;
  }
  BLOCK[name](ui, item);
};

const writeFileAddAsync = (ui, targets) => async (top) => {
  const repo = ui.repo;
  for (const item of targets) {
    const current = liveItem(ui, item);
    await repo.addAsync(top, current);
    keepOrigin(ui, current, 'staged');
  }
};

const afterFileAdd = (ui, rel, proposed) => () => {
  if (proposed) {
    return void ui.reloadAfterChange(() => selectNextFileAfter(ui, rel));
  }
  selectNextFileAfter(ui, rel);
};

const onFileAdd = (ui) => {
  const selected = fileActionItems(ui);
  if (!selected.length) {
    ui.status = 'not a diff block';
    return;
  }
  if (!guardWritable(ui, selected[0])) return;
  const rel = listPath(selected[0]);
  const targets = selected.filter(COMMANDS.add.match);
  if (!targets.length) {
    ui.status = 'already staged';
    selectNextFileAfter(ui, rel);
    return;
  }
  const proposed = targets.some(needsReload);
  const busy = targets.map(npmBusyKind).find((kind) => kind);
  const repo = ui.repo;
  if (ui.uiOpen && busy && repo.addAsync) {
    const write = writeFileAddAsync(ui, targets);
    const after = afterFileAdd(ui, rel, proposed);
    return void ui.ops.runBusy(busy, 'staged', write, after);
  }
  const result = applyFileGit(
    ui,
    targets,
    'staged',
    (top, current) => repo.add(top, current),
    (item) => keepOrigin(ui, item, 'staged'),
  );
  if (reconcilePartial(ui, result)) return;
  if (proposed) ui.reloadAfterChange();
  selectNextFileAfter(ui, rel);
};

const onFileUnstage = (ui) => {
  const selected = fileActionItems(ui);
  if (!selected.length) {
    ui.status = 'not a diff block';
    return;
  }
  if (!guardWritable(ui, selected[0])) return;
  const rel = listPath(selected[0]);
  const targets = selected.filter(COMMANDS.unstage.match);
  if (!targets.length) {
    ui.status = 'not staged';
    selectNextFileAfter(ui, rel);
    return;
  }
  const repo = ui.repo;
  const result = applyFileGit(
    ui,
    targets,
    'unstaged',
    (top, current) => repo.unstage(top, current),
    (item) => keepOrigin(ui, item, nextUnstageOrigin(item)),
  );
  if (reconcilePartial(ui, result)) return;
  selectNextFileAfter(ui, rel);
};

const onFileRevert = (ui) => {
  const selected = fileActionItems(ui);
  if (!selected.length) {
    ui.status = 'not a diff block';
    return;
  }
  if (!guardWritable(ui, selected[0])) return;
  const rel = listPath(selected[0]);
  for (const item of selected) {
    if (needsReload(item)) ui.collection.dismiss(item);
  }
  let ok = false;
  try {
    ui.repo.revertFile(ui.top, rel, selected);
    ui.status = 'dropped';
    ok = true;
  } catch (error) {
    ui.status = error.message;
  }
  const after = ok ? () => selectNextFileAfter(ui, rel) : null;
  ui.reloadAfterChange(after);
};

const FILE = {
  add: onFileAdd,
  unstage: onFileUnstage,
  revert: onFileRevert,
};

const hunkActionItems = (ui, item) => {
  const key = hunkKey(item);
  const selected = [];
  if (!key) return selected;
  for (const entry of ui.items) {
    if (hunkKey(entry) !== key) continue;
    selected.push(entry);
  }
  return selected;
};

const onUnitAdd = (ui, targets) => {
  const proposed = targets.some(needsReload);
  const busy = targets.map(npmBusyKind).find((kind) => kind);
  const repo = ui.repo;
  if (ui.uiOpen && busy && repo.addAsync) {
    const write = writeFileAddAsync(ui, targets);
    const after = () => {
      if (proposed) ui.reloadAfterChange();
    };
    return void ui.ops.runBusy(busy, 'staged', write, after);
  }
  const result = applyFileGit(
    ui,
    targets,
    'staged',
    (top, current) => repo.add(top, current),
    (entry) => keepOrigin(ui, entry, 'staged'),
  );
  if (reconcilePartial(ui, result)) return;
  if (proposed) ui.reloadAfterChange();
};

const onUnitUnstage = (ui, targets) => {
  const repo = ui.repo;
  const result = applyFileGit(
    ui,
    targets,
    'unstaged',
    (top, current) => repo.unstage(top, current),
    (entry) => keepOrigin(ui, entry, nextUnstageOrigin(entry)),
  );
  reconcilePartial(ui, result);
};

const onUnitRevert = (ui, targets) => {
  for (const item of targets) {
    if (needsReload(item)) ui.collection.dismiss(item);
  }
  const repo = ui.repo;
  const result = applyFileGit(
    ui,
    targets,
    'dropped',
    (top, current) => repo.revert(top, current),
    (entry) => entry,
  );
  if (!result.ok && !result.completed.length) return;
  ui.reloadAfterChange();
};

const UNIT = {
  add: onUnitAdd,
  unstage: onUnitUnstage,
  revert: onUnitRevert,
};

const onUnitCommand = (ui, name) => {
  const command = COMMANDS[name];
  const item = activeDiffItem(ui);
  if (!guardWritable(ui, item)) return;
  const selected = hunkActionItems(ui, item);
  const targets = name === 'revert' ? selected : selected.filter(command.match);
  if (!targets.length) {
    ui.status = command.skipStatus ?? 'not a diff block';
    return;
  }
  UNIT[name](ui, targets);
};

const onCommand = (ui, name) => {
  if (ui.nav.pane === 'files') return void FILE[name](ui);
  if (ui.nav.pane === 'unit') return void onUnitCommand(ui, name);
  onBlockCommand(ui, name);
};

const createChangeActions = (ui) => ({
  fileCursorEntry: () => fileCursorEntry(ui),
  onAdd: () => onCommand(ui, 'add'),
  onUnstage: () => onCommand(ui, 'unstage'),
  onRevert: () => onCommand(ui, 'revert'),
});

module.exports = { createChangeActions };
