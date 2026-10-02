'use strict';

const wrap = require('../wrap.js');
const { cursorInWrap, wrapDoc } = wrap;
const render = require('../render/render.js');
const { noteInnerWidth, codeInnerWidth, todoBodyWidth } = render;
const commits = require('../render/commits.js');
const { commitMessageWidth } = commits;
const commit = require('./commit.js');
const { listedCommits } = commit;
const editor = require('../editor.js');
const { Editor } = editor;
const files = require('../files.js');
const { itemPath, isTaskItem, isTasksEntry, listPath } = files;
const { isReadOnlyOrigin } = files;
const diff = require('../diff/diff.js');
const { blockAddText } = diff;
const items = require('./items.js');
const { itemFeedKey, canEditCode } = items;
const review = require('../review.js');
const { setFeedback, setCode, checkLabel, rememberTemplate } = review;
const templates = require('./templates.js');
const { TemplatePick } = templates;
const tasks = require('./tasks.js');
const { TaskPage } = tasks;
const unit = require('./unit.js');
const clipboard = require('../clipboard.js');

const COMPOSE_EDITS = ['backspace', 'delete', 'ctrl-z', 'ctrl-y'];
const COMPOSE_CLIP = ['ctrl-x', 'ctrl-v'];
const COMPOSE_LEAVE = ['next', 'prev', 'tasks'];

const KIND = {
  feedback: { enter: 'save', tab: 'template', escape: 'save', move: 'note' },
  code: { enter: 'newline', tab: 'insert-tab', escape: 'save', move: 'code' },
  file: { enter: 'newline', tab: 'insert-tab', escape: 'save', move: 'code' },
  tasks: { enter: 'edit-next', tab: 'template', escape: 'save', move: 'tasks' },
  commit: { enter: 'save', tab: 'template', escape: 'cancel', move: 'note' },
  branch: { enter: 'save', tab: 'template', escape: 'cancel', move: 'note' },
  npm: { enter: 'save', tab: 'insert-tab', escape: 'cancel', move: 'note' },
};

const COMMAND_KINDS = ['commit', 'branch', 'npm'];
const NOTE_VIEWS = ['feedback', 'commit', 'branch', 'npm'];

const itemNote = (item, text) => {
  const hunk = item.hunk;
  return {
    file: itemPath(item),
    oldStart: hunk ? hunk.oldStart : 0,
    newStart: hunk ? hunk.newStart : 0,
    blockId: item.blockId ?? 0,
    origin: item.origin,
    header: hunk ? hunk.header : '',
    text,
  };
};

const onEmptyLastLine = (editor) => {
  if (!editor) return false;
  const text = editor.text;
  const lastBreak = text.lastIndexOf('\n');
  if (editor.cursor < lastBreak + 1) return false;
  return text.slice(lastBreak + 1).trim() === '';
};

const filledLines = (text) =>
  text.split('\n').filter((line) => line.trim() !== '').length;

const blankTail = (text) => {
  const lines = text.split('\n');
  let count = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim() !== '') break;
    count += 1;
  }
  return count;
};

const COMPOSE_SPECIAL = {
  backspace: (c) => c.editor.backspace(),
  delete: (c) => c.editor.delete(),
  left: (c) => c.editor.move(-1),
  right: (c) => c.editor.move(1),
  'shift-left': (c) => c.editor.move(-1, true),
  'shift-right': (c) => c.editor.move(1, true),
  'ctrl-left': (c) => c.editor.moveWord(-1),
  'ctrl-right': (c) => c.editor.moveWord(1),
  'ctrl-shift-left': (c) => c.editor.moveWord(-1, true),
  'ctrl-shift-right': (c) => c.editor.moveWord(1, true),
  up: (c) => c.moveLine(-1),
  down: (c) => c.moveLine(1),
  'shift-up': (c) => c.moveLine(-1, true),
  'shift-down': (c) => c.moveLine(1, true),
  home: (c) => c.home(),
  end: (c) => c.end(),
  'shift-home': (c) => c.home(true),
  'shift-end': (c) => c.end(true),
  pageUp: (c) => c.movePage(-1),
  pageDown: (c) => c.movePage(1),
  'ctrl-a': (c) => c.editor.home(),
  'ctrl-e': (c) => c.editor.end(),
  'ctrl-c': (c) => c.copy(),
  'ctrl-x': (c) => c.cut(),
  'ctrl-v': (c) => c.paste(),
  'ctrl-z': (c) => c.editor.undoEdit(),
  'ctrl-y': (c) => c.editor.redoEdit(),
  tab: (c) => c.tab(),
};

