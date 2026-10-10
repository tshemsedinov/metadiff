'use strict';

const path = require('node:path');
const files = require('../common/files.js');
const { TASKS_FILE, TASK_KINDS, taskKind, taskTitle } = files;
const { captureBaseline } = require('./merge.js');
const { toInt } = require('../common/utilities.js');
const storePart = require('./store.js');
const { flatTaskText, toNote, feedbackKey, addTask } = storePart;
const { createStore } = storePart;

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

const BACKLOG_HEAD = 'Backlog';

const LEGACY_BACKLOG = 'TODOs';

const TASK_TITLES = new Map([
  [BACKLOG_HEAD, 'debt'],
  [LEGACY_BACKLOG, 'debt'],
  ['Issues', 'debt'],
  ['Bug Reports', 'bugs'],
  ['Bug reports', 'bugs'],
  ['Feature Requests', 'features'],
  ['Feature requests', 'features'],
  ['Technical debt', 'debt'],
  ['Research', 'research'],
  ['Security', 'security'],
  ...TASK_KINDS.map((kind) => [kind.title, kind.id]),
]);

const AGENT_BRIEF =
  'Follow the agent instructions. Work through unchecked items. ' +
  'Mark [x] only near exit after tests pass.';

const AGENT_INSTRUCTIONS = [
  '- Execute reviews with `status` `ready, partial, editing`',
  '- Do not start or change `done` review files',
  '- Work through unchecked items. After finishing one, mark it `[x]`',
  '- Mark `[x]` only near the end, after code changes are done and tests pass',
  '- For `code` items, replace added lines at that location',
  '- If not `editing`, set `status` to `partial` if some remain, ' +
    'or `done` if all are `[x]`',
  '- Do not redo items already marked `[x]`',
  '- Run the full check with `npm t`',
  '- Run specific test files with `reslop t -- node --test <files>`',
].join('\n');

const canonicalStatus = (raw) => {
  const name = raw === 'pending' ? 'ready' : raw;
  return REVIEW_STATUSES.includes(name) ? name : '';
};

const frontmatterStatus = (text) => {
  const body = `${text ?? ''}`;
  if (!body.startsWith('---')) return '';
  const nl = body.indexOf('\n');
  if (nl < 0) return '';
  const rest = body.slice(nl + 1);
  const end = rest.indexOf('\n---');
  if (end < 0) return '';
  for (const line of rest.slice(0, end).split('\n')) {
    const match = STATUS_LINE.exec(line);
    if (match) return match[1];
  }
  return '';
};

const parseFrontmatterStatus = (text) =>
  canonicalStatus(frontmatterStatus(text));

const isDoneMark = (mark) => mark === 'x' || mark === 'X';

const checkboxLine = (text, done) => {
  const mark = done ? 'x' : ' ';
  return `- [${mark}] ${flatTaskText(text)}`;
};

const storeNote = (notes, note, key) => {
  const next = toNote(note);
  notes.set(key || feedbackKey(next), next);
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
    group = { tasks: [], feedback: [], code: [] };
    groups.set(file, group);
  }
  return group;
};

const TASK_SECTION = 'task:';

const taskSection = (id) => `${TASK_SECTION}${id}`;

const groupReviewNotes = (notes) => {
  const groups = new Map();
  for (const kind of TASK_KINDS) {
    for (const todo of notes.tasks) {
      if (!todo.text.trim() || taskKind(todo) !== kind.id) continue;
      fileGroup(groups, taskSection(kind.id)).tasks.push(todo);
    }
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
    AGENT_BRIEF,
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

const sectionTitle = (file) => {
  if (!file.startsWith(TASK_SECTION)) return file;
  return taskTitle(file.slice(TASK_SECTION.length));
};

const backlogFile = (name) => {
  if (name === BACKLOG_HEAD || name === LEGACY_BACKLOG) return TASKS_FILE;
  return name;
};

const emitReviewGroups = (lines, groups) => {
  for (const file of groups.keys()) {
    const group = groups.get(file);
    lines.push(`## ${sectionTitle(file)}`);
    lines.push('');
    for (const todo of group.tasks) {
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
  storeNote(builder.feedback, pending, pending.key);
  return null;
};

const headingFile = (line) => {
  const quoted = FILE_QUOTE.exec(line);
  if (quoted) return backlogFile(quoted[1]);
  if (line.startsWith('## ') && line !== '## Agent instructions') {
    const name = line.slice(3);
    const kind = TASK_TITLES.get(name);
    if (kind) return taskSection(kind);
    return name;
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
  return Object.assign(pending, loc, { key: feedbackKey(loc) });
};

const applyCheckItem = (builder, file, section, pending, textItem, done) => {
  if (file.startsWith(TASK_SECTION)) {
    const kind = file.slice(TASK_SECTION.length);
    addTask(builder, TASKS_FILE, textItem, done, kind);
    return pending;
  }
  if (section === 'todo' && file) {
    addTask(builder, file, textItem, done, 'backlog');
    return pending;
  }
  const parsed = parseFeedSuffix(textItem);
  if (parsed) {
    flushPendingFeedback(builder, pending);
    storeNote(builder.feedback, { ...parsed, file: parsed.file || file, done });
    return null;
  }
  if (pending) {
    pending.text = textItem;
    pending.done = done;
    return flushPendingFeedback(builder, pending);
  }
  if (file && section !== 'feedback') {
    addTask(builder, file, textItem, done, 'backlog');
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
  return { done: isDoneMark(match[1]), ...loc, open: '', lines: [] };
};

const storeCodeNote = (builder, pending, text) => {
  storeNote(builder.code, { ...pending, text });
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

module.exports = {
  frontmatterStatus,
  parseFrontmatterStatus,
  serializeReview,
  parseReview,
};
