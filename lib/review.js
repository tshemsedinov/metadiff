'use strict';

const fs = require('node:fs');
const path = require('node:path');

const files = require('./files.js');
const { TODO_FILE, REVIEW_DIR } = files;
const reviewMerge = require('./review-merge.js');
const { captureBaseline, mergeReview } = reviewMerge;

const createStore = (reviewPath, templates = []) => ({
  reviewPath,
  dirty: false,
  nextTodoId: 1,
  feedback: new Map(),
  code: new Map(),
  todos: [],
  templates: [...templates],
  status: 'editing',
  baseline: null,
});

const noteCounts = (store) => {
  const counts = { feedback: 0, todo: 0, todoDone: 0, code: 0 };
  if (!store) return counts;
  for (const todo of store.todos) {
    if (!todo.text.trim()) continue;
    counts.todo += 1;
    if (todo.done) counts.todoDone += 1;
  }
  for (const note of store.feedback.values()) {
    if (note.text.trim()) counts.feedback += 1;
  }
  counts.code = store.code.size;
  return counts;
};

const hasNotes = (store) => {
  const counts = noteCounts(store);
  return counts.feedback > 0 || counts.todo > 0 || counts.code > 0;
};

const setFeedback = (store, key, note) => {
  const text = note.text ?? '';
  const trimmed = text.trim();
  const prev = store.feedback.get(key);
  if (!trimmed) {
    if (!prev) return;
    store.feedback.delete(key);
    store.dirty = true;
    return;
  }
  if (prev && prev.text === text) return;
  store.feedback.set(key, {
    file: note.file,
    oldStart: note.oldStart ?? 0,
    newStart: note.newStart ?? 0,
    blockId: note.blockId ?? 0,
    origin: note.origin ?? '',
    header: note.header ?? '',
    text,
    done: note.done ?? prev?.done ?? false,
  });
  store.dirty = true;
};

const setCode = (store, key, note) => {
  const prev = store.code.get(key);
  if (note.clear) {
    if (!prev) return;
    store.code.delete(key);
    store.dirty = true;
    return;
  }
  const text = note.text ?? '';
  if (prev && prev.text === text) return;
  store.code.set(key, {
    file: note.file,
    oldStart: note.oldStart ?? 0,
    newStart: note.newStart ?? 0,
    blockId: note.blockId ?? 0,
    origin: note.origin ?? '',
    header: note.header ?? '',
    text,
    done: note.done ?? prev?.done ?? false,
  });
  store.dirty = true;
};

const addTodo = (store, file, text = '') => {
  const id = store.nextTodoId;
  store.nextTodoId += 1;
  const todo = { id, file, text, done: false };
  store.todos.push(todo);
  store.dirty = true;
  return todo;
};

const removeTodo = (store, id) => {
  const next = [];
  let found = false;
  for (const todo of store.todos) {
    if (todo.id === id) {
      found = true;
      continue;
    }
    next.push(todo);
  }
  if (!found) return false;
  store.todos = next;
  store.dirty = true;
  return true;
};

const setTodoText = (store, id, text) => {
  const i = store.todos.findIndex((todo) => todo.id === id);
  if (i < 0) return;
  const prev = store.todos[i];
  const trimmed = text.trim();
  if (!trimmed) return void removeTodo(store, id);
  if (prev.text === text) return;
  store.todos[i] = { id: prev.id, file: prev.file, text, done: prev.done };
  store.dirty = true;
};

const setTodoDone = (store, id, done) => {
  const i = store.todos.findIndex((todo) => todo.id === id);
  if (i < 0) return;
  const prev = store.todos[i];
  if (prev.done === done) return;
  store.todos[i] = { id: prev.id, file: prev.file, text: prev.text, done };
  store.dirty = true;
};

const checkLabel = (text, done) => {
  const mark = done ? 'x' : ' ';
  return `[${mark}] ${text}`;
};

