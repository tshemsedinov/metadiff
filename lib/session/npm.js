'use strict';

const { bytesToSize } = require('metautil');
const commands = require('../npm-commands.js');
const { logViewRows, expandLogLines } = require('../render/npm.js');
const { stripAnsi } = require('../ansi.js');
const { buildDocument } = require('../report-parse.js');
const { renderDocument, loggedText } = require('../report-render.js');
const { renderReport } = require('../render/report.js');

const { listCommands, reduceOutput, nextLogFile, saveLogs } = commands;
const { staleLogFiles, removeStaleLogs, startNpm } = commands;
const { saveScript, removeScript, reorderScript } = commands;

const NAME_RE = /^[\w:.-]+$/;
const TESTS_RE = /^(?:TAP version \d+|\s*(?:not )?ok\b|[ℹi]\s+tests\s+\d+)/m;

const logRowCount = (text, width, running) => {
  const visual = width > 0 ? expandLogLines(text, width).length : 0;
  const extra = running ? 1 : 0;
  if (visual) return visual + extra;
  const lines = `${text ?? ''}`.split('\n');
  const count = lines.at(-1) === '' ? lines.length - 1 : lines.length;
  return count + extra;
};

const filteredOutput = (raw, root, status, rawFile) => {
  const text = stripAnsi(`${raw ?? ''}`);
  if (status === '' || !TESTS_RE.test(text)) {
    const output = reduceOutput(raw, root, status);
    return { output, log: output };
  }
  const doc = buildDocument(raw, '', root, status, 'test');
  return { output: renderReport(doc), log: renderDocument(doc, rawFile) };
};

const runLabel = (entry) =>
  entry.kind === 'bin' ? `npm exec ${entry.name}` : `npm run ${entry.name}`;

const withNotice = (text, notice) => {
  const body = `${text ?? ''}`;
  if (body.endsWith(`${notice}\n`)) return body;
  if (!body) return `${notice}\n`;
  if (body.endsWith('\n')) return `${body}${notice}\n`;
  return `${body}\n${notice}\n`;
};

const withNewline = (text) => {
  const body = `${text ?? ''}`;
  if (!body || body.endsWith('\n')) return body;
  return `${body}\n`;
};

const runStatusText = (run) => {
  if (run.status === 'running') return 'running';
  if (run.status === 'stopped') return 'stopped';
  return `exit ${run.exit}`;
};

const elapsedText = (run, now) => {
  const end = run.endedAt || now;
  const ms = Math.max(0, end - (run.startedAt || end));
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  return `${min}m${String(rest).padStart(2, '0')}s`;
};

class NpmController {
  constructor(ui) {
    this.ui = ui;
    this.reset();
  }

  reset() {
    for (const run of this.runs ?? []) {
      if (run.status === 'running' && run.child) run.child.kill();
    }
    this.runs = [];
    this.nextId = 1;
    this.viewId = 0;
    this.focus = 'commands';
    this.runCursor = 0;
    this.runScroll = 0;
    this.commands = [];
    this.viewing = false;
    this.verbose = false;
    this.editName = '';
    this.editField = '';
    this.draftName = '';
    this.draftCommand = '';
    this.dropName = '';
    this.dropKind = '';
    this.logBytes = 0;
    this.ui.progress.stop('npm');
  }

  get logLabel() {
    if (!this.logBytes) return '';
    return `old logs ${bytesToSize(this.logBytes)}`;
  }

  get running() {
    return this.runs.some((run) => run.status === 'running');
  }

  get output() {
    const run = this.viewedRun();
    if (!run) return '';
    if (this.verbose) return withNewline(run.raw);
    return run.output ?? '';
  }

  get followEnd() {
    const run = this.viewedRun();
    if (!run) return true;
    return run.followEnd !== false;
  }

  set followEnd(value) {
    const run = this.viewedRun();
    if (run) run.followEnd = value;
  }

  get logScroll() {
    return this.viewedRun()?.logScroll ?? 0;
  }

  set logScroll(value) {
    const run = this.viewedRun();
    if (run) run.logScroll = value;
  }

