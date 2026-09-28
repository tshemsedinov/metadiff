'use strict';

const ansi = require('../ansi.js');
const files = require('../files.js');
const primitives = require('./primitives.js');
const wrap = require('../wrap.js');
const { shortAge } = files;
const { wrapMultiline, wrapDoc, cursorInWrap } = wrap;
const { measureColumns, padColumns, joinColumns, paintColumns } = primitives;
const { padVisible } = primitives;

const { THEME, paint, visibleWidth, truncateVisible, seq, EL } = ansi;
const { FILE_MARK, paintCursorList, fieldWindow } = primitives;
const { paintBodyFill, listLine, paintListWindow } = primitives;

const COMMIT_COL_ALIGN = {
  sha: 'end',
  refs: 'end',
  add: 'start',
  del: 'start',
  date: 'start',
};

const COMMIT_COL_FG = {
  sha: THEME.shaFg,
  refs: THEME.warnFg,
  add: THEME.addLineFg,
  del: THEME.delLineFg,
  date: THEME.mutedFg,
};

const COMMIT_CURRENT_COL_FG = {
  sha: THEME.shaDarkFg,
  refs: THEME.shaDarkFg,
  date: THEME.headerFg,
};

const REFS_MAX = 28;
const COMMIT_TAIL = 1;
const lineCounts = (entry) => {
  const added = entry.added ?? 0;
  const removed = entry.removed ?? 0;
  if (!added && !removed) return null;
  return { added, removed };
};

const countLabel = (entry) => {
  if (entry && entry.pending) {
    const stagedAdd = entry.stagedAdded ?? 0;
    const unstagedAdd = entry.unstagedAdded ?? 0;
    const stagedDel = entry.stagedRemoved ?? 0;
    const unstagedDel = entry.unstagedRemoved ?? 0;
    const any = stagedAdd || unstagedAdd || stagedDel || unstagedDel;
    if (!any) return null;
    return {
      add: `+${stagedAdd}/${unstagedAdd}`,
      del: `-${stagedDel}/${unstagedDel}`,
    };
  }
  const counts = lineCounts(entry);
  if (!counts) return null;
  return { add: `+${counts.added}`, del: `-${counts.removed}` };
};

const DIFF_LABEL = 'Diffs:';
const DIFF_GAP = '  ';

const entryCountWidth = (entry) => {
  const label = countLabel(entry);
  if (!label) return { add: 0, del: 0 };
  return {
    add: visibleWidth(label.add),
    del: visibleWidth(label.del),
  };
};

const listCountWidth = (commits) => {
  let add = 0;
  let del = 0;
  for (const entry of commits) {
    const width = entryCountWidth(entry);
    add = Math.max(add, width.add);
    del = Math.max(del, width.del);
  }
  return { add, del };
};

const commitRowFields = (entry) => {
  const refs = `${entry.refs ?? ''}`.trim();
  const label = countLabel(entry);
  return {
    sha: entry.shortSha ?? '',
    refs: refs ? truncateVisible(refs, REFS_MAX) : '',
    add: label ? label.add : '',
    del: label ? label.del : '',
    date: shortAge(entry.date ?? ''),
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
  const want = `${rev ?? ''}`;
  const short = `${revShort ?? ''}`;
  if (entry && entry.pending) return !want && !short;
  const sha = entry && entry.sha ? `${entry.sha}` : '';
  const brief = entry && entry.shortSha ? `${entry.shortSha}` : '';
  if (want && (sha === want || brief === want)) return true;
  if (short && (sha === short || brief === short)) return true;
  return false;
};

const FULL_INDENT = ' '.repeat(visibleWidth(` ${FILE_MARK} `));

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
  const inner = contentWidth(width);
  const mark = selected ? FILE_MARK : ' ';
  const prefix = ` ${mark} `;
  const parts = padColumns(commitRowFields(entry), cols, COMMIT_COL_ALIGN);
  const suffix = joinColumns(parts, cols);
  const rest = Math.max(1, inner - visibleWidth(prefix + suffix));
  const subject = truncateVisible(commitLine(entry), rest);
  const pad = Math.max(0, rest - visibleWidth(subject));
  const after = `${' '.repeat(pad)}`;
  const left = `${prefix}${subject}${after}`;
  const tail = ' '.repeat(COMMIT_TAIL);
  const tone = commitTone(selected, current);
  const tones = current
    ? { ...COMMIT_COL_FG, ...COMMIT_CURRENT_COL_FG }
    : COMMIT_COL_FG;
  if (!color) return `${left}${suffix}${tail}`;
  let out = `${seq(tone.fgRgb, tone.bgRgb)}${EL}`;
  out += paint(prefix, tone.fgRgb, tone.bgRgb, color);
  out += paint(subject, tone.nameFg, tone.bgRgb, color);
  out += paint(after, tone.fgRgb, tone.bgRgb, color);
  out += paintColumns(parts, cols, tone.fgRgb, tone.bgRgb, color, tones);
  out += paint(tail, tone.fgRgb, tone.bgRgb, color);
  return out;
};