const feedbackKey = (note) => {
  const file = note.file ?? '';
  const oldStart = note.oldStart ?? 0;
  const newStart = note.newStart ?? 0;
  const block = note.blockId ?? 0;
  return `${file}:${oldStart}:${newStart}:${block}`;
};

const applyImportedNotes = (store, imported) => {
  if (!store || !imported) return;
  const feedbacks = imported.feedback ?? [];
  for (const note of feedbacks) {
    const key = feedbackKey(note);
    const prev = store.feedback.get(key);
    const text = prev ? `${prev.text}\n\n${note.text}` : note.text;
    const done = prev ? prev.done && !!note.done : !!note.done;
    setFeedback(store, key, {
      file: note.file,
      oldStart: note.oldStart ?? 0,
      newStart: note.newStart ?? 0,
      blockId: note.blockId ?? 0,
      origin: note.origin ?? '',
      header: note.header ?? '',
      text,
      done,
    });
  }
  const todos = imported.todos ?? [];
  for (const todo of todos) {
    const added = addTodo(store, todo.file || '', todo.text ?? '');
    if (todo.done) added.done = true;
  }
};

const setStatus = (store, status) => {
  if (!store) return;
  store.status = status;
  store.dirty = true;
};

const TEMPLATE_SHOW = 5;

const rankedTemplates = (templates) => {
  const ranked = [...templates];
  ranked.sort((a, b) => {
    const byCount = b.count - a.count;
    if (byCount) return byCount;
    return a.text.localeCompare(b.text);
  });
  return ranked;
};

const prefixTemplates = (templates, prefix) => {
  if (!prefix) return templates;
  return templates.filter((entry) => entry.text.startsWith(prefix));
};

const upsertTemplate = (templates, text) => {
  const trimmed = text.trim();
  if (!trimmed) return templates;
  const next = [...templates];
  const i = next.findIndex((entry) => entry.text === trimmed);
  if (i < 0) {
    next.push({ text: trimmed, count: 1 });
    return next;
  }
  const prev = next[i];
  next[i] = { text: prev.text, count: prev.count + 1 };
  return next;
};

const rememberTemplate = (store, prevText, nextText) => {
  const trimmed = nextText.trim();
  if (!trimmed) return;
  const prev = (prevText ?? '').trim();
  if (prev === trimmed) return;
  store.templates = upsertTemplate(store.templates, trimmed);
  store.dirty = true;
};

const REVIEW_STATUSES = ['editing', 'ready', 'partial', 'done'];
const FEED_HEAD = /^### Feedback `([^`]+)` \+(\d+) \((.*)\)\s*$/;
const FEED_BLOCK = /^(.*), block (\d+)$/;
const FEED_BLOCK_ONLY = /^block (\d+)$/;
const FEED_META = /^<!-- reslop:(.*) -->\s*$/;
const FEED_SUFFIX = /^(.*) - (.+):(\d+):(\d+):(\d+)$/;
const CHECK_ITEM = /^- \[([ xX])\] (.*)$/;
const CODE_HEAD = /^- \[([ xX])\] code `([^`]+)`\s*$/;
const FENCE_LINE = /^(`{3,})\s*$/;
const FILE_QUOTE = /^> (.+)$/;
const STATUS_LINE = /^status:\s*(\S+)\s*$/;
const GIT_ORIGINS = ['unstaged', 'staged', 'untracked', 'commit', 'pr'];
const SECTION_LINE = {
  '### Todo': 'todo',
  '### Feedback': 'feedback',
};

const AGENT_INSTRUCTIONS = [
  '- Execute reviews with `status` `ready, partial, editing`',
  '- Do not start or change `done` review files',
  '- Work through unchecked items. After finishing one, mark it `[x]`',
  '- For `code` items, replace added lines at that location',
  '- If not `editing`, set `status` to `partial` if some remain, ' +
    'or `done` if all are `[x]`',
  '- Do not redo items already marked `[x]`',
].join('\n');

const toInt = (text) => parseInt(text, 10);

const canonicalStatus = (raw) => {
  if (!raw) return '';
  const name = raw === 'pending' ? 'ready' : raw;
  if (REVIEW_STATUSES.includes(name)) return name;
  return '';
};