class Composer {
  constructor(ui) {
    this.ui = ui;
    this.templates = new TemplatePick(this);
    this.tasks = new TaskPage(this);
    this.reset();
  }

  reset() {
    this.fileDirty = false;
    this.clear();
  }

  clear() {
    this.editor = null;
    this.composeKind = null;
    this.commitKind = null;
    this.commitBody = '';
    this.composeTaskId = null;
    this.composeBaseline = '';
    this.templateIndex = -1;
    this.templateFocus = false;
    this.fileEditRows = null;
    this.fileOpened = '';
  }

  get spec() {
    return KIND[this.composeKind] ?? null;
  }

  get notes() {
    return this.ui.review.store;
  }

  viewSize() {
    return this.ui.lastSize ?? this.ui.getSize();
  }

  canChange() {
    const caps = this.ui.capabilities;
    return Boolean(caps && caps.changes === true);
  }

  syncCodeScroll() {
    const kind = this.composeKind;
    if (kind !== 'code' && kind !== 'file') return;
    if (!this.editor) return;
    const width = this.viewSize().width;
    this.editor.reveal(codeInnerWidth(width, this.ui.layout));
  }

  followFileEdit() {
    if (this.composeKind !== 'file') return;
    const ui = this.ui;
    const text = this.editor ? this.editor.text : null;
    const rel = ui.nav.reviewPath;
    const rows = unit.linesFor(ui, rel, text, this.fileEditRows);
    unit.followFileCursor(ui.nav, this.editor, ui.lastFrame, rows);
  }

  openCompose(kind, text, taskId = null) {
    this.ui.mode = 'compose';
    this.composeKind = kind;
    this.composeTaskId = taskId;
    this.composeBaseline = text;
    this.fileOpened = kind === 'file' ? text : '';
    this.editor = new Editor(text);
    this.templateIndex = -1;
    this.templateFocus = false;
    this.ui.status = '';
    this.ui.nav.clearSelection();
  }

  closeCompose() {
    const ui = this.ui;
    ui.mode = 'review';
    this.clear();
    ui.clampIndex();
    ui.syncReviewPath();
    ui.syncFileCursor();
  }

  liveFileText() {
    if (this.composeKind !== 'file' || !this.editor) return null;
    return this.editor.text;
  }

  writesCodeFile(item) {
    if (!canEditCode(item) || !this.canChange()) return false;
    if (isReadOnlyOrigin(item.origin)) return false;
    return Boolean(this.ui.repo.edit);
  }

  commitFeedback(text) {
    const item = this.ui.current();
    if (!item || isTaskItem(item)) return;
    setFeedback(this.notes, itemFeedKey(item), itemNote(item, text));
  }

  dropCodeNote(item, text) {
    const notes = this.notes;
    if (!notes) return;
    const key = itemFeedKey(item);
    if (!notes.code.has(key)) return;
    setCode(notes, key, { ...itemNote(item, text), clear: true });
  }

  commitCode(text) {
    const ui = this.ui;
    const item = ui.current();
    if (!canEditCode(item)) return true;
    const original = blockAddText(item.hunk, item.blockId);
    if (!this.writesCodeFile(item)) {
      const note = itemNote(item, text);
      const clear = text === original;
      setCode(this.notes, itemFeedKey(item), clear ? { ...note, clear } : note);
      return true;
    }
    if (text !== original) {
      try {
        ui.repo.edit(ui.top, item, text);
      } catch (error) {
        ui.status = error.message;
        return false;
      }
      this.fileDirty = true;
    }
    this.dropCodeNote(item, text);
    return true;
  }

  saveUnitFile(text) {
    const ui = this.ui;
    const rel = ui.nav.reviewPath;
    if (!rel || !ui.repo.writeFile) return true;
    if (!this.canChange()) {
      ui.status = 'read only';
      return false;
    }
    try {
      ui.repo.writeFile(ui.top, rel, text);
    } catch (error) {
      ui.status = error.message;
      return false;
    }
    ui.ignoreWatch();
    this.composeBaseline = text;
    this.fileDirty = true;
    return true;
  }

