'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { withNewline } = require('../common/utilities.js');

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
  const base = withNewline(text);
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

const applyFileGit = async (ui, targets, label, write) => {
  let written = 0;
  try {
    for (const target of targets) {
      await write(ui.top, liveItem(ui, target));
      written++;
    }
    ui.status = label;
    return { ok: true, written };
  } catch (error) {
    ui.status = error.message;
    return { ok: false, written };
  }
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
    write: (top, item) => repo.add(top, item),
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
  stageLazy(ui, [item], { busy: npmBusyKind(item), reload });
};

const onBlockUnstage = (ui, item) => unstageLazy(ui, [item]);

const onBlockRevert = (ui, item) => {
  const write = (top) => ui.repo.revert(top, item);
  const after = () => {
    dismissReloadable(ui, [item]);
    ui.reloadAfterChange();
  };
  ui.ops.track(ui.ops.apply('dropped', write, after));
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
  stageLazy(ui, targets, { busy, reload, afterUi: after });
};

const unstageTargets = (ui, targets, after = null) =>
  unstageLazy(ui, targets, { afterUi: after });

const revertTargets = (ui, targets) => {
  dismissReloadable(ui, targets);
  const write = (top, item) => ui.repo.revert(top, item);
  const done = (result) => {
    if (result.ok || result.written) ui.reloadAfterChange();
  };
  ui.ops.track(applyFileGit(ui, targets, 'dropped', write).then(done));
};

const revertFile = (ui, rel, selected, after) => {
  dismissReloadable(ui, selected);
  const write = (top) => ui.repo.revertFile(top, rel, selected);
  const done = (ok) => ui.reloadAfterChange(ok ? after : undefined);
  ui.ops.track(ui.ops.apply('dropped', write).then(done));
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