const parseFrontmatterStatus = (text) => {
  if (!text.startsWith('---')) return '';
  const nl = text.indexOf('\n');
  if (nl < 0) return '';
  const rest = text.slice(nl + 1);
  const end = rest.indexOf('\n---');
  if (end < 0) return '';
  const matter = rest.slice(0, end);
  for (const line of matter.split('\n')) {
    const match = STATUS_LINE.exec(line);
    if (match) return canonicalStatus(match[1]);
  }
  return '';
};

const isDoneMark = (mark) => mark === 'x' || mark === 'X';

const pushTodo = (builder, file, text, done) => {
  const id = builder.nextTodoId;
  builder.nextTodoId += 1;
  builder.todos.push({ id, file, text, done });
};

const checkboxLine = (text, done) => {
  const flat = text.trim().replace(/\n/g, ' ');
  const mark = done ? 'x' : ' ';
  return `- [${mark}] ${flat}`;
};

const storeFeedback = (builder, note, key) => {
  const next = {
    file: note.file,
    oldStart: note.oldStart ?? 0,
    newStart: note.newStart ?? 0,
    blockId: note.blockId ?? 0,
    origin: note.origin ?? '',
    header: note.header ?? '',
    text: note.text,
    done: note.done ?? false,
  };
  builder.feedback.set(key || feedbackKey(next), next);
};

const storeCode = (builder, note, key) => {
  const next = {
    file: note.file,
    oldStart: note.oldStart ?? 0,
    newStart: note.newStart ?? 0,
    blockId: note.blockId ?? 0,
    origin: note.origin ?? '',
    header: note.header ?? '',
    text: note.text,
    done: note.done ?? false,
  };
  builder.code.set(key || feedbackKey(next), next);
};

const feedbackLine = (note) => {
  const loc = feedbackKey(note);
  return `${checkboxLine(note.text, note.done)} - ${loc}`;
};

const parseLoc = (raw) => {
  const parts = raw.split(':');
  const n = parts.length;
  if (n < 4) return null;
  const blockId = toInt(parts[n - 1]);
  const newStart = toInt(parts[n - 2]);
  const oldStart = toInt(parts[n - 3]);
  if (!Number.isFinite(blockId + newStart + oldStart)) return null;
  let fileParts = parts.slice(0, n - 3);
  let origin = '';
  if (fileParts.length > 1 && GIT_ORIGINS.includes(fileParts[0])) {
    origin = fileParts[0];
    fileParts = fileParts.slice(1);
  }
  if (!fileParts.length) return null;
  const file = fileParts.join(':');
  return { origin, file, oldStart, newStart, blockId };
};

const parseFeedSuffix = (textItem) => {
  const match = FEED_SUFFIX.exec(textItem);
  if (!match) return null;
  const text = match[1];
  const file = match[2];
  const oldStart = toInt(match[3]);
  const newStart = toInt(match[4]);
  const blockId = toInt(match[5]);
  return { text, file, oldStart, newStart, blockId };
};

const fileGroup = (groups, file) => {
  let group = groups.get(file);
  if (!group) {
    group = { todos: [], feedback: [], code: [] };
    groups.set(file, group);
  }
  return group;
};

const groupReviewNotes = (notes) => {
  const groups = new Map();
  for (const todo of notes.todos) {
    if (!todo.text.trim()) continue;
    fileGroup(groups, TODO_FILE).todos.push(todo);
  }
  for (const key of notes.feedback.keys()) {
    const note = notes.feedback.get(key);
    if (!note.text.trim()) continue;
    fileGroup(groups, note.file).feedback.push({ key, note });
  }
  for (const key of notes.code.keys()) {
    const note = notes.code.get(key);
    fileGroup(groups, note.file).code.push({ key, note });
  }
  return groups;
};