  get lastRun() {
    const live = this.runs.find((run) => run.status === 'running');
    const run = live || this.runs.at(-1);
    if (!run) return null;
    return {
      label: run.label,
      running: run.status === 'running',
      exit: run.exit,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
    };
  }

  viewedRun() {
    return this.runs.find((run) => run.id === this.viewId) || null;
  }

  viewedRunning() {
    if (!this.viewing) return this.running;
    const run = this.viewedRun();
    return Boolean(run && run.status === 'running');
  }

  commandRuns() {
    const entry = this.selected();
    if (!entry) return [];
    return this.runs.filter(
      (run) => run.name === entry.name && run.kind === entry.kind,
    );
  }

  sessionRows() {
    const now = Date.now();
    return this.commandRuns().map((run) => ({
      id: run.id,
      status: runStatusText(run),
      elapsed: elapsedText(run, now),
    }));
  }

  clampRuns() {
    const last = Math.max(0, this.commandRuns().length - 1);
    this.runCursor = Math.max(0, Math.min(this.runCursor, last));
  }

  focusRun(run) {
    const at = this.commands.findIndex(
      (entry) => entry.name === run.name && entry.kind === run.kind,
    );
    if (at >= 0) this.ui.nav.npmCursor = at;
    const index = this.commandRuns().findIndex((item) => item.id === run.id);
    if (index >= 0) this.runCursor = index;
  }

  selected() {
    return this.commands[this.ui.nav.npmCursor];
  }

  refresh() {
    this.commands = listCommands(this.ui.top);
    const last = this.commands.length - 1;
    const nav = this.ui.nav;
    nav.npmCursor = Math.max(0, Math.min(nav.npmCursor, last));
  }

  refreshLogs() {
    try {
      this.logBytes = staleLogFiles(this.ui.top).bytes;
    } catch (error) {
      this.logBytes = 0;
      this.ui.status = error.message;
    }
  }

  open() {
    if (this.ui.mode === 'compose') return;
    this.refresh();
    this.refreshLogs();
    this.viewing = false;
    this.verbose = false;
    const nav = this.ui.nav;
    nav.pane = 'npm';
    nav.resetListScroll('npm');
    this.ui.status = '';
    nav.clearSelection();
  }

  syncProgress() {
    if (this.running) this.ui.progress.start('npm');
    else this.ui.progress.stop('npm');
  }

  scrollLog(delta) {
    const { lastFrame, lastSize } = this.ui;
    const width = lastSize && lastSize.width ? lastSize.width : 0;
    const live = this.viewedRunning();
    const count = logRowCount(this.output, width, live);
    const bodyH = lastFrame && lastFrame.bodyH ? lastFrame.bodyH : 1;
    const max = Math.max(0, count - logViewRows(bodyH));
    const from = this.followEnd ? max : this.logScroll;
    const start = Math.min(max, Math.max(0, from + delta));
    this.followEnd = start === max;
    this.logScroll = start;
  }

  moveRun(delta) {
    const rows = this.commandRuns();
    if (!rows.length) return;
    const last = rows.length - 1;
    const next = Math.min(last, Math.max(0, this.runCursor + delta));
    if (next === this.runCursor) return;
    this.runCursor = next;
    this.ui.status = '';
    this.ui.paint();
  }

  move(delta) {
    if (this.viewing) return void this.scrollLog(delta);
    if (this.focus === 'runs') return void this.moveRun(delta);
    if (!this.commands.length) return;
    const nav = this.ui.nav;
    const last = this.commands.length - 1;
    const next = Math.min(last, Math.max(0, nav.npmCursor + delta));
    if (next === nav.npmCursor) return;
    nav.npmCursor = next;
    this.clampRuns();
    this.ui.status = '';
  }

  focusCommands() {
    if (this.focus === 'commands') return;
    this.focus = 'commands';
    this.ui.paint();
  }

  focusRuns() {
    if (this.focus === 'runs') return;
    this.focus = 'runs';
    this.clampRuns();
    this.ui.paint();
  }

  toggleFocus() {
    if (this.focus === 'runs') this.focusCommands();
    else this.focusRuns();
  }

