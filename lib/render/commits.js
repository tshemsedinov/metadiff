'use strict';

const ansi = require('../term/ansi.js');
const { shortAge } = require('../common/format.js');
const { wrapMultiline, wrapDoc, cursorInWrap } = require('../term/wrap.js');
const primitives = require('./primitives.js');

const { THEME, paint, visibleWidth, trimVisible, seq, EL } = ansi;
const { MARK_W, markPrefix, padVisible } = primitives;
const { editSpan, fieldWindow, paintBodyFill, listLine } = primitives;
const { paintListWindow, paintCursorList } = primitives;
const { measureColumns, padColumns, joinColumns, paintColumns } = primitives;

const COMMIT_COL_ALIGN = {
  sha: 'end',
  refs: 'end',
  add: 'start',
  del: 'start',
  date: 'start',
};

const COUNT_ALIGN = { add: 'start', del: 'start' };

const COMMIT_COL_FG = {
  sha: THEME.shaFg,
  refs: THEME.warnFg,
  add: THEME.addLineFg,
  del: THEME.delLineFg,
  date: THEME.mutedFg,
};

const COMMIT_CURRENT_COL_FG = {
  ...COMMIT_COL_FG,
  sha: THEME.shaDarkFg,
  refs: THEME.shaDarkFg,
  date: THEME.headerFg,
};

const REFS_MAX = 28;
const COMMIT_TAIL = 1;
const DIFF_LABEL = 'Diffs:';
const DIFF_GAP = '  ';
const COL_GAP = 2;
const MIN_LEFT = 8;
const FULL_INDENT = ' '.repeat(MARK_W);
const NO_COUNT = { add: '', del: '' };

const countLabel = (entry) => {
  if (entry.pending) {
    const stagedAdd = entry.stagedAdded ?? 0;
    const unstagedAdd = entry.unstagedAdded ?? 0;
    const stagedDel = entry.stagedRemoved ?? 0;
    const unstagedDel = entry.unstagedRemoved ?? 0;
    const any = stagedAdd || unstagedAdd || stagedDel || unstagedDel;
    if (!any) return NO_COUNT;
    return {
      add: `+${stagedAdd}/${unstagedAdd}`,
      del: `-${stagedDel}/${unstagedDel}`,
    };
  }
  const added = entry.added ?? 0;
  const removed = entry.removed ?? 0;
  if (!added && !removed) return NO_COUNT;
  return { add: `+${added}`, del: `-${removed}` };
};

const countWidths = (entries) =>
  measureColumns(entries, countLabel, COUNT_ALIGN);

const refsText = (entry) => `${entry.refs ?? ''}`.trim();

const commitRowFields = (entry) => {
  const { add, del } = countLabel(entry);
  return {
    sha: entry.shortSha ?? '',
    refs: trimVisible(refsText(entry), REFS_MAX),
    add,
    del,
    date: shortAge(entry.date),
  };
};

const contentWidth = (width) => Math.max(1, width - COMMIT_TAIL);

const splitMessage = (message) => {
  const text = `${message ?? ''}`;
  const at = text.indexOf('\n');
  if (at < 0) return { line: text, rest: '' };
  return { line: text.slice(0, at), rest: text.slice(at + 1) };
};

const commitText = (entry) => {
  if (!entry) return '';
  if (entry.body) return `${entry.body}`;
  return `${entry.subject ?? ''}`;
};

const commitLine = (entry) => splitMessage(commitText(entry)).line;

const viewedCommit = (entry, rev, revShort) => {
  if (entry.pending) return !rev && !revShort;
  const ids = [rev, revShort].filter(Boolean);
  return ids.some((id) => entry.sha === id || entry.shortSha === id);
};

const commitTone = (selected, current) => {
  if (current) {
    return {
      current: true,
      fgRgb: THEME.headerFg,
      bgRgb: THEME.currentBg,
      nameFg: THEME.mutedFg,
    };
  }
  if (selected) {
    return {
      current: false,
      fgRgb: THEME.chromeFg,
      bgRgb: THEME.buttonBg,
      nameFg: THEME.buttonHotFg,
    };
  }
  return {
    current: false,
    fgRgb: THEME.mutedFg,
    bgRgb: THEME.ctxBg,
    nameFg: THEME.chromeFg,
  };
};