const lineEdit = (text, textX, span, scroll) => ({
  x0: 1,
  textX,
  x1: textX + span,
  start: 0,
  text,
  limit: text.length,
  scroll,
  live: true,
});

const subjectWindow = (compose, rest) => {
  const line = splitMessage(compose.text).line;
  const at = Math.min(compose.cursor ?? 0, line.length);
  return fieldWindow(line, at, compose.scrollCol, rest);
};

const paintCommitEdit = (compose, width, color, entry = null, cols = {}) => {
  const text = splitMessage(compose.text).line;
  const prefix = ` ${FILE_MARK} `;
  const prefixW = visibleWidth(prefix);
  const fields = commitRowFields(entry ?? {});
  const suffix = joinColumns(padColumns(fields, cols, COMMIT_COL_ALIGN), cols);
  const rest = Math.max(1, contentWidth(width) - visibleWidth(prefix + suffix));
  const win = subjectWindow(compose, rest);
  const shown = { ...entry, body: win.text, subject: win.text };
  return {
    row: paintCommitRow(shown, width, color, true, cols),
    cursor: { x: prefixW + win.col + 1, scroll: win.scroll },
    at: entry ? 'replace' : 'start',
    edit: lineEdit(text, prefixW + 1, rest, win.scroll),
  };
};

const pendingAt = (commits) => {
  for (let i = 0; i < commits.length; i++) {
    if (commits[i] && commits[i].pending) return i;
  }
  return -1;
};

const editsCursor = (compose) =>
  compose.commitKind === 'amend' || compose.commitKind === 'reword';

const editsPending = (compose) =>
  compose.commitKind === 'commit' || compose.commitKind === 'fixup';

const commitEditRow = (compose, commits, cursor, width, color, cols) => {
  if (!compose || compose.kind !== 'commit') return null;
  let at = -1;
  if (editsCursor(compose)) at = cursor;
  if (editsPending(compose)) at = pendingAt(commits);
  if (at >= 0) {
    const entry = commits[at];
    if (!entry) return null;
    const painted = paintCommitEdit(compose, width, color, entry, cols);
    painted.index = at;
    return painted;
  }
  return paintCommitEdit(compose, width, color);
};

const paintPieces = (pieces, width, color, selected, current) => {
  const tone = commitTone(selected, current);
  const inner = contentWidth(width);
  const shown = [];
  let used = 0;
  for (const piece of pieces) {
    const room = inner - used;
    if (room <= 0) break;
    const text = truncateVisible(piece.text, room);
    if (!text) continue;
    shown.push({ text, fg: piece.fg });
    used += visibleWidth(text);
  }
  const pad = ' '.repeat(Math.max(0, inner - used));
  const tail = ' '.repeat(COMMIT_TAIL);
  if (!color) {
    let plain = '';
    for (const piece of shown) plain += piece.text;
    return `${plain}${pad}${tail}`;
  }
  let out = `${seq(tone.fgRgb, tone.bgRgb)}${EL}`;
  for (const piece of shown) {
    out += paint(piece.text, piece.fg, tone.bgRgb, color);
  }
  out += paint(pad, tone.fgRgb, tone.bgRgb, color);
  out += paint(tail, tone.fgRgb, tone.bgRgb, color);
  return out;
};

