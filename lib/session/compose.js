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
const { itemPath, isTodoItem, listPath, isReadOnlyOrigin } = files;
const diff = require('../diff/diff.js');
const { blockAddText } = diff;
const items = require('./items.js');
const { itemFeedKey, canEditCode } = items;
const review = require('../review.js');
const { setFeedback, setCode, checkLabel, rememberTemplate } = review;
const templates = require('./templates.js');
const { createTemplatePick } = templates;
const todos = require('./todos.js');
const { createTodoCompose } = todos;
const unit = require('./unit.js');

const COMPOSE_EDITS = ['backspace', 'delete', 'ctrl-z', 'ctrl-y'];
const COMPOSE_LEAVE = ['next', 'prev', 'todo'];

const KIND = {
  feedback: {
    enter: 'save',
    tab: 'template',
    escape: 'save',
    move: 'note',
    command: null,
    view: 'note',
  },
  code: {
    enter: 'newline',
    tab: 'insert-tab',
    escape: 'save',
    move: 'code',
    command: null,
    view: 'code',
  },
  file: {
    enter: 'newline',
    tab: 'insert-tab',
    escape: 'save',
    move: 'code',
    command: null,
    view: 'code',
  },
  todo: {
    enter: 'edit-next',
    tab: 'template',
    escape: 'save',
    move: 'todo',
    command: null,
    view: 'todo',
  },
  commit: {
    enter: 'save',
    tab: 'template',
    escape: 'cancel',
    move: 'note',
    command: 'commit',
    view: 'note',
  },
  branch: {
    enter: 'save',
    tab: 'template',
    escape: 'cancel',
    move: 'note',
    command: 'branch',
    view: 'note',
  },
  npm: {
    enter: 'save',
    tab: 'insert-tab',
    escape: 'cancel',
    move: 'note',
    command: 'npm',
    view: 'note',
  },
};

const initialState = () => ({
  editor: null,
  composeKind: null,
  commitKind: null,
  commitBody: '',
  composeTodoId: null,
  composeBaseline: '',
  templateIndex: -1,
  templateFocus: false,
  blinkOn: true,
  fileDirty: false,
  fileEditRows: null,
  fileOpened: '',
});

const reset = (state) => {
  Object.assign(state, initialState());
};

const resetBlink = (api) => {
  api.state.blinkOn = true;
  api.restartBlink();
};

const tickBlink = (api) => {
  if (!api.state.composeKind) return;
  api.state.blinkOn = !api.state.blinkOn;
  api.ui.draw();
};

const viewSize = (api) => api.ui.lastSize ?? api.ui.getSize();

const syncCodeScroll = (api) => {
  const kind = api.state.composeKind;
  if (kind !== 'code' && kind !== 'file') return;
  const ed = api.state.editor;
  if (!ed) return;
  const size = viewSize(api);
  const inner = codeInnerWidth(size.width, api.ui.layout);
  ed.reveal(inner);
};

const followFileEdit = (api) => {
  if (api.state.composeKind !== 'file') return;
  const text = api.state.editor ? api.state.editor.text : null;
  const rows = unit.linesFor(
    api.ui,
    api.nav.reviewPath,
    text,
    api.state.fileEditRows,
  );
  unit.followFileCursor(api.nav, api.state.editor, api.ui.lastFrame, rows);
};

const afterClose = (api) => {
  api.ui.clampIndex();
  api.ui.syncReviewPath();
  api.ui.syncFileCursor();
};

const openCompose = (api, kind, text, todoId) => {
  const { state, ui, nav } = api;
  ui.mode = 'compose';
  state.composeKind = kind;
  state.composeTodoId = todoId ?? null;
  state.composeBaseline = text;
  state.fileOpened = kind === 'file' ? text : '';
  state.editor = new Editor(text);
  state.templateIndex = -1;
  state.templateFocus = false;
  ui.status = '';
  nav.clearSelection();
  resetBlink(api);
};