const paintCommitRow = (entry, width, color, selected, cols, current) => {
  const prefix = markPrefix(selected);
  const parts = padColumns(commitRowFields(entry), cols, COMMIT_COL_ALIGN);
  const suffix = joinColumns(parts, cols);
  const rest = Math.max(1, contentWidth(width) - visibleWidth(prefix + suffix));
  const subject = trimVisible(commitLine(entry), rest);
  const after = ' '.repeat(Math.max(0, rest - visibleWidth(subject)));
  const tail = ' '.repeat(COMMIT_TAIL);
  if (!color) return `${prefix}${subject}${after}${suffix}${tail}`;
  const tone = commitTone(selected, current);
  const tones = current ? COMMIT_CURRENT_COL_FG : COMMIT_COL_FG;
  let out = `${seq(tone.fgRgb, tone.bgRgb)}${EL}`;
  out += paint(prefix, tone.fgRgb, tone.bgRgb, color);
  out += paint(subject, tone.nameFg, tone.bgRgb, color);
  out += paint(after, tone.fgRgb, tone.bgRgb, color);
  out += paintColumns(parts, cols, tone.fgRgb, tone.bgRgb, color, tones);
  return out + paint(tail, tone.fgRgb, tone.bgRgb, color);
};

const paintCommitEdit = (compose, width, color, entry, cols, index) => {
  const text = splitMessage(compose.text).line;
  const prefix = markPrefix(true);
  const fields = commitRowFields(entry ?? {});
  const suffix = joinColumns(padColumns(fields, cols, COMMIT_COL_ALIGN), cols);
  const rest = Math.max(1, contentWidth(width) - visibleWidth(prefix + suffix));
  const win = fieldWindow(text, compose.cursor, compose.scrollCol, rest);
  const shown = { ...entry, body: win.text, subject: win.text };
  const textX = MARK_W + 1;
  const edit = editSpan(1, textX, textX + rest, 0, text);
  return {
    row: paintCommitRow(shown, width, color, true, cols),
    cursor: { x: textX + win.col, scroll: win.scroll },
    at: entry ? 'replace' : 'start',
    index,
    edits: [{ ...edit, scroll: win.scroll }],
  };
};

const editTarget = (compose, commits, cursor) => {
  if (compose?.kind !== 'commit') return null;
  const kind = compose.commitKind;
  if (kind === 'amend' || kind === 'reword') return cursor;
  if (kind === 'commit' || kind === 'fixup') {
    return commits.findIndex((entry) => entry.pending);
  }
  return -1;
};

const commitEditRow = (compose, commits, target, width, color, cols) => {
  if (target === null) return null;
  if (target < 0) return paintCommitEdit(compose, width, color, null, {}, -1);
  const entry = commits[target];
  if (!entry) return null;
  return paintCommitEdit(compose, width, color, entry, cols, target);
};

const fitPieces = (pieces, width) => {
  const shown = [];
  let used = 0;
  for (const piece of pieces) {
    if (used >= width) break;
    const text = trimVisible(piece.text, width - used);
    if (!text) continue;
    shown.push({ text, fg: piece.fg });
    used += visibleWidth(text);
  }
  return { shown, pad: ' '.repeat(Math.max(0, width - used)) };
};

const paintPieces = (pieces, width, color, tone) => {
  const { shown, pad } = fitPieces(pieces, contentWidth(width));
  const tail = ' '.repeat(COMMIT_TAIL);
  if (!color) {
    const plain = shown.map((piece) => piece.text).join('');
    return `${plain}${pad}${tail}`;
  }
  let out = `${seq(tone.fgRgb, tone.bgRgb)}${EL}`;
  for (const piece of shown) {
    out += paint(piece.text, piece.fg, tone.bgRgb, color);
  }
  out += paint(pad, tone.fgRgb, tone.bgRgb, color);
  return out + paint(tail, tone.fgRgb, tone.bgRgb, color);
};

const messageText = (entry) =>
  `${entry.body ?? ''}`.trimEnd() || `${entry.subject ?? ''}`.trimEnd();

const messageParts = (text, width) => {
  if (!text) return [{ text: '', kind: 'text' }];
  const parts = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kind = i ? 'body' : 'text';
    for (const row of wrapMultiline(lines[i], Math.max(1, width))) {
      parts.push({ text: row, kind });
    }
  }
  return parts;
};

const authorParts = (entry) => {
  const name = `${entry.author ?? ''}`.trim();
  const email = `${entry.email ?? ''}`.trim();
  if (name && email) {
    return [
      { text: name, kind: 'author' },
      { text: ` <${email}>`, kind: 'email' },
    ];
  }
  if (email) return [{ text: email, kind: 'email' }];
  if (name) return [{ text: name, kind: 'author' }];
  return [];
};

const partsWidth = (parts) =>
  parts.reduce((width, part) => width + visibleWidth(part.text), 0);

const timeFields = (entry) => ({
  when: `${entry.when ?? ''}`.trim(),
  ago: shortAge(entry.date),
});

const timeNeed = (entry) => {
  const { when, ago } = timeFields(entry);
  if (when && ago) return visibleWidth(when) + COL_GAP + visibleWidth(ago);
  return visibleWidth(when || ago);
};