  showOutput(run, text) {
    if (run.status !== 'running' || run.stopping) return;
    run.raw = text;
    run.output = filteredOutput(text, this.ui.top, '').output;
    const pane = this.ui.nav.pane;
    if (pane === 'npm' || pane === 'dashboard') this.ui.paint();
  }

  async finishRun(run, entry, result) {
    const ui = this.ui;
    const stopped = run.stopping === true;
    const raw = stopped ? withNotice(run.raw, 'terminated') : result.text;
    let slot = null;
    try {
      slot = nextLogFile(ui.top, entry.name);
    } catch (error) {
      ui.status = error.message;
    }
    const rawFile = slot ? slot.rawName : '';
    const stoppedOutput = () => {
      const output = withNotice(
        reduceOutput(run.raw, ui.top, ''),
        'terminated',
      );
      return { output, log: output };
    };
    const filtered = stopped
      ? stoppedOutput()
      : filteredOutput(result.text, ui.top, result.status, rawFile);
    run.raw = raw;
    run.exit = stopped ? '' : result.status;
    run.status = stopped ? 'stopped' : 'exited';
    run.output = filtered.output;
    run.endedAt = Date.now();
    run.child = null;
    run.stopping = false;
    const watched = this.viewing && this.viewId === run.id;
    if (stopped && watched) ui.status = 'terminated';
    this.syncProgress();
    ui.paint();
    if (!slot) return;
    try {
      await saveLogs(slot, loggedText(filtered.log, slot.rawName), raw);
    } catch (error) {
      ui.status = error.message;
      ui.paint();
    }
  }

  startRun(entry) {
    const ui = this.ui;
    const run = {
      id: this.nextId,
      name: entry.name,
      kind: entry.kind,
      command: entry.command ?? '',
      label: runLabel(entry),
      status: 'running',
      exit: '',
      raw: '',
      output: '',
      child: null,
      startedAt: Date.now(),
      endedAt: 0,
      stopping: false,
      followEnd: true,
      logScroll: 0,
    };
    this.nextId += 1;
    this.runs.push(run);
    this.viewing = true;
    this.viewId = run.id;
    this.focusRun(run);
    ui.status = '';
    this.syncProgress();
    const start = (ui.repo && ui.repo.runNpmCommand) || startNpm;
    const child = start(
      ui.top,
      entry,
      (text) => this.showOutput(run, text),
      (result) => this.finishRun(run, entry, result),
    );
    if (run.status === 'running') run.child = child;
    ui.paint();
    return child;
  }

  openView(id) {
    const run = this.runs.find((item) => item.id === id);
    if (!run) return;
    this.verbose = false;
    this.viewing = true;
    this.viewId = id;
    this.ui.status = '';
    this.ui.paint();
  }

  run() {
    if (this.viewing) return null;
    if (this.focus === 'runs') {
      const picked = this.commandRuns()[this.runCursor];
      if (picked) {
        this.openView(picked.id);
        return null;
      }
    }
    const entry = this.selected();
    if (!entry) return null;
    this.verbose = false;
    return this.startRun(entry);
  }

  rerun() {
    if (!this.viewing) return;
    const current = this.viewedRun();
    const entry = current
      ? {
          name: current.name,
          kind: current.kind,
          command: current.command,
        }
      : this.selected();
    if (entry && entry.name) this.startRun(entry);
  }

  closeView() {
    this.viewing = false;
    this.verbose = false;
    this.ui.status = '';
    this.ui.paint();
  }

  stop(run = this.viewedRun()) {
    if (!run || run.status !== 'running') return;
    run.stopping = true;
    if (run.child) run.child.kill();
    if (run.status !== 'running') {
      this.syncProgress();
      return;
    }
    run.raw = withNotice(run.raw, 'terminated');
    run.output = withNotice(run.output, 'terminated');
    run.status = 'stopped';
    run.exit = '';
    run.endedAt = Date.now();
    run.child = null;
    const watched = this.viewing && this.viewId === run.id;
    if (watched) this.ui.status = 'terminated';
    this.syncProgress();
    this.ui.paint();
  }

  stopAll() {
    for (const run of this.runs) this.stop(run);
  }

  toggleVerbose() {
    if (!this.viewing || !this.viewedRun()) return;
    this.verbose = !this.verbose;
    this.ui.status = this.verbose ? 'verbose' : 'filtered';
    this.ui.paint();
  }