const closeCompose = (api) => {
  const { state, ui } = api;
  ui.mode = 'review';
  state.editor = null;
  state.composeKind = null;
  state.commitKind = null;
  state.commitBody = '';
  state.composeTodoId = null;
  state.composeBaseline = '';
  state.fileOpened = '';
  state.templateIndex = -1;
  state.templateFocus = false;
  state.fileEditRows = null;
  afterClose(api);
};

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

const writesCodeFile = (api, item) => {
  if (!canEditCode(item)) return false;
  const caps = api.ui.capabilities;
  if (!caps || caps.changes !== true) return false;
  if (isReadOnlyOrigin(item.origin)) return false;
  const repo = api.ui.repo;
  return !!(repo && typeof repo.edit === 'function');
};

const commitFeedback = (api, text) => {
  const item = api.ui.current();
  if (!item || isTodoItem(item)) return;
  const notes = api.review.store;
  setFeedback(notes, itemFeedKey(item), itemNote(item, text));
};

const dropCodeNote = (api, item, text) => {
  const notes = api.review.store;
  if (!notes) return;
  const key = itemFeedKey(item);
  if (!notes.code.has(key)) return;
  setCode(notes, key, { ...itemNote(item, text), clear: true });
};

const saveCodeNote = (api, item, text) => {
  const original = blockAddText(item.hunk, item.blockId);
  const notes = api.review.store;
  const key = itemFeedKey(item);
  const note = itemNote(item, text);
  if (text === original) {
    return void setCode(notes, key, { ...note, clear: true });
  }
  setCode(notes, key, note);
};

const saveCodeFile = (api, item, text) => {
  const original = blockAddText(item.hunk, item.blockId);
  if (text === original) {
    dropCodeNote(api, item, text);
    return true;
  }
  try {
    api.ui.repo.edit(api.ui.top, item, text);
  } catch (error) {
    api.ui.status = error.message;
    return false;
  }
  dropCodeNote(api, item, text);
  api.state.fileDirty = true;
  return true;
};

const commitCode = (api, text) => {
  const item = api.ui.current();
  if (!canEditCode(item)) return true;
  if (writesCodeFile(api, item)) return saveCodeFile(api, item, text);
  saveCodeNote(api, item, text);
  return true;
};

const saveUnitFile = (api, text) => {
  const rel = api.nav.reviewPath;
  const repo = api.ui.repo;
  if (!rel || !repo || typeof repo.writeFile !== 'function') return true;
  const caps = api.ui.capabilities;
  if (!caps || caps.changes !== true) {
    api.ui.status = 'read only';
    return false;
  }
  try {
    repo.writeFile(api.ui.top, rel, text);
  } catch (error) {
    api.ui.status = error.message;
    return false;
  }
  if (typeof api.ui.ignoreWatch === 'function') api.ui.ignoreWatch();
  api.state.composeBaseline = text;
  api.state.fileDirty = true;
  return true;
};

const stageEditedFile = (api, rel) => {
  if (!rel) return false;
  const repo = api.ui.repo;
  if (!repo) return false;
  const caps = api.ui.capabilities;
  if (!caps || caps.changes !== true) return false;
  if (typeof repo.stagePath === 'function') {
    try {
      repo.stagePath(api.ui.top, rel);
    } catch (error) {
      api.ui.status = error.message;
      return false;
    }
    if (typeof api.ui.ignoreWatch === 'function') api.ui.ignoreWatch();
    return true;
  }
  if (typeof repo.add !== 'function') return false;
  let staged = 0;
  for (const item of api.ui.items ?? []) {
    if (listPath(item) !== rel) continue;
    if (isReadOnlyOrigin(item.origin)) continue;
    if (item.origin === 'staged') continue;
    try {
      repo.add(api.ui.top, item);
    } catch (error) {
      api.ui.status = error.message;
      return staged > 0;
    }
    if (api.ui.collection && api.ui.collection.keepOrigin) {
      api.ui.collection.keepOrigin(item, 'staged');
    }
    staged += 1;
  }
  if (staged && typeof api.ui.ignoreWatch === 'function') {
    api.ui.ignoreWatch();
  }
  return staged > 0;
};