const diffLine = (entry, widths) => {
  const label = countLabel(entry);
  if (!label.add) return null;
  const add = padVisible(label.add, widths.add, 'start');
  const del = padVisible(label.del, widths.del, 'start');
  const text = `${DIFF_LABEL}${DIFF_GAP}${add}${DIFF_GAP}${del}`;
  return { add, del, text };
};

const diffCountParts = (entry, widths, rightW) => {
  const line = diffLine(entry, widths);
  if (!line || !rightW) return [];
  const pad = Math.max(0, rightW - visibleWidth(line.text));
  return [
    { text: ' '.repeat(pad), kind: 'meta' },
    { text: DIFF_LABEL, kind: 'meta' },
    { text: DIFF_GAP, kind: 'meta' },
    { text: line.add, kind: 'add' },
    { text: DIFF_GAP, kind: 'meta' },
    { text: line.del, kind: 'del' },
  ];
};

const rightNeed = (entry, widths) => {
  const line = diffLine(entry, widths);
  return Math.max(
    partsWidth(authorParts(entry)),
    timeNeed(entry),
    visibleWidth(refsText(entry)),
    line ? visibleWidth(line.text) : 0,
  );
};

const spreadTime = (when, ago, width) => {
  const agoW = visibleWidth(ago);
  if (agoW >= width) {
    return [{ text: trimVisible(ago, width), kind: 'meta' }];
  }
  const room = width - agoW;
  const minGap = Math.min(COL_GAP, room);
  const left = trimVisible(when, room - minGap);
  const gap = width - visibleWidth(left) - agoW;
  return [
    { text: left, kind: 'meta' },
    { text: ' '.repeat(gap), kind: 'meta' },
    { text: ago, kind: 'meta' },
  ];
};

const alignEnd = (text, width, kind) => {
  const shown = trimVisible(text, width);
  const pad = Math.max(0, width - visibleWidth(shown));
  return [
    { text: ' '.repeat(pad), kind },
    { text: shown, kind },
  ];
};

const timeParts = (entry, width) => {
  if (!width) return [];
  const { when, ago } = timeFields(entry);
  if (when && ago) return spreadTime(when, ago, width);
  if (ago) return alignEnd(ago, width, 'meta');
  if (when) return [{ text: trimVisible(when, width), kind: 'meta' }];
  return [];
};

const rightRows = (entry, rightW, widths) => {
  const rows = [];
  const author = authorParts(entry);
  if (author.length) rows.push(author);
  const time = timeParts(entry, rightW);
  if (time.length) rows.push(time);
  const refs = refsText(entry);
  if (refs) rows.push([{ text: refs, kind: 'refs' }]);
  const diff = diffCountParts(entry, widths, rightW);
  if (diff.length) rows.push(diff);
  return rows;
};

const panelWidths = (need, leftNeed, inner) => {
  const room = Math.max(1, inner - MARK_W);
  if (!need || room <= MIN_LEFT) return { rightW: 0, leftW: room, gapW: 0 };
  const reserve = Math.max(MIN_LEFT, leftNeed);
  const minLeft = Math.min(reserve, room - COL_GAP - 1);
  const maxRight = room - COL_GAP - minLeft;
  const rightW = need > maxRight ? Math.max(1, maxRight) : need;
  return { rightW, leftW: room - COL_GAP - rightW, gapW: COL_GAP };
};

const panelLeft = (entry, leftW, edit) => {
  const parts = messageParts(edit ? edit.text : messageText(entry), leftW);
  if (!entry.sha) return parts;
  return [{ text: entry.sha, kind: 'hash' }, ...parts];
};

const commitMessageWidth = (entry, screenWidth) => {
  const width = Math.max(20, screenWidth || 80);
  const inner = contentWidth(width);
  if (!entry) return Math.max(1, inner - MARK_W);
  const need = rightNeed(entry, countWidths([entry]));
  const cols = panelWidths(need, visibleWidth(entry.sha ?? ''), inner);
  return Math.max(1, cols.leftW);
};

const pieceFg = (kind, tone) => {
  if (kind === 'add') return THEME.addLineFg;
  if (kind === 'del') return THEME.delLineFg;
  if (tone.current) {
    if (kind === 'hash') return THEME.shaDarkFg;
    if (kind === 'refs') return THEME.shaDarkFg;
    if (kind === 'text' || kind === 'body') return THEME.mutedFg;
    return tone.fgRgb;
  }
  if (kind === 'hash') return THEME.shaFg;
  if (kind === 'author') return THEME.addLineFg;
  if (kind === 'email') return THEME.mutedFg;
  if (kind === 'refs') return THEME.warnFg;
  if (kind === 'text') return tone.nameFg;
  if (kind === 'body') return THEME.mutedFg;
  return tone.fgRgb;
};