const COL_GAP = 2;
const MIN_LEFT = 8;

const messageText = (entry) => {
  const body = `${entry.body ?? ''}`.replace(/\s+$/, '');
  if (body) return body;
  return `${entry.subject ?? ''}`.replace(/\s+$/, '');
};

const wrapKind = (text, width, kind) => {
  const rows = wrapMultiline(text, Math.max(1, width));
  const lines = [];
  for (const row of rows) lines.push({ text: row, kind });
  return lines;
};

const messagePartsFrom = (text, width) => {
  const raw = `${text ?? ''}`;
  if (!raw) return [{ text: '', kind: 'text' }];
  const split = raw.split('\n');
  const lines = wrapKind(split[0], width, 'text');
  for (let i = 1; i < split.length; i++) {
    const rest = wrapKind(split[i], width, 'body');
    for (const line of rest) lines.push(line);
  }
  return lines;
};

const messageParts = (entry, width) =>
  messagePartsFrom(messageText(entry), width);

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

const partsWidth = (parts) => {
  let width = 0;
  for (const part of parts) width += visibleWidth(part.text);
  return width;
};

const timeNeed = (entry) => {
  const when = `${entry.when ?? ''}`.trim();
  const ago = shortAge(entry.date ?? '');
  if (when && ago) return visibleWidth(when) + COL_GAP + visibleWidth(ago);
  return visibleWidth(when || ago);
};

const refsText = (entry) => `${entry.refs ?? ''}`.trim();

const diffLine = (entry, widths) => {
  const label = countLabel(entry);
  if (!label) return null;
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

const rightNeed = (entry, widths = entryCountWidth(entry)) => {
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
    return [{ text: truncateVisible(ago, width), kind: 'meta' }];
  }
  const room = width - agoW;
  const minGap = Math.min(COL_GAP, room);
  const left = truncateVisible(when, room - minGap);
  const gap = width - visibleWidth(left) - agoW;
  return [
    { text: left, kind: 'meta' },
    { text: ' '.repeat(gap), kind: 'meta' },
    { text: ago, kind: 'meta' },
  ];
};

const alignEnd = (text, width, kind) => {
  const shown = truncateVisible(text, width);
  const pad = Math.max(0, width - visibleWidth(shown));
  return [
    { text: ' '.repeat(pad), kind },
    { text: shown, kind },
  ];
};

const timeParts = (entry, width) => {
  const when = `${entry.when ?? ''}`.trim();
  const ago = shortAge(entry.date ?? '');
  if (!width) return [];
  if (when && ago) return spreadTime(when, ago, width);
  if (ago) return alignEnd(ago, width, 'meta');
  if (when) return [{ text: truncateVisible(when, width), kind: 'meta' }];
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
  const indent = visibleWidth(FULL_INDENT);
  let rightW = need;
  const room = Math.max(1, inner - indent);
  if (!rightW || room <= MIN_LEFT) {
    return { rightW: 0, leftW: room, gapW: 0 };
  }
  const reserve = Math.max(MIN_LEFT, leftNeed);
  const minLeft = Math.min(reserve, room - COL_GAP - 1);
  const maxRight = room - COL_GAP - minLeft;
  if (rightW > maxRight) rightW = Math.max(1, maxRight);
  return { rightW, leftW: room - COL_GAP - rightW, gapW: COL_GAP };
};

const panelLeft = (entry, leftW, edit) => {
  const parts = edit
    ? messagePartsFrom(edit.text ?? '', leftW)
    : messageParts(entry, leftW);
  if (!entry.sha) return parts;
  return [{ text: entry.sha, kind: 'hash' }, ...parts];
};