const reviewHeader = (notes) => {
  const name = path.basename(notes.reviewPath, '.md');
  const status = canonicalStatus(notes.status) || 'editing';
  return [
    '---',
    `status: ${status}`,
    '---',
    '',
    `# reslop review ${name}`,
    '',
    '## Agent instructions',
    '',
    AGENT_INSTRUCTIONS,
    '',
  ];
};

const fenceFor = (text) => {
  let n = 3;
  for (const line of text.split('\n')) {
    const match = /^(`{3,})/.exec(line);
    if (!match) continue;
    if (match[1].length >= n) n = match[1].length + 1;
  }
  return '`'.repeat(n);
};

const emitCodeItem = (lines, note) => {
  const loc = feedbackKey(note);
  const mark = note.done ? 'x' : ' ';
  const fence = fenceFor(note.text);
  lines.push(`- [${mark}] code \`${loc}\``);
  lines.push(fence);
  if (note.text !== '') lines.push(note.text);
  lines.push(fence);
};

const emitReviewGroups = (lines, groups) => {
  for (const file of groups.keys()) {
    const group = groups.get(file);
    lines.push(`## ${file}`);
    lines.push('');
    for (const todo of group.todos) {
      lines.push(checkboxLine(todo.text, todo.done));
    }
    for (const item of group.feedback) {
      lines.push(feedbackLine(item.note));
    }
    for (const item of group.code) {
      emitCodeItem(lines, item.note);
    }
    lines.push('');
  }
};

const serializeReview = (notes) => {
  const lines = reviewHeader(notes);
  emitReviewGroups(lines, groupReviewNotes(notes));
  return `${lines.join('\n')}\n`;
};

const parseFeedbackHeading = (line) => {
  const match = FEED_HEAD.exec(line);
  if (!match) return null;
  const file = match[1];
  const newStart = toInt(match[2]);
  const rest = match[3];
  const only = FEED_BLOCK_ONLY.exec(rest);
  if (only) {
    return { file, newStart, header: '', blockId: toInt(only[1]) };
  }
  const withHead = FEED_BLOCK.exec(rest);
  if (!withHead) {
    return { file, newStart, header: rest, blockId: 0 };
  }
  const header = withHead[1];
  const blockId = toInt(withHead[2]);
  return { file, newStart, header, blockId };
};

const flushPendingFeedback = (builder, pending) => {
  if (!pending || !(pending.text ?? '').trim()) return null;
  storeFeedback(builder, pending, pending.key);
  return null;
};

const headingFile = (line) => {
  const quoted = FILE_QUOTE.exec(line);
  if (quoted) return quoted[1];
  if (line.startsWith('## ') && line !== '## Agent instructions') {
    return line.slice(3);
  }
  return null;
};

const startFeedbackPending = (heading, file) => ({
  file: heading.file || file,
  newStart: heading.newStart,
  header: heading.header,
  blockId: heading.blockId,
  oldStart: heading.newStart,
  origin: '',
  key: '',
  text: '',
});

const applyFeedMeta = (pending, raw) => {
  const loc = parseLoc(raw);
  if (!loc) return pending;
  pending.origin = loc.origin;
  pending.file = loc.file;
  pending.oldStart = loc.oldStart;
  pending.newStart = loc.newStart;
  pending.blockId = loc.blockId;
  pending.key = feedbackKey(loc);
  return pending;
};

const applyCheckItem = (builder, file, section, pending, textItem, done) => {
  if (section === 'todo' && file) {
    pushTodo(builder, file, textItem, done);
    return pending;
  }
  const parsed = parseFeedSuffix(textItem);
  if (parsed) {
    flushPendingFeedback(builder, pending);
    storeFeedback(builder, {
      file: parsed.file || file,
      oldStart: parsed.oldStart,
      newStart: parsed.newStart,
      blockId: parsed.blockId,
      origin: '',
      header: '',
      text: parsed.text,
      done,
    });
    return null;
  }
  if (pending) {
    pending.text = textItem;
    pending.done = done;
    return flushPendingFeedback(builder, pending);
  }
  if (file && section !== 'feedback') {
    pushTodo(builder, file, textItem, done);
  }
  return pending;
};

const applyReviewLine = (builder, file, section, pending, line) => {
  const nextFile = headingFile(line);
  if (nextFile !== null) {
    pending = flushPendingFeedback(builder, pending);
    return { file: nextFile, section: '', pending };
  }
  const nextSection = SECTION_LINE[line];
  if (nextSection) {
    pending = flushPendingFeedback(builder, pending);
    return { file, section: nextSection, pending };
  }
  const heading = parseFeedbackHeading(line);
  if (heading) {
    flushPendingFeedback(builder, pending);
    pending = startFeedbackPending(heading, file);
    return { file, section: 'feedback', pending };
  }
  const meta = FEED_META.exec(line);
  if (meta && pending) {
    pending = applyFeedMeta(pending, meta[1]);
    return { file, section, pending };
  }
  const item = CHECK_ITEM.exec(line);
  if (!item) return { file, section, pending };
  const done = isDoneMark(item[1]);
  pending = applyCheckItem(builder, file, section, pending, item[2], done);
  return { file, section, pending };
};

const startCodePending = (line) => {
  const match = CODE_HEAD.exec(line);
  if (!match) return null;
  const loc = parseLoc(match[2]);
  if (!loc) return null;
  return {
    done: isDoneMark(match[1]),
    origin: loc.origin,
    file: loc.file,
    oldStart: loc.oldStart,
    newStart: loc.newStart,
    blockId: loc.blockId,
    open: '',
    lines: [],
  };
};

const storeCodeNote = (builder, pending, text) => {
  storeCode(builder, {
    file: pending.file,
    oldStart: pending.oldStart,
    newStart: pending.newStart,
    blockId: pending.blockId,
    origin: pending.origin,
    header: '',
    text,
    done: pending.done,
  });
};

const flushPendingCode = (builder, pending) => {
  if (!pending) return;
  const text = pending.open ? pending.lines.join('\n') : '';
  storeCodeNote(builder, pending, text);
};

const takeCodeLine = (builder, pending, line) => {
  const fence = FENCE_LINE.exec(line);
  if (!pending.open) {
    if (fence) {
      pending.open = fence[1];
      return pending;
    }
    if (!line.trim()) return pending;
    storeCodeNote(builder, pending, '');
    return 'fallthrough';
  }
  if (fence && fence[1].length >= pending.open.length) {
    storeCodeNote(builder, pending, pending.lines.join('\n'));
    return null;
  }
  pending.lines.push(line);
  return pending;
};

const parseReview = (text, reviewPath, templates = []) => {
  const builder = createStore(reviewPath, templates);
  builder.status = parseFrontmatterStatus(text) || 'editing';
  let file = '';
  let section = '';
  let pending = null;
  let pendingCode = null;
  for (const line of text.split('\n')) {
    if (pendingCode) {
      const nextCode = takeCodeLine(builder, pendingCode, line);
      if (nextCode === 'fallthrough') {
        pendingCode = null;
      } else {
        pendingCode = nextCode;
        continue;
      }
    }
    const started = startCodePending(line);
    if (started) {
      pending = flushPendingFeedback(builder, pending);
      pendingCode = started;
      continue;
    }
    const next = applyReviewLine(builder, file, section, pending, line);
    file = next.file;
    section = next.section;
    pending = next.pending;
  }
  flushPendingCode(builder, pendingCode);
  flushPendingFeedback(builder, pending);
  builder.dirty = false;
  captureBaseline(builder);
  return builder;
};

const TEMPLATES_FILE = 'templates.json';
const AUTOSAVE_MS = 3000;
const REVIEW_NAME = /^(\d{4}-\d{2}-\d{2})-(\d+)\.md$/;

const pad2 = (n) => `${n}`.padStart(2, '0');

const dateStamp = (date) => {
  const y = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  return `${y}-${month}-${day}`;
};

const allocateReviewPath = (dir, date, existingNames) => {
  const stamp = dateStamp(date);
  let max = -1;
  for (const name of existingNames) {
    const match = REVIEW_NAME.exec(name);
    if (!match) continue;
    if (match[1] !== stamp) continue;
    const n = toInt(match[2]);
    if (n > max) max = n;
  }
  const next = max + 1;
  const file = `${stamp}-${next < 100 ? pad2(next) : String(next)}.md`;
  return path.join(dir, REVIEW_DIR, file);
};

const listReviewNames = (dir) => {
  const folder = path.join(dir, REVIEW_DIR);
  try {
    return fs.readdirSync(folder);
  } catch {
    return [];
  }
};

const compareReviewNames = (left, right) => {
  const a = REVIEW_NAME.exec(left);
  const b = REVIEW_NAME.exec(right);
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  if (a[1] < b[1]) return -1;
  if (a[1] > b[1]) return 1;
  return toInt(a[2]) - toInt(b[2]);
};

const latestReviewName = (names) => {
  let best = '';
  for (const name of names) {
    if (!REVIEW_NAME.test(name)) continue;
    if (!best || compareReviewNames(name, best) > 0) best = name;
  }
  return best;
};

const readReviewStatus = (reviewPath) => {
  try {
    const text = fs.readFileSync(reviewPath, 'utf8');
    return parseFrontmatterStatus(text);
  } catch {
    return '';
  }
};

const resolveReviewPath = (dir, date, existingNames, extra = {}) => {
  if (!extra.forceNew) {
    const latest = latestReviewName(existingNames);
    if (latest) {
      const reviewPath = path.join(dir, REVIEW_DIR, latest);
      if (readReviewStatus(reviewPath) === 'editing') {
        return { reviewPath, resume: true };
      }
    }
  }
  return {
    reviewPath: allocateReviewPath(dir, date, existingNames),
    resume: false,
  };
};

const loadReview = (reviewPath, templates) => {
  const raw = fs.readFileSync(reviewPath, 'utf8');
  return parseReview(raw, reviewPath, templates);
};

const loadTemplates = (dir) => {
  const file = path.join(dir, REVIEW_DIR, TEMPLATES_FILE);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    const templates = [];
    for (const entry of data) {
      if (!entry || typeof entry.text !== 'string') continue;
      const count = toInt(entry.count);
      templates.push({
        text: entry.text,
        count: Number.isFinite(count) ? count : 1,
      });
    }
    return templates;
  } catch {
    return [];
  }
};

const readReviewText = (reviewPath) => {
  try {
    return fs.readFileSync(reviewPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
};

const mergeDiskReview = (notes) => {
  const text = readReviewText(notes.reviewPath);
  if (!text.startsWith('---')) return;
  const disk = parseReview(text, notes.reviewPath, notes.templates);
  mergeReview(notes, disk);
};

const flushReview = (notes, force = false) => {
  if (!notes || !notes.dirty) return false;
  mergeDiskReview(notes);
  if (!hasNotes(notes) && !force) {
    notes.dirty = false;
    return false;
  }
  const folder = path.dirname(notes.reviewPath);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(notes.reviewPath, serializeReview(notes), 'utf8');
  const top = path.dirname(folder);
  const templatesFile = path.join(top, REVIEW_DIR, TEMPLATES_FILE);
  const body = `${JSON.stringify(notes.templates, null, 2)}\n`;
  fs.writeFileSync(templatesFile, body, 'utf8');
  captureBaseline(notes);
  notes.dirty = false;
  return true;
};

module.exports = {
  TEMPLATE_SHOW,
  AUTOSAVE_MS,
  allocateReviewPath,
  listReviewNames,
  latestReviewName,
  parseFrontmatterStatus,
  resolveReviewPath,
  rankedTemplates,
  prefixTemplates,
  upsertTemplate,
  createStore,
  noteCounts,
  hasNotes,
  rememberTemplate,
  setFeedback,
  setCode,
  addTodo,
  removeTodo,
  setTodoText,
  setTodoDone,
  checkLabel,
  feedbackKey,
  applyImportedNotes,
  setStatus,
  serializeReview,
  parseReview,
  loadReview,
  loadTemplates,
  flushReview,
};