  stageEditedFile(rel) {
    const ui = this.ui;
    const repo = ui.repo;
    if (!rel || !this.canChange()) return false;
    if (repo.stagePath) {
      try {
        repo.stagePath(ui.top, rel);
      } catch (error) {
        ui.status = error.message;
        return false;
      }
      ui.ignoreWatch();
      return true;
    }
    if (!repo.add) return false;
    let staged = 0;
    for (const item of ui.items) {
      if (listPath(item) !== rel) continue;
      if (isReadOnlyOrigin(item.origin) || item.origin === 'staged') continue;
      try {
        repo.add(ui.top, item);
      } catch (error) {
        ui.status = error.message;
        return staged > 0;
      }
      ui.collection.keepOrigin(item, 'staged');
      staged += 1;
    }
    if (staged) ui.ignoreWatch();
    return staged > 0;
  }

  finishSave(reload, doneStatus) {
    const ui = this.ui;
    ui.flushReview();
    this.closeCompose();
    if (!reload) {
      if (!ui.status) ui.status = doneStatus;
      return;
    }
    ui.reloadAfterChange(() => {
      if (!ui.status) ui.status = doneStatus;
    });
  }

  saveFileCompose() {
    const rel = this.ui.nav.reviewPath;
    const opened = this.fileOpened;
    const text = this.editor ? this.editor.text : '';
    if (this.editor) this.ui.nav.unitLine = this.editor.linePos().line;
    if (!this.saveUnitFile(text)) return { kind: 'error' };
    const changed = text !== opened;
    const reload = this.fileDirty === true;
    if (changed) this.stageEditedFile(rel);
    this.finishSave(reload, changed ? 'staged' : 'saved');
    return { kind: 'saved' };
  }

  commitCompose() {
    const kind = this.composeKind;
    if (!kind || !this.editor) return true;
    const text = this.editor.text;
    if (kind === 'feedback') {
      if (this.notes) this.commitFeedback(text);
      return true;
    }
    if (kind === 'tasks') {
      this.tasks.commitTask(text);
      return true;
    }
    if (kind === 'code') return this.commitCode(text);
    if (kind === 'file') return this.saveUnitFile(text);
    return true;
  }

  saveCompose(opts = {}) {
    const ui = this.ui;
    const kind = this.composeKind;
    if (COMMAND_KINDS.includes(kind)) return { kind };
    if (kind === 'file') return this.saveFileCompose();
    const item = ui.current();
    const shouldStage =
      kind === 'code' && this.writesCodeFile(item) && item.origin !== 'staged';
    const rel = itemPath(item);
    const baseline = this.composeBaseline;
    if (this.commitCompose() === false) return { kind: 'error' };
    const reload = this.fileDirty === true;
    if (kind === 'feedback' && this.notes) {
      const next = this.editor ? this.editor.text : '';
      rememberTemplate(this.notes, baseline, next);
    }
    const staging = shouldStage && reload;
    if (staging) this.stageEditedFile(rel);
    const doneStatus = staging ? 'staged' : 'saved';
    if (reload) {
      this.finishSave(true, doneStatus);
    } else {
      ui.flushReview();
      this.closeCompose();
      ui.status = doneStatus;
    }
    if (opts.editNext === true) this.tasks.editNextTask();
    return { kind: 'saved' };
  }

  autosave() {
    const kind = this.composeKind;
    const text = this.editor ? this.editor.text : '';
    if (kind === 'file' && this.editor) {
      if (text === this.composeBaseline) return;
      return void this.saveUnitFile(text);
    }
    const editingCode = kind === 'code';
    const reviewKind = kind !== null && !COMMAND_KINDS.includes(kind);
    const fileEdit = editingCode && this.writesCodeFile(this.ui.current());
    if (reviewKind && !fileEdit && (editingCode || text.trim())) {
      this.commitCompose();
    }
    if (this.notes && this.notes.dirty) this.ui.flushReview();
  }

  composeView() {
    const { composeKind: kind, editor } = this;
    if (!editor || !NOTE_VIEWS.includes(kind)) return null;
    const { text, cursor, scrollCol, anchor } = editor;
    return {
      kind,
      text,
      cursor,
      scrollCol,
      anchor,
      commitKind: this.commitKind,
    };
  }

