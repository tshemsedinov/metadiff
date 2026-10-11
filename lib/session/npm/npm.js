'use strict';

const { withNotice, withNewline, clamp } = require('../../common/utilities.js');
const commands = require('../../runs/commands.js');
const { logScrollMax } = require('../../render/log.js');
const report = require('../../report/render.js');
const { loggedText } = report;
const runStore = require('../../runs/runs.js');
const { readRuns } = runStore;
const { foldSteps } = require('../../dashboard/model.js');
const {
  listCommands,
  saveScript,
  removeScript,
  reorderScript,
} = require('../../runs/scripts.js');
const { reduceOutput } = require('../../runs/output.js');
const {
  nextLogFile,
  saveLogs,
  readSavedRuns,
  readLogPair,
  staleLogFiles,
  removeStaleLogs,
} = require('../../runs/logs.js');
const { startNpm } = commands;
const historyPart = require('./history.js');
const { launchedReslop, RUN_KEEP, historyCounts, historyExit } = historyPart;
const { historyName, historyMark, countText, elapsedText } = historyPart;
const { whenLabel, runLabel, logBase, applyExternal } = historyPart;
const { recordedItem, sameWindow, noteTests, filteredOutput } = historyPart;
const { size } = require('../../common/format.js');

const NAME_RE = /^[\w:.-]+$/;

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
    return `old logs ${size(this.logBytes)}`;
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

  dashboardRuns() {
    return this.historyRuns().map((run) => ({
      name: run.name,
      kind: run.kind,
      command: run.command,
      label: run.label,
      running: run.status === 'running',
      exit: run.exit,
      startedAt: run.startedAt || 0,
      endedAt: run.endedAt || 0,
      progress: run.progress,
      result: run.result,
    }));
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

  historyRuns() {
    const runs = this.runs.filter((run) => !launchedReslop(run));
    return foldSteps(runs).slice(0, RUN_KEEP);
  }

  sessionRows() {
    const now = Date.now();
    return this.historyRuns().map((run) => {
      const counts = historyCounts(run);
      const exitText = historyExit(run, counts);
      return {
        id: run.id,
        name: historyName(run),
        live: run.status === 'running',
        mark: historyMark(run),
        done: countText(counts?.done),
        ok: countText(counts?.ok),
        fail: countText(counts?.fail),
        total: counts ? countText(counts.total) : exitText,
        exitLabel: exitText !== '',
        okN: counts ? counts.ok : null,
        failN: counts ? counts.fail : null,
        elapsed: elapsedText(run, now),
        when: whenLabel(run.startedAt || run.endedAt || 0),
      };
    });
  }

  clampRuns() {
    const last = Math.max(0, this.historyRuns().length - 1);
    this.runCursor = clamp(this.runCursor, 0, last);
  }

  focusRun(run) {
    const at = this.commands.findIndex(
      (entry) => entry.name === run.name && entry.kind === run.kind,
    );
    if (at >= 0) this.ui.nav.npmCursor = at;
    const index = this.historyRuns().findIndex((item) => item.id === run.id);
    if (index >= 0) this.runCursor = index;
  }

  selected() {
    return this.commands[this.ui.nav.npmCursor];
  }

  refresh() {
    this.commands = listCommands(this.ui.top);
    const last = this.commands.length - 1;
    const nav = this.ui.nav;
    nav.npmCursor = clamp(nav.npmCursor, 0, last);
  }

  refreshLogs() {
    try {
      this.logBytes = staleLogFiles(this.ui.top).bytes;
    } catch (error) {
      this.logBytes = 0;
      this.ui.status = error.message;
    }
  }

  adopt(item) {
    const run = {
      id: this.nextId,
      name: item.name,
      kind: item.kind,
      command: item.command ?? '',
      label: item.kind === 'command' ? historyName(item) : runLabel(item),
      status: item.status,
      exit: item.exit,
      raw: '',
      output: '',
      child: null,
      startedAt: item.startedAt,
      endedAt: item.endedAt,
      stopping: false,
      followEnd: true,
      logScroll: 0,
      logName: item.logName,
      rawName: item.rawName,
      externalId: item.externalId || '',
      result: item.result ?? null,
      progress: item.progress ?? null,
      saved: true,
      hydrated: false,
    };
    this.nextId += 1;
    return run;
  }

  knownLogs() {
    const known = new Set();
    for (const run of this.runs) {
      if (run.logName) known.add(run.logName);
      if (run.externalId) known.add(run.externalId);
    }
    return known;
  }

  findRecorded(key, logName) {
    return this.runs.find((run) => {
      if (key && run.externalId === key) return true;
      return Boolean(logName && run.externalId && run.logName === logName);
    });
  }

  absorbRecorded(recorded, known, added) {
    let changed = false;
    for (const record of recorded) {
      const logName = logBase(record.log);
      const key = `${record.id ?? ''}`;
      const found = this.findRecorded(key, logName);
      if (found) {
        if (applyExternal(found, record)) changed = true;
        continue;
      }
      const seenLog = logName && known.has(logName);
      const seenKey = key && known.has(key);
      if (seenLog || seenKey) continue;
      if (logName) known.add(logName);
      if (key) known.add(key);
      added.push(this.adopt(recordedItem(record)));
      changed = true;
    }
    return changed;
  }

  storeAdded(added) {
    if (!added.length) return;
    const running = this.runs.filter((run) => run.status === 'running');
    const done = this.runs.filter((run) => run.status !== 'running');
    done.push(...added);
    done.sort((left, right) => {
      const at = left.startedAt - right.startedAt;
      if (at) return at;
      return left.id - right.id;
    });
    this.runs = [...done, ...running];
  }

  followExternal() {
    this.syncProgress();
    if (this.ui.nav.pane === 'npm') this.ui.paint();
  }

  refreshRecorded() {
    let recorded;
    try {
      recorded = readRuns(this.ui.top);
    } catch {
      return;
    }
    const added = [];
    let changed = this.absorbRecorded(recorded, this.knownLogs(), added);
    if (this.hydrate(this.viewedRun())) changed = true;
    this.storeAdded(added);
    if (changed) this.followExternal();
  }

  loadSaved() {
    const known = this.knownLogs();
    let saved;
    let recorded;
    try {
      saved = readSavedRuns(this.ui.top, this.commands);
      recorded = readRuns(this.ui.top);
    } catch (error) {
      this.ui.status = error.message;
      return;
    }
    const added = [];
    for (const item of saved) {
      if (!item.logName || known.has(item.logName)) continue;
      known.add(item.logName);
      added.push(this.adopt(item));
    }
    const changed = this.absorbRecorded(recorded, known, added);
    this.storeAdded(added);
    if (changed) this.followExternal();
  }

  siblingText(run) {
    const name = historyName(run);
    for (const other of this.runs) {
      if (other === run || historyName(other) !== name) continue;
      if (!sameWindow(run, other)) continue;
      const saved = readLogPair(this.ui.top, other.logName, other.rawName);
      const output = other.output || saved.output;
      const raw = other.raw || saved.raw;
      if (!output && !raw) continue;
      return { output, raw: raw || output };
    }
    return { output: '', raw: '' };
  }

  hydrate(run) {
    if (!run || !run.logName) return false;
    const settled = run.externalId && run.status !== 'running';
    if (!settled && (run.hydrated || run.output || run.raw)) return false;
    const text = readLogPair(this.ui.top, run.logName, run.rawName);
    const saved = text.output || text.raw ? text : this.siblingText(run);
    if (!saved.output && !saved.raw) return false;
    const raw = saved.raw || saved.output;
    if (run.output === saved.output && run.raw === raw) return false;
    run.output = saved.output;
    run.raw = raw;
    run.hydrated = true;
    return true;
  }

  open() {
    if (this.ui.mode === 'compose') return;
    this.refresh();
    this.refreshLogs();
    const fresh = this.runs.length === 0;
    this.loadSaved();
    if (fresh) {
      if (this.historyRuns().length) this.runCursor = 0;
    }
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

  placeLog(start) {
    const bar = this.ui.lastFrame && this.ui.lastFrame.scrollBar;
    if (!bar || !this.viewedRun()) return;
    const max = Math.max(0, bar.count - bar.rows);
    const next = clamp(start, 0, max);
    this.followEnd = next === max;
    this.logScroll = next;
  }

  placeRuns(start) {
    const bar = this.ui.lastFrame && this.ui.lastFrame.scrollBar;
    if (!bar) return;
    const max = Math.max(0, bar.count - bar.rows);
    const next = clamp(start, 0, max);
    this.runScroll = next;
    const last = Math.max(0, this.historyRuns().length - 1);
    if (this.runCursor < next) this.runCursor = next;
    const bottom = Math.min(last, next + bar.rows - 1);
    if (this.runCursor > bottom) this.runCursor = bottom;
  }

  scrollLog(delta) {
    const { lastFrame, lastSize } = this.ui;
    const live = this.viewedRunning();
    const max = logScrollMax(this.output, lastSize, lastFrame, live);
    const from = this.followEnd ? max : this.logScroll;
    const start = clamp(from + delta, 0, max);
    this.followEnd = start === max;
    this.logScroll = start;
  }

  moveRun(delta) {
    const rows = this.historyRuns();
    if (!rows.length) return;
    const last = rows.length - 1;
    const next = clamp(this.runCursor + delta, 0, last);
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
    const next = clamp(nav.npmCursor + delta, 0, last);
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
    noteTests(run, this.runs, text);
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
    if (filtered.result) run.result = filtered.result;
    run.endedAt = Date.now();
    run.child = null;
    run.stopping = false;
    const watched = this.viewing && this.viewId === run.id;
    if (stopped && watched) ui.status = 'terminated';
    this.syncProgress();
    ui.paint();
    if (launchedReslop(run)) return;
    if (!slot) return;
    run.logName = slot.name;
    run.rawName = slot.rawName;
    try {
      await saveLogs(slot, loggedText(filtered.log, slot.rawName), raw, run);
    } catch (error) {
      ui.status = error.message;
      ui.paint();
    }
  }

  startRun(entry, openLog = false) {
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
      result: null,
      progress: null,
    };
    this.nextId += 1;
    this.runs.push(run);
    if (openLog) {
      this.viewing = true;
      this.viewId = run.id;
    }
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
    this.hydrate(run);
    this.verbose = false;
    this.viewing = true;
    this.viewId = id;
    this.ui.status = '';
    this.ui.paint();
  }

  run() {
    if (this.viewing) return null;
    if (this.focus === 'runs') {
      const picked = this.historyRuns()[this.runCursor];
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
    if (entry && entry.name) this.startRun(entry, true);
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
    if (run.status !== 'running') return void this.syncProgress();
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
    const total = size(this.logBytes);
    this.confirm('logs', `logs older than 5 days (${total})`);
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

module.exports = {
  NpmController,
};