  editable() {
    if (this.viewing) return false;
    const ui = this.ui;
    const caps = ui.capabilities;
    if (!ui.readOnly && (!caps || caps.changes !== false)) return true;
    ui.status = 'read only';
    return false;
  }

  selectedScript() {
    if (!this.editable()) return null;
    const entry = this.selected();
    if (entry && entry.kind === 'script') return entry;
    this.ui.status = 'not a script';
    return null;
  }

  focusScript(name) {
    const at = this.commands.findIndex((entry) => entry.name === name);
    if (at >= 0) this.ui.nav.npmCursor = at;
  }

  startEdit(name, command) {
    this.editName = name;
    this.editField = 'name';
    this.draftName = name;
    this.draftCommand = command;
    this.ui.composer.openCompose('npm', name);
  }

  edit() {
    const entry = this.selectedScript();
    if (entry) this.startEdit(entry.name, entry.command ?? '');
  }

  create() {
    if (this.editable()) this.startEdit('', '');
  }

  switchField(editor, field, text) {
    this.editField = field;
    editor.replace(text);
    this.ui.status = '';
  }

  finishName(editor) {
    const name = editor.text.trim();
    if (!name || !NAME_RE.test(name)) {
      this.ui.status = 'name';
      return false;
    }
    this.draftName = name;
    this.switchField(editor, 'command', this.draftCommand);
    return true;
  }

  focusField(field) {
    const editor = this.ui.editor;
    if (!editor) return false;
    if (field === this.editField) return true;
    if (field === 'command') return this.finishName(editor);
    this.draftCommand = editor.text;
    this.switchField(editor, 'name', this.draftName);
    return true;
  }

  writeScripts(write) {
    try {
      this.ui.ignoreWatch();
      write(this.ui.top);
      return true;
    } catch (error) {
      this.ui.status = error.message;
      return false;
    }
  }

  finishEdit() {
    const ui = this.ui;
    const editor = ui.composer.editor;
    if (!editor) return;
    if (this.editField !== 'command') return void this.finishName(editor);
    const command = editor.text.trim();
    if (!command) {
      ui.status = 'command';
      return;
    }
    const parsed = { name: this.draftName, command };
    const write = (top) => saveScript(top, this.editName, parsed);
    if (!this.writeScripts(write)) return;
    this.editField = '';
    ui.composer.closeCompose();
    this.refresh();
    this.focusScript(parsed.name);
    ui.status = 'saved';
  }

  confirm(kind, name) {
    this.dropKind = kind;
    this.dropName = name;
    this.ui.mode = 'confirmDrop';
    this.ui.status = '';
  }

  askDrop() {
    const entry = this.selectedScript();
    if (entry) this.confirm('script', entry.name);
  }

  askLogs() {
    if (!this.editable()) return;
    this.refreshLogs();
    if (!this.logBytes) return;
    const size = bytesToSize(this.logBytes);
    this.confirm('logs', `logs older than 5 days (${size})`);
  }

  cancelDrop() {
    this.dropName = '';
    this.dropKind = '';
    this.ui.mode = 'review';
    this.ui.status = '';
  }

  confirmDrop() {
    const ui = this.ui;
    const kind = this.dropKind;
    const name = this.dropName;
    this.dropName = '';
    this.dropKind = '';
    ui.mode = 'review';
    if (kind === 'logs') {
      try {
        removeStaleLogs(ui.top);
      } catch (error) {
        ui.status = error.message;
        return void this.refreshLogs();
      }
      this.refreshLogs();
      ui.status = 'dropped logs';
      return;
    }
    if (!name) return;
    if (!this.writeScripts((top) => removeScript(top, name))) return;
    this.refresh();
    ui.status = `dropped ${name}`;
  }

  reorder(delta) {
    const entry = this.selectedScript();
    if (!entry) return;
    let moved = false;
    const write = (top) => {
      moved = reorderScript(top, entry.name, delta);
    };
    if (!this.writeScripts(write) || !moved) return;
    this.refresh();
    this.focusScript(entry.name);
    this.ui.status = '';
  }
}

module.exports = { NpmController };