  liveCodeText() {
    const kind = this.composeKind;
    if (kind === 'file' && this.editor) return this.editor.text;
    const item = this.ui.current();
    if (!canEditCode(item)) return null;
    if (kind === 'code' && this.editor) return this.editor.text;
    if (this.writesCodeFile(item) || !this.notes) return null;
    const note = this.notes.code.get(itemFeedKey(item));
    return note ? note.text : null;
  }

  codeOverlayView() {
    const text = this.liveCodeText();
    if (text === null) return null;
    const editing = this.composeKind === 'code' || this.composeKind === 'file';
    const editor = editing ? this.editor : null;
    return {
      text,
      keepEmpty: editing,
      cursor: editor?.cursor ?? null,
      scrollCol: editor?.scrollCol ?? 0,
      anchor: editor?.anchor ?? null,
    };
  }

  idleNoteText() {
    const notes = this.notes;
    if (!notes || this.composeKind) return '';
    const item = this.ui.current();
    if (!item || isTaskItem(item)) return '';
    const note = notes.feedback.get(itemFeedKey(item));
    if (!note || !note.text.trim()) return '';
    return checkLabel(note.text, note.done);
  }

  tab() {
    if (this.spec && this.spec.tab === 'insert-tab') {
      this.editor.insert('\t');
      return null;
    }
    return this.templates.applyTemplate();
  }

  moveTemplateLine(delta, shown, width) {
    const pick = this.templates;
    if (this.templateFocus) {
      const next = Math.max(
        0,
        Math.min(this.templateIndex + delta, shown.length - 1),
      );
      if (next === this.templateIndex) this.templateFocus = false;
      else pick.focusTemplate(next, false);
      return true;
    }
    const pos = cursorInWrap(this.editor.text, this.editor.cursor, width);
    const last = wrapDoc(this.editor.text, width).length - 1;
    if (delta < 0 && pos.row === 0) {
      pick.focusTemplate(shown.length - 1, false);
      return true;
    }
    if (delta > 0 && pos.row === last) {
      pick.focusTemplate(0, false);
      return true;
    }
    return false;
  }

  noteLineWidth() {
    const width = this.viewSize().width;
    const fullCommit =
      this.composeKind === 'commit' && this.ui.commits.commitView === 'full';
    if (!fullCommit) return noteInnerWidth(width);
    const inPlace = this.commitKind === 'amend' || this.commitKind === 'reword';
    const list = listedCommits(this.ui.commits.commits);
    const entry = (inPlace && list[this.ui.nav.commitCursor]) || null;
    return commitMessageWidth(entry, width);
  }

  moveLine(delta, extend) {
    const move = this.spec ? this.spec.move : 'note';
    if (move === 'tasks') {
      const inner = todoBodyWidth(this.viewSize().width);
      return void this.tasks.moveTaskCompose(delta, inner, extend);
    }
    if (move === 'code') {
      this.editor.moveLine(delta, undefined, extend);
      return void this.syncCodeScroll();
    }
    const width = this.noteLineWidth();
    const shown = this.templates.shownTemplates();
    const feedback = this.composeKind === 'feedback';
    if (shown.length && feedback && !extend) {
      if (this.moveTemplateLine(delta, shown, width)) return;
    }
    this.editor.moveLine(delta, width, extend);
  }

  movePage(dir) {
    const frame = this.ui.lastFrame;
    const fallback = Math.max(1, (this.viewSize().height ?? 24) - 4);
    const step = Math.max(1, frame?.bodyH ?? fallback);
    this.moveLine(step * dir);
  }

  jumpTemplates(toEnd) {
    if (!this.templateFocus) return false;
    const shown = this.templates.shownTemplates();
    if (!shown.length) return false;
    this.templates.focusTemplate(toEnd ? shown.length - 1 : 0, false);
    return true;
  }

  home(extend) {
    if (!extend && this.jumpTemplates(false)) return;
    this.editor.home(extend);
  }

  end(extend) {
    if (!extend && this.jumpTemplates(true)) return;
    this.editor.end(extend);
  }

  onFeedback() {
    const ui = this.ui;
    const item = ui.current();
    if (ui.nav.pane === 'files' || !item || isTaskItem(item)) {
      ui.status = 'not a diff block';
      return;
    }
    const prev = this.notes.feedback.get(itemFeedKey(item));
    this.openCompose('feedback', prev ? prev.text : '');
  }

