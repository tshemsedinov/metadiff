'use strict';

const fs = require('node:fs');
const path = require('node:path');

const files = require('../common/files.js');
const { listPath, isTaskItem, isTasksEntry, isReadOnlyOrigin } = files;
const { needsReload, npmBusyKind, sameBlock } = require('./items.js');
const { hunkKey } = require('../diff/diff.js');

const nextUnstageOrigin = (item) =>
  item.file.isNew === true ? 'untracked' : 'unstaged';

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

const appendIgnoreFile = (top, name, pattern) => {
  const abs = path.join(top, name);
  const exists = fs.existsSync(abs);
  if (name === '.npmignore' && !exists) return false;
  const text = exists ? fs.readFileSync(abs, 'utf8') : '';
  const lines = text.split('\n');
  if (lines.some((line) => line.trim() === pattern)) return false;
  const base = text && !text.endsWith('\n') ? `${text}\n` : text;
  fs.writeFileSync(abs, `${base}${pattern}\n`);
  return true;
};

const ignoreRelPath = (ui, rel) => {
  const pattern = `${rel ?? ''}`.replace(/^\//, '');
  if (!pattern) {
    ui.status = 'not a diff block';
    return;
  }
  const append = (name) => appendIgnoreFile(ui.top, name, pattern);
  if (!IGNORE_FILES.map(append).includes(true)) {
    ui.status = 'already ignored';
    return;
  }
  ui.ignoreWatch();
  ui.nav.clearSelection();
  ui.reloadAfterChange();
  ui.status = 'ignored';
};

const keepOrigin = (ui, item, origin) => {
  ui.collection.keepOrigin(item, origin);
  const idx = ui.collection.findRestoredIndex({ ...item, origin });
  if (idx >= 0) ui.nav.index = idx;
  ui.ignoreWatch();
  ui.nav.clearSelection();
  ui.syncReviewPath();
  ui.syncFileCursor();
};

const fileActionItems = (ui) => {
  const entry = ui.fileCursorEntry();
  if (!entry || isTasksEntry(entry)) return [];
  return ui.items.filter(
    (item) => !isTaskItem(item) && listPath(item) === entry.path,
  );
};

const activeDiffItem = (ui) => {
  const item = ui.current();
  if (!item) return null;
  if (isTaskItem(item)) {
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

const liveItem = (ui, item) =>
  ui.items.find((entry) => sameBlock(entry, item)) ?? item;

const applyGit = (ui, label, write, after) => {
  try {
    write(ui.top);
    ui.status = label;
    after();
  } catch (error) {
    ui.status = error.message;
  }
};

const applyFileGit = (ui, targets, label, write, afterItem = () => {}) => {
  let written = 0;
  try {
    for (const target of targets) {
      const current = liveItem(ui, target);
      write(ui.top, current);
      afterItem(current);
      written++;
    }
    ui.status = label;
    return { ok: true, written };
  } catch (error) {
    ui.status = error.message;
    return { ok: false, written };
  }
};

const reconcilePartial = (ui, result) => {
  if (result.ok) return false;
  if (result.written) ui.reloadAfterChange();
  return true;
};

const enqueueOrigins = (ui, targets, spec) => {
  const writes = targets.map((target) => {
    const item = liveItem(ui, target);
    keepOrigin(ui, item, spec.originOf(item));
    return item;
  });
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

const dismissReloadable = (ui, targets) => {
  for (const item of targets) {
    if (needsReload(item)) ui.collection.dismiss(item);
  }
};

const onBlockAdd = (ui, item) => {
  const reload = needsReload(item);
  if (ui.uiOpen) {
    return void stageLazy(ui, [item], { busy: npmBusyKind(item), reload });
  }
  applyGit(
    ui,
    'staged',
    (top) => ui.repo.add(top, item),
    () => {
      if (reload) ui.reloadAfterChange();
      else keepOrigin(ui, item, 'staged');
    },
  );
};

const onBlockUnstage = (ui, item) => {
  if (ui.uiOpen) return void unstageLazy(ui, [item]);
  const origin = nextUnstageOrigin(item);
  applyGit(
    ui,
    'unstaged',
    (top) => ui.repo.unstage(top, item),
    () => keepOrigin(ui, item, origin),
  );
};

const onBlockRevert = (ui, item) => {
  applyGit(
    ui,
    'dropped',
    (top) => ui.repo.revert(top, item),
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
  const result = applyFileGit(ui, targets, 'dropped', ui.repo.revert);
  if (!result.ok && !result.written) return;
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
  return key ? ui.items.filter((entry) => hunkKey(entry) === key) : [];
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

module.exports = { onCommand };