const clipParts = (parts, width, tone) => {
  const pieces = parts.map((part) => ({
    text: part.text,
    fg: pieceFg(part.kind, tone),
  }));
  const { shown, pad } = fitPieces(pieces, width);
  if (pad) shown.push({ text: pad, fg: tone.fgRgb });
  return shown;
};

const paintPanelLine = (left, right, cols, first, spec) => {
  const tone = commitTone(spec.selected, spec.current);
  const prefix = first ? markPrefix(spec.selected) : FULL_INDENT;
  const text = trimVisible(left.text, cols.leftW);
  const gapW = Math.max(0, cols.leftW - visibleWidth(text)) + cols.gapW;
  const pieces = [
    { text: prefix, fg: tone.fgRgb },
    { text, fg: pieceFg(left.kind, tone) },
    { text: ' '.repeat(gapW), fg: tone.fgRgb },
    ...clipParts(right, cols.rightW, tone),
  ];
  return paintPieces(pieces, spec.width, spec.color, tone);
};

const commitLines = (entry, index, spec) => {
  const { width, edit, diffWidths } = spec;
  const need = rightNeed(entry, diffWidths);
  const hashW = visibleWidth(entry.sha ?? '');
  const cols = panelWidths(need, hashW, contentWidth(width));
  const rights = rightRows(entry, cols.rightW, diffWidths);
  const left = panelLeft(entry, cols.leftW, edit);
  const doc = edit ? wrapDoc(edit.text, cols.leftW) : [];
  const caret = edit ? cursorInWrap(edit.text, edit.cursor, cols.leftW) : null;
  const skip = entry.sha ? 1 : 0;
  const textX = MARK_W + 1;
  const x1 = textX + cols.leftW;
  const count = Math.max(left.length, rights.length);
  const lines = [];
  for (let row = 0; row < count; row++) {
    const line = left[row] ?? { text: '', kind: 'text' };
    const right = rights[row] ?? [];
    const painted = paintPanelLine(line, right, cols, row === 0, spec);
    const messageRow = row - skip;
    const atCaret = caret && caret.row === messageRow;
    const cursor = atCaret ? { x: textX + caret.col } : null;
    const piece = doc[messageRow];
    const edits = piece
      ? [editSpan(1, textX, x1, piece.start, piece.text)]
      : [];
    lines.push(listLine(painted, index, cursor, edits));
  }
  return lines;
};

const flattenCommits = (view, commits, target, width, color) => {
  const cursor = view.commitCursor ?? 0;
  const { compose } = view;
  const edit = { text: compose?.text ?? '', cursor: compose?.cursor ?? 0 };
  const spec = { width, color, diffWidths: countWidths(commits) };
  const lines = [];
  if (target === -1) {
    lines.push(...commitLines({}, -1, { ...spec, selected: true, edit }));
  }
  const gap = listLine(paintBodyFill(width, color, 'files'), -1);
  for (let index = 0; index < commits.length; index++) {
    if (lines.length) lines.push(gap);
    const entry = commits[index];
    const inplace = index === target;
    const selected = inplace || (target === null && index === cursor);
    const current = viewedCommit(entry, view.rev, view.revShort);
    const entryEdit = inplace ? edit : null;
    const entrySpec = { ...spec, selected, current, edit: entryEdit };
    lines.push(...commitLines(entry, index, entrySpec));
  }
  return lines;
};

const focusLine = (lines, cursor, editing) => {
  if (editing) {
    const at = lines.findIndex((line) => line.cursor);
    if (at >= 0) return at;
  }
  const at = lines.findIndex((line) => line.hit && line.index === cursor);
  return Math.max(0, at);
};

const paintBodyCommits = (view, width, color, bodyH, headerLines) => {
  const pane = { width, color, bodyH, headerLines, offset: view.listScroll };
  const commits = view.commits ?? [];
  const cursor = view.commitCursor ?? 0;
  const { compose } = view;
  const target = editTarget(compose, commits, cursor);
  if (view.commitView === 'full') {
    const lines = flattenCommits(view, commits, target, width, color);
    const focus = focusLine(lines, cursor, target !== null);
    return paintListWindow(lines.length, focus, pane, (i) => lines[i]);
  }
  const cols = measureColumns(commits, commitRowFields, COMMIT_COL_ALIGN);
  const edit = commitEditRow(compose, commits, target, width, color, cols);
  const paintRow = (entry, selected) => {
    const current = viewedCommit(entry, view.rev, view.revShort);
    return paintCommitRow(entry, width, color, selected, cols, current);
  };
  return paintCursorList(commits, cursor, pane, paintRow, edit);
};

module.exports = {
  paintBodyCommits,
  commitMessageWidth,
  commitLine,
  commitText,
  splitMessage,
};
