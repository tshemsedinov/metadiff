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

class NpmController {
  constructor(ui) {
    this.ui = ui;
    this.child = null;
    this.running = false;
    this.reset();
  }

  reset() {
    if (this.child) this.child.kill();
    this.stopRun();
    this.commands = [];
    this.viewing = false;
    this.output = '';
    this.followEnd = true;
    this.logScroll = 0;
    this.editName = '';
    this.editField = '';
    this.draftName = '';
    this.draftCommand = '';
    this.verbose = false;
    this.raw = '';
    this.exitStatus = '';
    this.dropName = '';
    this.dropKind = '';
    this.logBytes = 0;
    this.stopping = false;
    this.runLabel = '';
    this.startedAt = 0;
    this.endedAt = 0;
  }

  get logLabel() {
    if (!this.logBytes) return '';
    return `old logs ${bytesToSize(this.logBytes)}`;
  }

  get lastRun() {
    if (!this.startedAt) return null;
    return {
      label: this.runLabel,
      running: this.running,
      exit: this.exitStatus,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
    };
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
    this.output = '';
    const nav = this.ui.nav;
    nav.pane = 'npm';
    nav.resetListScroll('npm');
    this.ui.status = '';
    nav.clearSelection();
  }

  scrollLog(delta) {
    const { lastFrame, lastSize } = this.ui;
    const width = lastSize && lastSize.width ? lastSize.width : 0;
    const count = logRowCount(this.output, width, this.running);
    const bodyH = lastFrame && lastFrame.bodyH ? lastFrame.bodyH : 1;
    const max = Math.max(0, count - logViewRows(bodyH));
    const from = this.followEnd ? max : this.logScroll;
    const start = Math.min(max, Math.max(0, from + delta));
    this.followEnd = start === max;
    this.logScroll = start;
  }

  move(delta) {
    if (this.viewing) return void this.scrollLog(delta);
    if (!this.commands.length) return;
    const nav = this.ui.nav;
    const last = this.commands.length - 1;
    const next = Math.min(last, Math.max(0, nav.npmCursor + delta));
    if (next === nav.npmCursor) return;
    nav.npmCursor = next;
    this.ui.status = '';
  }

  stopRun() {
    if (this.running) this.endedAt = Date.now();
    this.running = false;
    this.child = null;
    this.ui.progress.stop('npm');
  }

  shownOutput(raw, status) {
    if (this.verbose) return withNewline(raw);
    return filteredOutput(raw, this.ui.top, status).output;
  }

  showOutput(text) {
    if (!this.viewing || !this.running || this.stopping) return;
    this.raw = text;
    this.output = this.shownOutput(text, '');
    this.ui.paint();
  }

  async finishRun(entry, result) {
    const ui = this.ui;
    const stopped = this.stopping === true;
    const raw = stopped ? withNotice(this.raw, 'terminated') : result.text;
    let slot = null;
    try {
      slot = nextLogFile(ui.top, entry.name);
    } catch (error) {
      ui.status = error.message;
    }
    const rawFile = slot ? slot.rawName : '';
    const stoppedOutput = () => {
      const output = withNotice(
        reduceOutput(this.raw, ui.top, ''),
        'terminated',
      );
      return { output, log: output };
    };
    const filtered = stopped
      ? stoppedOutput()
      : filteredOutput(result.text, ui.top, result.status, rawFile);
    this.raw = raw;
    this.exitStatus = stopped ? '' : result.status;
    this.output = this.verbose ? this.shownOutput(raw, '') : filtered.output;
    this.stopping = false;
    this.stopRun();
    if (stopped && this.viewing) ui.status = 'terminated';
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
    this.output = '';
    this.raw = '';
    this.exitStatus = '';
    this.viewing = true;
    this.followEnd = true;
    this.logScroll = 0;
    this.running = true;
    this.stopping = false;
    this.runLabel = runLabel(entry);
    this.startedAt = Date.now();
    this.endedAt = 0;
    ui.status = '';
    ui.progress.start('npm');
    const start = (ui.repo && ui.repo.runNpmCommand) || startNpm;
    const child = start(
      ui.top,
      entry,
      (text) => this.showOutput(text),
      (result) => this.finishRun(entry, result),
    );
    if (this.running) this.child = child;
    ui.paint();
    return child;
  }

  run() {
    if (this.viewing || this.child) return null;
    const entry = this.selected();
    if (!entry) return null;
    this.verbose = false;
    return this.startRun(entry);
  }

  rerun() {
    if (!this.viewing || this.running) return;
    const entry = this.selected();
    if (entry) this.startRun(entry);
  }

  closeView() {
    const ui = this.ui;
    if (!this.running) {
      this.viewing = false;
      this.verbose = false;
      ui.status = '';
      return void ui.paint();
    }
    this.stopping = true;
    if (this.child) this.child.kill();
    if (!this.running) return;
    this.raw = withNotice(this.raw, 'terminated');
    this.output = this.verbose
      ? this.shownOutput(this.raw, '')
      : withNotice(this.output, 'terminated');
    this.stopRun();
    ui.status = 'terminated';
    ui.paint();
  }

  toggleVerbose() {
    if (!this.viewing) return;
    this.verbose = !this.verbose;
    const status = this.running ? '' : this.exitStatus;
    this.output = this.shownOutput(this.raw, status);
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
