'use strict';

const commands = require('../npm-commands.js');
const npm = require('../render/npm.js');
const { logViewRows } = npm;

const { listCommands, reduceOutput, writeLog } = commands;
const { staleLogFiles, removeStaleLogs, formatSize } = commands;
const { saveScript, removeScript, reorderScript } = commands;

const NAME_RE = /^[\w:.-]+$/;
const { startNpm } = commands;

const selected = (api) => {
  const cursor = api.ui.nav.npmCursor;
  return api.state.commands[cursor];
};

const clampCursor = (api) => {
  const last = api.state.commands.length - 1;
  const nav = api.ui.nav;
  if (nav.npmCursor > last) nav.npmCursor = Math.max(0, last);
  if (nav.npmCursor < 0) nav.npmCursor = 0;
};

const refresh = (api) => {
  api.state.commands = listCommands(api.ui.top);
  clampCursor(api);
};

const canEdit = (ui) => {
  if (ui.capabilities && ui.capabilities.changes === false) return false;
  if (ui.readOnly) return false;
  return true;
};

const refreshLogs = (api) => {
  try {
    const found = staleLogFiles(api.ui.top);
    api.state.logBytes = found.bytes;
  } catch (error) {
    api.state.logBytes = 0;
    api.ui.status = error.message;
  }
};

const open = (api) => {
  if (api.ui.mode === 'compose') return;
  refresh(api);
  refreshLogs(api);
  api.state.viewing = false;
  api.state.output = '';
  api.ui.nav.pane = 'npm';
  api.ui.status = '';
  api.ui.nav.clearSelection();
};

const scrollLog = (api, delta) => {
  const lines = api.state.output.split('\n');
  let count = lines.at(-1) === '' ? lines.length - 1 : lines.length;
  if (api.state.running) count += 1;
  const frame = api.ui.lastFrame;
  const bodyH = frame && frame.bodyH ? frame.bodyH : 1;
  const max = Math.max(0, count - logViewRows(bodyH));
  let start = api.state.followEnd ? max : api.state.logScroll;
  start = Math.min(max, Math.max(0, start + delta));
  api.state.followEnd = start === max;
  api.state.logScroll = start;
};

const move = (api, delta) => {
  if (api.state.viewing) return void scrollLog(api, delta);
  if (!api.state.commands.length) return;
  const nav = api.ui.nav;
  const last = api.state.commands.length - 1;
  const next = Math.min(last, Math.max(0, nav.npmCursor + delta));
  if (next === nav.npmCursor) return;
  nav.npmCursor = next;
  api.ui.status = '';
};

const stopRun = (api) => {
  api.state.running = false;
  api.state.child = null;
  api.ui.progress.stop('npm');
};

const shownOutput = (api, raw, status) => {
  if (!api.state.verbose) return reduceOutput(raw, api.ui.top, status);
  const text = `${raw ?? ''}`;
  if (!text) return '';
  if (text.endsWith('\n')) return text;
  return `${text}\n`;
};

const showOutput = (api, text) => {
  if (!api.state.viewing || !api.state.running) return;
  if (api.state.stopping) return;
  api.state.raw = text;
  api.state.output = shownOutput(api, text, '');
  api.ui.paint();
};

const withNotice = (text, notice) => {
  const body = `${text ?? ''}`;
  if (body.endsWith(`${notice}\n`)) return body;
  if (!body) return `${notice}\n`;
  if (body.endsWith('\n')) return `${body}${notice}\n`;
  return `${body}\n${notice}\n`;
};

const finishRun = (api, entry, result) => {
  const stopped = api.state.stopping === true;
  const raw = stopped ? withNotice(api.state.raw, 'terminated') : result.text;
  const reduced = stopped
    ? withNotice(reduceOutput(api.state.raw, api.ui.top, ''), 'terminated')
    : reduceOutput(result.text, api.ui.top, result.status);
  api.state.raw = raw;
  api.state.exitStatus = stopped ? '' : result.status;
  api.state.output = api.state.verbose ? shownOutput(api, raw, '') : reduced;
  api.state.stopping = false;
  stopRun(api);
  try {
    writeLog(api.ui.top, entry.name, reduced);
  } catch (error) {
    api.ui.status = error.message;
    api.ui.paint();
    return;
  }
  if (stopped && api.state.viewing) api.ui.status = 'terminated';
  api.ui.paint();
};

