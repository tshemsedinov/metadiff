'use strict';

const commands = require('../npm-commands.js');
const { logViewRows } = require('../render/npm.js');

const { listCommands, reduceOutput, writeLog, parseScriptLine } = commands;
const { scriptLine, saveScript, removeScript, reorderScript } = commands;
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

const open = (api) => {
  if (api.ui.mode === 'compose') return;
  refresh(api);
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
  if (api.ui.progress) api.ui.progress.stop('npm');
};

const showOutput = (api, text) => {
  if (!api.state.viewing || !api.state.running) return;
  if (api.state.stopping) return;
  api.state.output = text;
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
  const reduced = stopped
    ? withNotice(api.state.output, 'terminated')
    : reduceOutput(result.text, api.ui.top, result.status);
  api.state.output = reduced;
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
  api.state.viewing = true;
  api.state.followEnd = true;
  api.state.logScroll = 0;
  api.state.running = true;
  api.state.stopping = false;
  api.ui.status = '';
  if (api.ui.progress) api.ui.progress.start('npm');
  const runner = api.ui.repo && api.ui.repo.runNpmCommand;
  const start = typeof runner === 'function' ? runner : startNpm;
  api.state.child = start(
    api.ui.top,
    entry,
    (text) => showOutput(api, reduceOutput(text, api.ui.top, '')),
    (result) => finishRun(api, entry, result),
  );
  api.ui.paint();
};

const runSelected = (api) => {
  if (api.state.viewing || api.state.child) return;
  const entry = selected(api);
  if (!entry) return;
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
    api.state.output = withNotice(api.state.output, 'terminated');
    stopRun(api);
    api.ui.status = 'terminated';
    api.ui.paint();
    return;
  }
  api.state.viewing = false;
  api.ui.status = '';
  api.ui.paint();
};

const editSelected = (api) => {
  if (api.state.viewing) return;
  if (!canEdit(api.ui)) {
    api.ui.status = 'read only';
    return;
  }
  const entry = selected(api);
  if (!entry || entry.kind !== 'script') {
    api.ui.status = 'not a script';
    return;
  }
  api.state.editName = entry.name;
  api.ui.composer.openCompose('npm', scriptLine(entry));
};

const newCommand = (api) => {
  if (api.state.viewing) return;
  if (!canEdit(api.ui)) {
    api.ui.status = 'read only';
    return;
  }
  api.state.editName = '';
  api.ui.composer.openCompose('npm', '');
};

const finishEdit = (api) => {
  const editor = api.ui.composer.state.editor;
  const text = editor ? editor.text : '';
  const parsed = parseScriptLine(text);
  if (!parsed) {
    api.ui.status = 'name: command';
    return;
  }
  try {
    api.ui.ignoreWatch();
    saveScript(api.ui.top, api.state.editName, parsed);
  } catch (error) {
    api.ui.status = error.message;
    return;
  }
  api.ui.composer.closeCompose();
  refresh(api);
  const at = api.state.commands.findIndex(
    (entry) => entry.name === parsed.name,
  );
  if (at >= 0) api.ui.nav.npmCursor = at;
  api.ui.status = 'saved';
};

const askDrop = (api) => {
  if (api.state.viewing) return;
  if (!canEdit(api.ui)) {
    api.ui.status = 'read only';
    return;
  }
  const entry = selected(api);
  if (!entry || entry.kind !== 'script') {
    api.ui.status = 'not a script';
    return;
  }
  api.state.dropName = entry.name;
  api.ui.mode = 'confirmDrop';
  api.ui.status = '';
};

const confirmDrop = (api) => {
  const name = api.state.dropName;
  api.state.dropName = '';
  api.ui.mode = 'review';
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
  api.ui.mode = 'review';
  api.ui.status = '';
};

const reorder = (api, delta) => {
  if (api.state.viewing) return;
  if (!canEdit(api.ui)) {
    api.ui.status = 'read only';
    return;
  }
  const entry = selected(api);
  if (!entry || entry.kind !== 'script') {
    api.ui.status = 'not a script';
    return;
  }
  try {
    api.ui.ignoreWatch();
    if (!reorderScript(api.ui.top, entry.name, delta)) return;
  } catch (error) {
    api.ui.status = error.message;
    return;
  }
  refresh(api);
  const at = api.state.commands.findIndex((item) => item.name === entry.name);
  if (at >= 0) api.ui.nav.npmCursor = at;
  api.ui.status = '';
};

const createNpmController = (ui) => {
  const state = {
    commands: [],
    viewing: false,
    output: '',
    followEnd: true,
    logScroll: 0,
    editName: '',
    dropName: '',
    running: false,
    stopping: false,
    child: null,
  };
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
    get followEnd() {
      return state.followEnd;
    },
    get logScroll() {
      return state.logScroll;
    },
    get editName() {
      return state.editName;
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
      state.dropName = '';
      state.stopping = false;
    },
    open: () => open(api),
    move: (delta) => move(api, delta),
    run: () => runSelected(api),
    rerun: () => rerun(api),
    closeView: () => closeView(api),
    edit: () => editSelected(api),
    create: () => newCommand(api),
    finishEdit: () => finishEdit(api),
    askDrop: () => askDrop(api),
    confirmDrop: () => confirmDrop(api),
    cancelDrop: () => cancelDrop(api),
    reorder: (delta) => reorder(api, delta),
  };
};

module.exports = { createNpmController };
