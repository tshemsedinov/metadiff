'use strict';

const fs = require('node:fs');
const path = require('node:path');

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
  ignore: {
    match: () => true,
  },
};

const IGNORE_FILES = ['.gitignore', '.npmignore'];

const ignorePatternListed = (text, pattern) => {
  for (const line of `${text ?? ''}`.split('\n')) {
    if (line.trim() === pattern) return true;
  }
  return false;
};

const appendIgnorePattern = (text, pattern) => {
  if (ignorePatternListed(text, pattern)) return text;
  const base = text.length && !text.endsWith('\n') ? `${text}\n` : text;
  return `${base}${pattern}\n`;
};

const appendIgnoreFile = (top, name, pattern) => {
  const abs = path.join(top, name);
  if (name === '.npmignore' && !fs.existsSync(abs)) return false;
  const text = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  const next = appendIgnorePattern(text, pattern);
  if (next === text) return false;
  fs.writeFileSync(abs, next);
  return true;
};

const ignoreRelPath = (ui, rel) => {
  const pattern = `${rel ?? ''}`.replace(/^\//, '');
  if (!pattern) {
    ui.status = 'not a diff block';
    return;
  }
  let changed = false;
  for (const name of IGNORE_FILES) {
    if (appendIgnoreFile(ui.top, name, pattern)) changed = true;
  }
  if (!changed) {
    ui.status = 'already ignored';
    return;
  }
  ui.ignoreWatch();
  ui.nav.clearSelection();
  ui.reloadAfterChange();
  ui.status = 'ignored';
};

const sameEntry = (entry) => entry;

const keepOrigin = (ui, item, origin) => {
  ui.collection.keepOrigin(item, origin);
  const idx = ui.collection.findRestoredIndex({ ...item, origin });
  if (idx >= 0) ui.nav.index = idx;
  ui.ignoreWatch();
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

const enqueueOrigins = (ui, targets, spec) => {
  const writes = new Array(targets.length);
  for (let i = 0; i < targets.length; i++) {
    const current = liveItem(ui, targets[i]);
    writes[i] = current;
    keepOrigin(ui, current, spec.originOf(current));
  }
  if (spec.afterUi) spec.afterUi();
  if (!spec.busy) ui.status = spec.done;
  ui.ops.enqueueLazy({
    kind: spec.busy || spec.done,
    done: spec.done,
    reload: spec.reload === true,
    write: async (top) => {
      for (const item of writes) await spec.write(top, item);
    },
  });
};

const stageLazy = (ui, targets, extra = {}) => {
  const busy = extra.busy || '';
  const repo = ui.repo;
  enqueueOrigins(ui, targets, {
    done: 'staged',
    busy,
    reload: extra.reload === true,
    originOf: () => 'staged',
    afterUi: extra.afterUi,
    write: (top, item) => {
      if (busy && repo.addAsync) return repo.addAsync(top, item);
      return repo.add(top, item);
    },
  });
};

const unstageLazy = (ui, targets, extra = {}) => {
  const repo = ui.repo;
  enqueueOrigins(ui, targets, {
    done: 'unstaged',
    busy: '',
    originOf: nextUnstageOrigin,
    afterUi: extra.afterUi,
    write: (top, item) => repo.unstage(top, item),
  });
};

const onBlockAdd = (ui, item) => {
  const busy = npmBusyKind(item);
  const repo = ui.repo;
  if (ui.uiOpen) {
    return void stageLazy(ui, [item], {
      busy,
      reload: needsReload(item),
    });
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
  if (ui.uiOpen) return void unstageLazy(ui, [item]);
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

const dismissReloadable = (ui, targets) => {
  for (const item of targets) {
    if (needsReload(item)) ui.collection.dismiss(item);
  }
};

const onBlockRevert = (ui, item) => {
  const repo = ui.repo;
  applyGit(
    ui,
    item,
    'dropped',
    (top, current) => repo.revert(top, current),
    () => {
      dismissReloadable(ui, [item]);
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
  if (name === 'ignore') return void ignoreRelPath(ui, listPath(item));
  if (!command.match(item)) {
    ui.status = command.skipStatus;
    return;
  }
  BLOCK[name](ui, item);
};

const stageTargets = (ui, targets, after = null) => {
  const reload = targets.some(needsReload);
  const busy = targets.map(npmBusyKind).find((kind) => kind) || '';
  if (ui.uiOpen) {
    return void stageLazy(ui, targets, { busy, reload, afterUi: after });
  }
  const keepStaged = (entry) => keepOrigin(ui, entry, 'staged');
  const result = applyFileGit(ui, targets, 'staged', ui.repo.add, keepStaged);
  if (reconcilePartial(ui, result)) return;
  if (reload) ui.reloadAfterChange();
  if (after) after();
};

const unstageTargets = (ui, targets, after = null) => {
  if (ui.uiOpen) return void unstageLazy(ui, targets, { afterUi: after });
  const keepUnstaged = (entry) =>
    keepOrigin(ui, entry, nextUnstageOrigin(entry));
  const result = applyFileGit(
    ui,
    targets,
    'unstaged',
    ui.repo.unstage,
    keepUnstaged,
  );
  if (reconcilePartial(ui, result)) return;
  if (after) after();
};

const revertTargets = (ui, targets) => {
  dismissReloadable(ui, targets);
  const result = applyFileGit(
    ui,
    targets,
    'dropped',
    ui.repo.revert,
    sameEntry,
  );
  if (!result.ok && !result.completed.length) return;
  ui.reloadAfterChange();
};

const revertFile = (ui, rel, selected, after) => {
  dismissReloadable(ui, selected);
  try {
    ui.repo.revertFile(ui.top, rel, selected);
    ui.status = 'dropped';
  } catch (error) {
    ui.status = error.message;
    return void ui.reloadAfterChange();
  }
  ui.reloadAfterChange(after);
};

const TARGETS = {
  add: stageTargets,
  unstage: unstageTargets,
  revert: revertTargets,
};

const onFileCommand = (ui, name) => {
  const selected = fileActionItems(ui);
  if (!selected.length) {
    ui.status = 'not a diff block';
    return;
  }
  if (!guardWritable(ui, selected[0])) return;
  const rel = listPath(selected[0]);
  const next = () => selectNextFileAfter(ui, rel);
  if (name === 'ignore') return void ignoreRelPath(ui, rel);
  if (name === 'revert') return void revertFile(ui, rel, selected, next);
  const command = COMMANDS[name];
  const targets = selected.filter(command.match);
  if (!targets.length) {
    ui.status = command.skipStatus;
    return void next();
  }
  TARGETS[name](ui, targets, next);
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
  TARGETS[name](ui, targets);
};

const onCommand = (ui, name) => {
  if (ui.nav.pane === 'files') return void onFileCommand(ui, name);
  if (ui.nav.pane === 'unit') return void onUnitCommand(ui, name);
  onBlockCommand(ui, name);
};

const createChangeActions = (ui) => ({
  fileCursorEntry: () => fileCursorEntry(ui),
  onAdd: () => onCommand(ui, 'add'),
  onUnstage: () => onCommand(ui, 'unstage'),
  onRevert: () => onCommand(ui, 'revert'),
  onIgnore: () => onCommand(ui, 'ignore'),
});

module.exports = { createChangeActions };