const startRun = (api, entry) => {
  api.state.output = '';
  api.state.raw = '';
  api.state.exitStatus = '';
  api.state.viewing = true;
  api.state.followEnd = true;
  api.state.logScroll = 0;
  api.state.running = true;
  api.state.stopping = false;
  api.ui.status = '';
  api.ui.progress.start('npm');
  const runner = api.ui.repo && api.ui.repo.runNpmCommand;
  const start = typeof runner === 'function' ? runner : startNpm;
  const child = start(
    api.ui.top,
    entry,
    (text) => showOutput(api, text),
    (result) => finishRun(api, entry, result),
  );
  if (api.state.running) api.state.child = child;
  api.ui.paint();
};

const runSelected = (api) => {
  if (api.state.viewing || api.state.child) return;
  const entry = selected(api);
  if (!entry) return;
  api.state.verbose = false;
  startRun(api, entry);
};

const rerun = (api) => {
  if (!api.state.viewing || api.state.running) return;
  const entry = selected(api);
  if (!entry) return;
  startRun(api, entry);
};

const closeView = (api) => {
  if (api.state.running) {
    api.state.stopping = true;
    if (api.state.child) api.state.child.kill();
    if (!api.state.running) return;
    api.state.raw = withNotice(api.state.raw, 'terminated');
    api.state.output = api.state.verbose
      ? shownOutput(api, api.state.raw, '')
      : withNotice(api.state.output, 'terminated');
    stopRun(api);
    api.ui.status = 'terminated';
    api.ui.paint();
    return;
  }
  api.state.viewing = false;
  api.state.verbose = false;
  api.ui.status = '';
  api.ui.paint();
};

const toggleVerbose = (api) => {
  if (!api.state.viewing) return;
  api.state.verbose = !api.state.verbose;
  const status = api.state.running ? '' : api.state.exitStatus;
  api.state.output = shownOutput(api, api.state.raw, status);
  api.ui.status = api.state.verbose ? 'verbose' : 'filtered';
  api.ui.paint();
};

const editable = (api) => {
  if (api.state.viewing) return false;
  if (canEdit(api.ui)) return true;
  api.ui.status = 'read only';
  return false;
};

const selectedScript = (api) => {
  if (!editable(api)) return null;
  const entry = selected(api);
  if (entry && entry.kind === 'script') return entry;
  api.ui.status = 'not a script';
  return null;
};

const focusScript = (api, name) => {
  const at = api.state.commands.findIndex((entry) => entry.name === name);
  if (at >= 0) api.ui.nav.npmCursor = at;
};

const editSelected = (api) => {
  const entry = selectedScript(api);
  if (!entry) return;
  api.state.editName = entry.name;
  api.state.editField = 'name';
  api.state.draftName = entry.name;
  api.state.draftCommand = entry.command ?? '';
  api.ui.composer.openCompose('npm', entry.name);
};

const newCommand = (api) => {
  if (!editable(api)) return;
  api.state.editName = '';
  api.state.editField = 'name';
  api.state.draftName = '';
  api.state.draftCommand = '';
  api.ui.composer.openCompose('npm', '');
};

const switchField = (api, editor, field, text) => {
  api.state.editField = field;
  editor.replace(text);
  api.ui.status = '';
  api.ui.composer.resetBlink();
};

const finishName = (api, editor) => {
  const name = editor.text.trim();
  if (!name || !NAME_RE.test(name)) {
    api.ui.status = 'name';
    return false;
  }
  api.state.draftName = name;
  switchField(api, editor, 'command', api.state.draftCommand);
  return true;
};

const focusField = (api, field) => {
  const editor = api.ui.editor;
  if (!editor) return false;
  if (field === api.state.editField) return true;
  if (field === 'command') return finishName(api, editor);
  api.state.draftCommand = editor.text;
  switchField(api, editor, 'name', api.state.draftName ?? '');
  return true;
};

const finishEdit = (api) => {
  const editor = api.ui.composer.state.editor;
  if (!editor) return;
  if (api.state.editField !== 'command') return void finishName(api, editor);
  const command = editor.text.trim();
  if (!command) {
    api.ui.status = 'command';
    return;
  }
  const parsed = { name: api.state.draftName, command };
  try {
    api.ui.ignoreWatch();
    saveScript(api.ui.top, api.state.editName, parsed);
  } catch (error) {
    api.ui.status = error.message;
    return;
  }
  api.state.editField = '';
  api.ui.composer.closeCompose();
  refresh(api);
  focusScript(api, parsed.name);
  api.ui.status = 'saved';
};