const saveFileCompose = (api) => {
  const rel = api.nav.reviewPath;
  const opened = api.state.fileOpened;
  const text = api.state.editor ? api.state.editor.text : '';
  if (api.state.editor) {
    api.nav.unitLine = api.state.editor.linePos().line;
  }
  const result = saveUnitFile(api, text);
  if (result === false) return { kind: 'error' };
  const changed = text !== opened;
  const reload = api.state.fileDirty === true;
  if (changed) stageEditedFile(api, rel);
  api.ui.flushReview();
  closeCompose(api);
  const doneStatus = changed ? 'staged' : 'saved';
  if (!reload || typeof api.ui.reloadAfterChange !== 'function') {
    if (!api.ui.status) api.ui.status = doneStatus;
    return { kind: 'saved' };
  }
  api.ui.reloadAfterChange(() => {
    if (!api.ui.status) api.ui.status = doneStatus;
  });
  return { kind: 'saved' };
};

const commitCompose = (api) => {
  const { state } = api;
  if (!state.composeKind || !state.editor) return true;
  const text = state.editor.text;
  if (state.composeKind === 'feedback') {
    if (api.review.store) commitFeedback(api, text);
    return true;
  }
  if (state.composeKind === 'todo') {
    api.todos.commitTodo(text);
    return true;
  }
  if (state.composeKind === 'code') return commitCode(api, text);
  if (state.composeKind === 'file') return saveUnitFile(api, text);
  return true;
};

const saveCompose = (api, extra) => {
  const opts = extra ?? {};
  const spec = KIND[api.state.composeKind];
  if (spec && spec.command) return { kind: spec.command };
  const kind = api.state.composeKind;
  if (kind === 'file') return saveFileCompose(api);
  const item = api.ui.current ? api.ui.current() : null;
  const shouldStage =
    kind === 'code' &&
    writesCodeFile(api, item) &&
    item &&
    item.origin !== 'staged';
  const rel = itemPath(item);
  const baseline = api.state.composeBaseline;
  const result = commitCompose(api);
  if (result === false) return { kind: 'error' };
  const reload = api.state.fileDirty === true;
  if (kind === 'feedback') {
    const notes = api.review.store;
    const editor = api.state.editor;
    const next = editor ? editor.text : '';
    if (notes) rememberTemplate(notes, baseline, next);
  }
  if (shouldStage && reload) stageEditedFile(api, rel);
  api.ui.flushReview();
  closeCompose(api);
  const doneStatus = shouldStage && reload ? 'staged' : 'saved';
  if (reload && typeof api.ui.reloadAfterChange === 'function') {
    api.ui.reloadAfterChange(() => {
      if (!api.ui.status) api.ui.status = doneStatus;
    });
  } else {
    api.ui.status = doneStatus;
  }
  if (opts.editNext === true) api.todos.editNextTodo();
  return { kind: 'saved' };
};

const autosave = (api) => {
  const { state } = api;
  const spec = KIND[state.composeKind];
  const text = state.editor ? state.editor.text : '';
  if (state.composeKind === 'file' && state.editor) {
    if (text === state.composeBaseline) return;
    return void saveUnitFile(api, text);
  }
  const editingCode = state.composeKind === 'code';
  const composing = state.composeKind !== null;
  const reviewKind = composing && (!spec || !spec.command);
  const liveItem = api.ui.current ? api.ui.current() : null;
  const fileEdit = editingCode && writesCodeFile(api, liveItem);
  if (reviewKind && !fileEdit && (editingCode || text.trim())) {
    commitCompose(api);
  }
  const notes = api.review.store;
  if (notes && notes.dirty) api.ui.flushReview();
};

const composeView = (api) => {
  const { state } = api;
  if (!state.composeKind || !state.editor) return null;
  const spec = KIND[state.composeKind];
  if (!spec || spec.view !== 'note') return null;
  const kind = state.composeKind;
  const text = state.editor.text;
  const cursor = state.editor.cursor;
  return { kind, text, cursor, commitKind: state.commitKind };
};