const commitMessageWidth = (entry, screenWidth) => {
  const width = Math.max(20, screenWidth || 80);
  const inner = contentWidth(width);
  const indent = visibleWidth(FULL_INDENT);
  if (!entry) return Math.max(1, inner - indent);
  const hashW = visibleWidth(entry.sha ?? '');
  const cols = panelWidths(rightNeed(entry), hashW, inner);
  return Math.max(1, cols.leftW);
};

const prefixWidth = (first, selected) => {
  const mark = first && selected ? FILE_MARK : ' ';
  const prefix = first ? ` ${mark} ` : FULL_INDENT;
  return visibleWidth(prefix);
};

const messageCaret = (text, cursor, width, row, first, selected) => {
  const pos = cursorInWrap(`${text ?? ''}`, cursor ?? 0, width);
  if (pos.row !== row) return null;
  return { x: prefixWidth(first, selected) + pos.col + 1 };
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

const clipParts = (parts, width, fallbackKind, tone) => {
  const shown = [];
  let used = 0;
  for (const part of parts) {
    const room = width - used;
    if (room <= 0) break;
    const text = truncateVisible(part.text ?? '', room);
    if (!text) continue;
    const kind = part.kind ?? fallbackKind;
    shown.push({ text, fg: pieceFg(kind, tone) });
    used += visibleWidth(text);
  }
  const pad = Math.max(0, width - used);
  if (pad) shown.push({ text: ' '.repeat(pad), fg: tone.fgRgb });
  return shown;
};

const paintPanelLine = (spec) => {
  const tone = commitTone(spec.selected, spec.current);
  const mark = spec.first && spec.selected ? FILE_MARK : ' ';
  const prefix = spec.first ? ` ${mark} ` : FULL_INDENT;
  const left = truncateVisible(spec.left, spec.leftW);
  const leftPad = Math.max(0, spec.leftW - visibleWidth(left));
  const gap = ' '.repeat(spec.gapW);
  const right = Array.isArray(spec.right)
    ? spec.right
    : [{ text: spec.right ?? '', kind: spec.rightKind }];
  return paintPieces(
    [
      { text: prefix, fg: tone.fgRgb },
      { text: left, fg: pieceFg(spec.leftKind, tone) },
      { text: `${' '.repeat(leftPad)}${gap}`, fg: tone.fgRgb },
      ...clipParts(right, spec.rightW, spec.rightKind, tone),
    ],
    spec.width,
    spec.color,
    spec.selected,
    spec.current,
  );
};

const editFromDoc = (doc, row, textX, span) => {
  if (row < 0 || row >= doc.length) return null;
  const piece = doc[row];
  return {
    x0: 1,
    textX,
    x1: textX + span,
    start: piece.start,
    text: piece.text,
    limit: piece.start + piece.text.length,
    live: true,
  };
};

const editLines = (editHit) => (editHit ? [editHit] : undefined);

const commitLines = (entry, index, spec) => {
  const { width, color, selected, edit, current, diffWidths } = spec;
  const inner = contentWidth(width);
  const hashW = visibleWidth(entry.sha ?? '');
  const widths = diffWidths ?? entryCountWidth(entry);
  const cols = panelWidths(rightNeed(entry, widths), hashW, inner);
  const rights = rightRows(entry, cols.rightW, widths);
  const left = panelLeft(entry, cols.leftW, edit);
  const count = Math.max(left.length, rights.length);
  const doc = edit ? wrapDoc(`${edit.text ?? ''}`, cols.leftW) : null;
  const lines = [];
  for (let row = 0; row < count; row++) {
    const line = left[row] ?? { text: '', kind: 'text' };
    const painted = paintPanelLine({
      left: line.text,
      right: rights[row] ?? [],
      leftW: cols.leftW,
      rightW: cols.rightW,
      gapW: cols.gapW,
      width,
      color,
      selected,
      current,
      first: row === 0,
      leftKind: line.kind,
      rightKind: 'meta',
    });
    const messageRow = entry.sha ? row - 1 : row;
    const first = !entry.sha && row === 0;
    const caret = edit
      ? messageCaret(
          edit.text,
          edit.cursor,
          cols.leftW,
          messageRow,
          first,
          selected,
        )
      : null;
    const textX = prefixWidth(first, selected) + 1;
    const editHit = doc
      ? editFromDoc(doc, messageRow, textX, cols.leftW)
      : null;
    lines.push(listLine(painted, index, caret, editLines(editHit)));
  }
  return lines;
};

const draftLines = (text, cursor, width, color) => {
  const inner = contentWidth(width);
  const leftW = Math.max(1, inner - visibleWidth(FULL_INDENT));
  const parts = messagePartsFrom(text, leftW);
  const doc = wrapDoc(`${text ?? ''}`, leftW);
  const lines = [];
  for (let row = 0; row < parts.length; row++) {
    const line = parts[row];
    const painted = paintPanelLine({
      left: line.text,
      right: '',
      leftW,
      rightW: 0,
      gapW: 0,
      width,
      color,
      selected: true,
      first: row === 0,
      leftKind: line.kind,
      rightKind: 'meta',
    });
    const caret = messageCaret(text, cursor, leftW, row, row === 0, true);
    const textX = prefixWidth(row === 0, true) + 1;
    const editHit = editFromDoc(doc, row, textX, leftW);
    lines.push(listLine(painted, -1, caret, editLines(editHit)));
  }
  return lines;
};

const composeEditsIndex = (compose, commits, index, cursor) => {
  if (!compose || compose.kind !== 'commit') return false;
  if (editsCursor(compose)) return index === cursor;
  if (!editsPending(compose)) return false;
  const at = pendingAt(commits);
  return at >= 0 && index === at;
};

const composeShowsDraft = (compose, commits) => {
  if (!compose || compose.kind !== 'commit') return false;
  if (editsCursor(compose)) return false;
  if (editsPending(compose)) return pendingAt(commits) < 0;
  return true;
};

const flattenCommits = (view, commits, width, color) => {
  const cursor = view.commitCursor ?? 0;
  const compose = view.compose ?? null;
  const editing = compose && compose.kind === 'commit';
  const diffWidths = listCountWidth(commits);
  const gap = listLine(paintBodyFill(width, color, 'files'), -1);
  const lines = [];
  if (composeShowsDraft(compose, commits)) {
    const text = compose.text ?? '';
    lines.push(...draftLines(text, compose.cursor ?? 0, width, color));
  }
  for (let index = 0; index < commits.length; index++) {
    if (lines.length) lines.push(gap);
    const entry = commits[index];
    const inplace = composeEditsIndex(compose, commits, index, cursor);
    const selected = inplace || (!editing && index === cursor);
    const text = compose?.text ?? '';
    const caret = compose?.cursor ?? 0;
    const edit = inplace ? { text, cursor: caret } : null;
    const current = viewedCommit(entry, view.rev, view.revShort);
    const block = commitLines(entry, index, {
      width,
      color,
      selected,
      edit,
      current,
      diffWidths,
    });
    lines.push(...block);
  }
  return lines;
};

const focusLine = (lines, cursor, compose) => {
  if (compose && compose.kind === 'commit') {
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
  if (view.commitView === 'full') {
    const lines = flattenCommits(view, commits, width, color);
    const focus = focusLine(lines, cursor, view.compose);
    return paintListWindow(lines.length, focus, pane, (i) => lines[i]);
  }
  const cols = measureColumns(commits, commitRowFields, COMMIT_COL_ALIGN);
  const extra = commitEditRow(
    view.compose,
    commits,
    cursor,
    width,
    color,
    cols,
  );
  const paintRow = (entry, selected) => {
    const current = viewedCommit(entry, view.rev, view.revShort);
    return paintCommitRow(entry, width, color, selected, cols, current);
  };
  return paintCursorList(commits, cursor, pane, paintRow, extra);
};

module.exports = {
  paintBodyCommits,
  commitMessageWidth,
  commitLine,
  commitText,
  splitMessage,
};