const askDrop = (api) => {
  const entry = selectedScript(api);
  if (!entry) return;
  api.state.dropKind = 'script';
  api.state.dropName = entry.name;
  api.ui.mode = 'confirmDrop';
  api.ui.status = '';
};

const askLogs = (api) => {
  if (!editable(api)) return;
  refreshLogs(api);
  if (!api.state.logBytes) return;
  api.state.dropKind = 'logs';
  const size = formatSize(api.state.logBytes);
  api.state.dropName = `logs older than 5 days (${size})`;
  api.ui.mode = 'confirmDrop';
  api.ui.status = '';
};

const confirmDrop = (api) => {
  const kind = api.state.dropKind;
  const name = api.state.dropName;
  api.state.dropName = '';
  api.state.dropKind = '';
  api.ui.mode = 'review';
  if (kind === 'logs') {
    try {
      removeStaleLogs(api.ui.top);
    } catch (error) {
      api.ui.status = error.message;
      refreshLogs(api);
      return;
    }
    refreshLogs(api);
    api.ui.status = 'dropped logs';
    return;
  }
  if (!name) return;
  try {
    api.ui.ignoreWatch();
    removeScript(api.ui.top, name);
  } catch (error) {
    api.ui.status = error.message;
    return;
  }
  refresh(api);
  api.ui.status = `dropped ${name}`;
};

const cancelDrop = (api) => {
  api.state.dropName = '';
  api.state.dropKind = '';
  api.ui.mode = 'review';
  api.ui.status = '';
};

const reorder = (api, delta) => {
  const entry = selectedScript(api);
  if (!entry) return;
  try {
    api.ui.ignoreWatch();
    if (!reorderScript(api.ui.top, entry.name, delta)) return;
  } catch (error) {
    api.ui.status = error.message;
    return;
  }
  refresh(api);
  focusScript(api, entry.name);
  api.ui.status = '';
};

const npmState = () => ({
  commands: [],
  viewing: false,
  output: '',
  followEnd: true,
  logScroll: 0,
  editName: '',
  editField: '',
  draftName: '',
  draftCommand: '',
  verbose: false,
  raw: '',
  exitStatus: '',
  dropName: '',
  dropKind: '',
  logBytes: 0,
  running: false,
  stopping: false,
  child: null,
});

const createNpmController = (ui) => {
  const state = npmState();
  const api = { ui, state };
  return {
    state,
    get commands() {
      return state.commands;
    },
    get viewing() {
      return state.viewing;
    },
    get output() {
      return state.output;
    },
    get dropName() {
      return state.dropName;
    },
    get logLabel() {
      if (!state.logBytes) return '';
      return `old logs ${formatSize(state.logBytes)}`;
    },
    get followEnd() {
      return state.followEnd;
    },
    get logScroll() {
      return state.logScroll;
    },
    get editName() {
      return state.editName;
    },
    get editField() {
      return state.editField;
    },
    get draftName() {
      return state.draftName;
    },
    get draftCommand() {
      return state.draftCommand;
    },
    get verbose() {
      return state.verbose;
    },
    get running() {
      return state.running;
    },
    reset() {
      if (state.child) state.child.kill();
      stopRun(api);
      state.commands = [];
      state.viewing = false;
      state.output = '';
      state.followEnd = true;
      state.logScroll = 0;
      state.editName = '';
      state.editField = '';
      state.draftName = '';
      state.draftCommand = '';
      state.verbose = false;
      state.raw = '';
      state.exitStatus = '';
      state.dropName = '';
      state.dropKind = '';
      state.logBytes = 0;
      state.stopping = false;
    },
    open: () => open(api),
    move: (delta) => move(api, delta),
    run: () => runSelected(api),
    rerun: () => rerun(api),
    closeView: () => closeView(api),
    toggleVerbose: () => toggleVerbose(api),
    edit: () => editSelected(api),
    create: () => newCommand(api),
    finishEdit: () => finishEdit(api),
    focusField: (field) => focusField(api, field),
    askDrop: () => askDrop(api),
    askLogs: () => askLogs(api),
    confirmDrop: () => confirmDrop(api),
    cancelDrop: () => cancelDrop(api),
    reorder: (delta) => reorder(api, delta),
  };
};

module.exports = { createNpmController };