const liveCodeText = (api) => {
  const { state } = api;
  if (state.composeKind === 'file' && state.editor) return state.editor.text;
  const item = api.ui.current();
  if (!canEditCode(item)) return null;
  if (state.composeKind === 'code' && state.editor) return state.editor.text;
  if (writesCodeFile(api, item)) return null;
  const notes = api.review.store;
  if (!notes) return null;
  const note = notes.code.get(itemFeedKey(item));
  if (!note) return null;
  return note.text;
};

const codeOverlayView = (api) => {
  const text = liveCodeText(api);
  if (text === null) return null;
  const editing =
    api.state.composeKind === 'code' || api.state.composeKind === 'file';
  const editor = api.state.editor;
  const cursor = editing && editor ? editor.cursor : null;
  const picked = editing && editor ? editor.scrollCol : 0;
  const scrollCol = picked ?? 0;
  return { text, keepEmpty: editing, cursor, scrollCol };
};

const idleNoteText = (api) => {
  const notes = api.review.store;
  if (!notes) return '';
  if (api.state.composeKind) return '';
  const item = api.ui.current();
  if (!item || isTodoItem(item)) return '';
  const note = notes.feedback.get(itemFeedKey(item));
  if (!note || !note.text.trim()) return '';
  return checkLabel(note.text, note.done);
};

const composeTab = (api) => {
  const spec = KIND[api.state.composeKind];
  if (spec && spec.tab === 'insert-tab') {
    api.state.editor.insert('\t');
    return null;
  }
  return api.templates.applyTemplate();
};

const moveTemplateLine = (api, delta, shown, width) => {
  const { state } = api;
  if (state.templateFocus) {
    let next = state.templateIndex + delta;
    if (next < 0) next = 0;
    if (next >= shown.length) next = shown.length - 1;
    if (next === state.templateIndex) {
      state.templateFocus = false;
      return true;
    }
    api.templates.focusTemplate(next, false);
    return true;
  }
  const pos = cursorInWrap(state.editor.text, state.editor.cursor, width);
  const last = wrapDoc(state.editor.text, width).length - 1;
  if (delta < 0 && pos.row === 0) {
    api.templates.focusTemplate(shown.length - 1, false);
    return true;
  }
  if (delta > 0 && pos.row === last) {
    api.templates.focusTemplate(0, false);
    return true;
  }
  return false;
};

const moveNoteLine = (api, delta) => {
  const size = viewSize(api);
  const width = noteInnerWidth(size.width);
  const shown = api.templates.shownTemplates();
  const feedback = api.state.composeKind === 'feedback';
  if (shown.length && feedback) {
    if (moveTemplateLine(api, delta, shown, width)) return;
  }
  api.state.editor.moveLine(delta, width);
};

const fullCommitEdit = (api) =>
  api.state.composeKind === 'commit' && api.ui.commits.commitView === 'full';

const editedCommitEntry = (api) => {
  const kind = api.state.commitKind;
  if (kind !== 'amend' && kind !== 'reword') return null;
  const list = listedCommits(api.ui.commits.commits);
  return list[api.nav.commitCursor] ?? null;
};

const moveCommitLine = (api, delta) => {
  const size = viewSize(api);
  const width = commitMessageWidth(editedCommitEntry(api), size.width);
  api.state.editor.moveLine(delta, width);
};

const moveComposeLine = (api, delta) => {
  const spec = KIND[api.state.composeKind];
  const move = spec ? spec.move : 'note';
  if (move === 'todo') {
    const size = viewSize(api);
    const inner = todoBodyWidth(size.width);
    return void api.todos.moveTodoCompose(delta, inner);
  }
  if (move === 'code') {
    api.state.editor.moveLine(delta);
    return void syncCodeScroll(api);
  }
  if (fullCommitEdit(api)) return void moveCommitLine(api, delta);
  moveNoteLine(api, delta);
};