  onUnitEdit() {
    const ui = this.ui;
    if (!ui.nav.reviewPath) {
      ui.status = 'not a diff block';
      return;
    }
    if (!this.canChange()) {
      ui.status = 'read only';
      return;
    }
    const at = unit.editCursor(ui);
    this.openCompose('file', at.text);
    this.fileEditRows = at.rows ?? null;
    this.editor.cursor = Math.min(at.cursor, at.text.length);
    this.syncCodeScroll();
    this.followFileEdit();
  }

  onFileEdit() {
    const ui = this.ui;
    const list = ui.fileList();
    const entry = list[ui.nav.fileCursor];
    if (!entry || isTasksEntry(entry)) {
      ui.status = 'not a diff block';
      return;
    }
    unit.openUnitFile(ui, entry);
    this.onUnitEdit();
  }

  onCode() {
    const ui = this.ui;
    if (ui.nav.pane === 'files') return void this.onFileEdit();
    if (ui.nav.pane === 'unit') return void this.onUnitEdit();
    const item = ui.current();
    if (ui.nav.pane === 'files' || !canEditCode(item)) {
      ui.status = 'not a diff block';
      return;
    }
    const original = blockAddText(item.hunk, item.blockId);
    const writes = this.writesCodeFile(item);
    const prev = writes ? null : this.notes.code.get(itemFeedKey(item));
    this.openCompose('code', prev ? prev.text : original);
    this.syncCodeScroll();
  }

  insertNewline() {
    this.editor.insert('\n');
    this.followFileEdit();
    return null;
  }

  enter() {
    const kind = this.composeKind;
    if (this.templateFocus && kind === 'feedback') {
      return this.templates.selectTemplate(this.templateIndex);
    }
    const spec = this.spec;
    if (spec && spec.enter === 'newline') return this.insertNewline();
    if (kind === 'commit' && this.ui.commits.commitView === 'full') {
      const text = this.editor ? this.editor.text : '';
      const shaped = filledLines(text) >= 2 || blankTail(text) >= 2;
      if (onEmptyLastLine(this.editor) && shaped) return this.saveCompose();
      return this.insertNewline();
    }
    if (spec && spec.enter === 'edit-next') {
      return this.saveCompose({ editNext: true });
    }
    return this.saveCompose();
  }

  leave(key) {
    if (this.spec && this.spec.escape === 'cancel' && key === 'escape') {
      this.closeCompose();
      this.ui.status = '';
      return null;
    }
    return this.saveCompose();
  }

  copy() {
    const text = this.editor.selectedText();
    if (!text) return;
    const ok = clipboard.copyText(text, this.ui.stdout);
    this.ui.status = ok ? 'copied' : 'copy failed';
  }

  cut() {
    if (!this.editor.hasSelect()) return;
    this.copy();
    this.editor.removeSpan();
  }

  paste() {
    const text = clipboard.pasteText();
    if (text) this.editor.insert(text);
  }

  afterEdit() {
    this.followFileEdit();
    this.syncCodeScroll();
  }

  handleKey(key) {
    if (key === 'enter') {
      const result = this.enter();
      this.syncCodeScroll();
      return result;
    }
    if (key === 'escape' || key === 'ctrl-s') return this.leave(key);
    const special = COMPOSE_SPECIAL[key];
    if (special) {
      const result = special(this);
      const edits = COMPOSE_EDITS.includes(key) || COMPOSE_CLIP.includes(key);
      if (edits) this.templates.clearTemplatePick();
      this.afterEdit();
      return result ?? null;
    }
    if (!key.length || key.startsWith('ctrl-') || key.startsWith('alt-')) {
      return null;
    }
    if (key.length === 1 && key.charCodeAt(0) >= 32) {
      this.templates.clearTemplatePick();
      this.editor.insert(key);
      this.afterEdit();
    }
    return null;
  }

  applyDiskText(text) {
    const editor = this.editor;
    if (this.composeKind !== 'file' || !editor) return;
    if (text === editor.text) return;
    const cursor = editor.cursor;
    editor.text = text;
    editor.cursor = Math.min(cursor, text.length);
    editor.anchor = null;
    this.composeBaseline = text;
    this.fileEditRows = unit.linesFor(this.ui, this.ui.nav.reviewPath, null);
    this.syncCodeScroll();
    this.followFileEdit();
  }
}

module.exports = { COMPOSE_LEAVE, Composer };