const composePageStep = (api) => {
  const frame = api.ui.lastFrame ?? null;
  const size = viewSize(api);
  const fallback = Math.max(1, (size.height ?? 24) - 4);
  return Math.max(1, frame?.bodyH ?? fallback);
};

const jumpComposeTemplates = (api, toEnd) => {
  if (!api.state.templateFocus) return false;
  const shown = api.templates.shownTemplates();
  if (!shown.length) return false;
  const index = toEnd ? shown.length - 1 : 0;
  api.templates.focusTemplate(index, false);
  return true;
};

const composeHome = (api) => {
  if (jumpComposeTemplates(api, false)) return;
  api.state.editor.home();
};

const composeEnd = (api) => {
  if (jumpComposeTemplates(api, true)) return;
  api.state.editor.end();
};

const moveComposePage = (api, dir) => {
  const step = composePageStep(api) * dir;
  moveComposeLine(api, step);
};

const onFeedback = (api) => {
  if (api.nav.pane === 'files') {
    api.ui.status = 'not a diff block';
    return;
  }
  const item = api.ui.current();
  if (!item || isTodoItem(item)) {
    api.ui.status = 'not a diff block';
    return;
  }
  const notes = api.review.store;
  const prev = notes.feedback.get(itemFeedKey(item));
  const text = prev ? prev.text : '';
  openCompose(api, 'feedback', text);
};

const onUnitEdit = (api) => {
  const rel = api.nav.reviewPath;
  if (!rel) {
    api.ui.status = 'not a diff block';
    return;
  }
  const caps = api.ui.capabilities;
  if (!caps || caps.changes !== true) {
    api.ui.status = 'read only';
    return;
  }
  const at = unit.editCursor(api.ui);
  openCompose(api, 'file', at.text);
  api.state.fileEditRows = at.rows ?? null;
  api.state.editor.cursor = Math.min(at.cursor, at.text.length);
  syncCodeScroll(api);
  followFileEdit(api);
};

const onCode = (api) => {
  if (api.nav.pane === 'unit') return void onUnitEdit(api);
  if (api.nav.pane === 'files') {
    api.ui.status = 'not a diff block';
    return;
  }
  const item = api.ui.current();
  if (!canEditCode(item)) {
    api.ui.status = 'not a diff block';
    return;
  }
  const original = blockAddText(item.hunk, item.blockId);
  const notes = api.review.store;
  const prev = writesCodeFile(api, item)
    ? null
    : notes.code.get(itemFeedKey(item));
  const text = prev ? prev.text : original;
  openCompose(api, 'code', text);
  syncCodeScroll(api);
};

const insertNewline = (api) => {
  api.state.editor.insert('\n');
  resetBlink(api);
  followFileEdit(api);
  return null;
};

const onEmptyLastLine = (editor) => {
  if (!editor) return false;
  const text = editor.text;
  const lastBreak = text.lastIndexOf('\n');
  if (editor.cursor < lastBreak + 1) return false;
  return text.slice(lastBreak + 1).trim() === '';
};

const enterCompose = (api) => {
  const { state } = api;
  if (state.templateFocus && state.composeKind === 'feedback') {
    return api.templates.selectTemplate(state.templateIndex);
  }
  const spec = KIND[state.composeKind];
  if (spec && spec.enter === 'newline') return insertNewline(api);
  if (fullCommitEdit(api)) {
    if (onEmptyLastLine(state.editor)) return saveCompose(api);
    return insertNewline(api);
  }
  if (spec && spec.enter === 'edit-next') {
    return saveCompose(api, { editNext: true });
  }
  return saveCompose(api);
};

const leaveCompose = (api, key) => {
  const spec = KIND[api.state.composeKind];
  if (spec && spec.escape === 'cancel' && key === 'escape') {
    closeCompose(api);
    api.ui.status = '';
    return null;
  }
  return saveCompose(api);
};

const COMPOSE_SPECIAL = {
  backspace: (api) => api.state.editor.backspace(),
  delete: (api) => api.state.editor.delete(),
  left: (api) => api.state.editor.move(-1),
  right: (api) => api.state.editor.move(1),
  'ctrl-left': (api) => api.state.editor.moveWord(-1),
  'ctrl-right': (api) => api.state.editor.moveWord(1),
  up: (api) => moveComposeLine(api, -1),
  down: (api) => moveComposeLine(api, 1),
  home: (api) => composeHome(api),
  end: (api) => composeEnd(api),
  pageUp: (api) => moveComposePage(api, -1),
  pageDown: (api) => moveComposePage(api, 1),
  'ctrl-a': (api) => api.state.editor.home(),
  'ctrl-e': (api) => api.state.editor.end(),
  'ctrl-z': (api) => api.state.editor.undoEdit(),
  'ctrl-y': (api) => api.state.editor.redoEdit(),
  tab: (api) => composeTab(api),
};

const handleKey = (api, key) => {
  if (key === 'enter') {
    const result = enterCompose(api);
    syncCodeScroll(api);
    return result;
  }
  if (key === 'escape' || key === 'ctrl-s') return leaveCompose(api, key);
  const special = COMPOSE_SPECIAL[key];
  if (special) {
    const result = special(api);
    if (COMPOSE_EDITS.includes(key)) api.templates.clearTemplatePick();
    resetBlink(api);
    followFileEdit(api);
    syncCodeScroll(api);
    return result ?? null;
  }
  if (!key.length) return null;
  if (key.startsWith('ctrl-') || key.startsWith('alt-')) return null;
  if (key.charCodeAt(0) >= 32) {
    api.templates.clearTemplatePick();
    api.state.editor.insert(key);
    resetBlink(api);
    followFileEdit(api);
    syncCodeScroll(api);
  }
  return null;
};

const applyDiskText = (api, text) => {
  if (api.state.composeKind !== 'file' || !api.state.editor) return;
  if (text === api.state.editor.text) return;
  const cursor = api.state.editor.cursor;
  api.state.editor.text = text;
  api.state.editor.cursor = Math.min(cursor, text.length);
  api.state.composeBaseline = text;
  api.state.fileEditRows = unit.linesFor(api.ui, api.nav.reviewPath, null);
  syncCodeScroll(api);
  followFileEdit(api);
};

const composerMethods = (api) => ({
  reset: () => reset(api.state),
  openCompose: (kind, text, todoId) => openCompose(api, kind, text, todoId),
  closeCompose: () => closeCompose(api),
  commitCompose: () => commitCompose(api),
  saveCompose: (opts) => saveCompose(api, opts),
  autosave: () => autosave(api),
  composeView: () => composeView(api),
  codeOverlayView: () => codeOverlayView(api),
  idleNoteText: () => idleNoteText(api),
  resetBlink: () => resetBlink(api),
  tickBlink: () => tickBlink(api),
  onFeedback: () => onFeedback(api),
  onCode: () => onCode(api),
  handleKey: (key) => handleKey(api, key),
  liveFileText: () => {
    if (api.state.composeKind !== 'file' || !api.state.editor) return null;
    return api.state.editor.text;
  },
  fileEditRows: () => api.state.fileEditRows,
  applyDiskText: (text) => applyDiskText(api, text),
});

const createComposer = ({ nav, review, ui, restartBlink }) => {
  const state = initialState();
  const api = { nav, review, ui, restartBlink, state };
  api.open = (kind, text, todoId) => openCompose(api, kind, text, todoId);
  api.close = () => closeCompose(api);
  api.commit = () => commitCompose(api);
  api.save = (opts) => saveCompose(api, opts);
  api.resetBlink = () => resetBlink(api);
  api.templates = createTemplatePick(api);
  api.todos = createTodoCompose(api);
  const composer = {
    state,
    ...composerMethods(api),
    ...api.todos,
    ...api.templates,
  };
  return composer;
};

module.exports = {
  COMPOSE_EDITS,
  COMPOSE_LEAVE,
  KIND,
  createComposer,
};
