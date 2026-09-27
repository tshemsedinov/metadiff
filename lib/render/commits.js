'use strict';

const ansi = require('../ansi.js');
const primitives = require('./primitives.js');
const wrap = require('../wrap.js');
const { wrapMultiline, cursorInWrap } = wrap;
const { measureColumns, padColumns, joinColumns, paintColumns } = primitives;

const { THEME, paint, visibleWidth, truncateVisible, seq, EL } = ansi;
const { FILE_MARK, paneResult, paintCursorList } = primitives;
const { paintBodyFill, listWindowStart } = primitives;

const COMMIT_COL_ALIGN = {
  sha: 'end',
  refs: 'end',
  date: 'start',
};

const COMMIT_COL_FG = {
  sha: THEME.shaFg,
  refs: THEME.warnFg,
  date: THEME.mutedFg,
};

const COMMIT_CURRENT_COL_FG = {
  sha: THEME.shaDarkFg,
  date: THEME.headerFg,
};

const REFS_MAX = 28;
const LIST_PAD = 1;
const COMMIT_TAIL = 1;
const commitRowFields = (entry) => ({
  sha: entry.shortSha ?? '',
  refs: truncateVisible(entry.refs ?? '', REFS_MAX),
  date: entry.date ?? '',
});

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

const paintCommitEdit = (compose, width, color, entry, cols) => {
  const text = splitMessage(compose.text).line;
  if (entry && cols) {
    const shown = { ...entry, body: text, subject: text };
    const row = paintCommitRow(shown, width, color, true, cols);
    const inner = contentWidth(width);
    const prefix = ` ${FILE_MARK} `;
    const parts = padColumns(commitRowFields(entry), cols, COMMIT_COL_ALIGN);
    const suffix = joinColumns(parts, cols);
    const rest = Math.max(1, inner - visibleWidth(prefix + suffix));
    const clipped = truncateVisible(text, rest);
    const prefixW = visibleWidth(prefix);
    const col = Math.min(compose.cursor ?? 0, visibleWidth(clipped));
    return {
      row,
      cursor: { x: prefixW + col + 1 },
      at: 'replace',
    };
  }
  const inner = contentWidth(width);
  const prefix = ` ${FILE_MARK} `;
  const prefixW = visibleWidth(prefix);
  const rest = Math.max(1, inner - prefixW);
  const clipped = truncateVisible(text, rest);
  const pad = Math.max(0, rest - visibleWidth(clipped));
  const gap = ' '.repeat(pad);
  const tail = ' '.repeat(COMMIT_TAIL);
  const fgRgb = THEME.chromeFg;
  const bgRgb = THEME.buttonBg;
  const nameFg = THEME.buttonHotFg;
  let row = `${prefix}${clipped}${gap}${tail}`;
  if (color) {
    row = `${seq(fgRgb, bgRgb)}${EL}`;
    row += paint(prefix, fgRgb, bgRgb, color);
    row += paint(clipped, nameFg, bgRgb, color);
    row += paint(gap, fgRgb, bgRgb, color);
    row += paint(tail, fgRgb, bgRgb, color);
  }
  const col = Math.min(compose.cursor ?? 0, visibleWidth(clipped));
  return { row, cursor: { x: prefixW + col + 1 }, at: 'start' };
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
  const ago = `${entry.date ?? ''}`.trim();
  if (when && ago) return visibleWidth(when) + COL_GAP + visibleWidth(ago);
  return visibleWidth(when || ago);
};

const refsText = (entry) => `${entry.refs ?? ''}`.trim();

const rightNeed = (entry) =>
  Math.max(
    partsWidth(authorParts(entry)),
    timeNeed(entry),
    visibleWidth(refsText(entry)),
  );

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
  const ago = `${entry.date ?? ''}`.trim();
  if (!width) return [];
  if (when && ago) return spreadTime(when, ago, width);
  if (ago) return alignEnd(ago, width, 'meta');
  if (when) return [{ text: truncateVisible(when, width), kind: 'meta' }];
  return [];
};

const rightRows = (entry, rightW) => {
  const rows = [authorParts(entry), timeParts(entry, rightW)];
  const refs = refsText(entry);
  if (refs) rows.push([{ text: refs, kind: 'refs' }]);
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
  return [{ text: entry.sha ?? '', kind: 'hash' }, ...parts];
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
  if (tone.current) {
    if (kind === 'hash') return THEME.shaDarkFg;
    if (kind === 'refs') return THEME.warnFg;
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

const lineRecord = (commit, row, hit, cursor = null) => ({
  commit,
  row,
  hit,
  cursor,
});

const commitLines = (entry, index, width, color, selected, edit, current) => {
  const inner = contentWidth(width);
  const hashW = visibleWidth(entry.sha ?? '');
  const cols = panelWidths(rightNeed(entry), hashW, inner);
  const rights = rightRows(entry, cols.rightW);
  const left = panelLeft(entry, cols.leftW, edit);
  const count = Math.max(left.length, rights.length);
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
    const caret = edit
      ? messageCaret(
          edit.text,
          edit.cursor,
          cols.leftW,
          row - 1,
          false,
          selected,
        )
      : null;
    lines.push(lineRecord(index, painted, true, caret));
  }
  return lines;
};

const draftLines = (text, cursor, width, color) => {
  const inner = contentWidth(width);
  const leftW = Math.max(1, inner - visibleWidth(FULL_INDENT));
  const parts = messagePartsFrom(text, leftW);
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
    lines.push(lineRecord(-1, painted, false, caret));
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

const gapLine = (width, color) =>
  lineRecord(-1, paintBodyFill(width, color, 'files'), false);

const flattenCommits = (commits, cursor, width, color, compose, rev, short) => {
  const lines = [];
  const editing = compose && compose.kind === 'commit';
  const pushGap = () => {
    if (lines.length) lines.push(gapLine(width, color));
  };
  if (composeShowsDraft(compose, commits)) {
    const draft = draftLines(
      compose.text ?? '',
      compose.cursor ?? 0,
      width,
      color,
    );
    for (const line of draft) lines.push(line);
  }
  for (let index = 0; index < commits.length; index++) {
    pushGap();
    const inplace = composeEditsIndex(compose, commits, index, cursor);
    const selected = inplace || (!editing && index === cursor);
    const edit = inplace
      ? { text: compose.text ?? '', cursor: compose.cursor ?? 0 }
      : null;
    const block = commitLines(
      commits[index],
      index,
      width,
      color,
      selected,
      edit,
      viewedCommit(commits[index], rev, short),
    );
    for (const line of block) lines.push(line);
  }
  return lines;
};

const focusLine = (lines, cursor, compose) => {
  if (compose && compose.kind === 'commit') {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].cursor) return i;
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.hit && line.commit === cursor) return i;
  }
  return 0;
};

const paintLineWindow = (
  lines,
  focus,
  width,
  color,
  bodyH,
  headerLines,
  offset,
) => {
  const pad = bodyH >= LIST_PAD * 2 + 1 ? LIST_PAD : 0;
  const listH = bodyH - pad * 2;
  const start = listWindowStart(focus, offset, listH, lines.length);
  const blank = paintBodyFill(width, color, 'files');
  const body = [];
  const fileHits = [];
  let textCursor = null;
  if (pad) body.push(blank);
  for (let i = 0; i < listH; i++) {
    const line = lines[start + i];
    if (!line) break;
    body.push(line.row);
    if (line.cursor) {
      textCursor = { x: line.cursor.x, row: body.length - 1 };
    }
    if (!line.hit) continue;
    const y = headerLines + pad + i + 1;
    fileHits.push({ y, cursor: line.commit });
  }
  if (pad) body.push(blank);
  return paneResult({
    body,
    fileHits,
    cursor: textCursor,
    listScroll: start,
  });
};

const paintFullCommits = (view, width, color, bodyH, headerLines) => {
  const commits = view.commits ?? [];
  const cursor = view.commitCursor ?? 0;
  const compose = view.compose ?? null;
  const lines = flattenCommits(
    commits,
    cursor,
    width,
    color,
    compose,
    view.rev,
    view.revShort,
  );
  const focus = focusLine(lines, cursor, compose);
  return paintLineWindow(
    lines,
    focus,
    width,
    color,
    bodyH,
    headerLines,
    view.listScroll,
  );
};

const paintBriefCommits = (
  commits,
  cursor,
  width,
  color,
  bodyH,
  headerLines,
  extra,
  offset,
  cols,
  rev,
  revShort,
) => {
  const paintRow = (entry, rowWidth, rowColor, selected) =>
    paintCommitRow(
      entry,
      rowWidth,
      rowColor,
      selected,
      cols,
      viewedCommit(entry, rev, revShort),
    );
  return paintCursorList(
    commits,
    cursor,
    width,
    color,
    bodyH,
    headerLines,
    paintRow,
    extra,
    offset,
  );
};

const paintBodyCommits = (view, width, color, bodyH, headerLines) => {
  if (view.commitView === 'full') {
    return paintFullCommits(view, width, color, bodyH, headerLines);
  }
  const commits = view.commits ?? [];
  const cols = measureColumns(commits, commitRowFields, COMMIT_COL_ALIGN);
  const cursor = view.commitCursor ?? 0;
  const extra = commitEditRow(
    view.compose,
    commits,
    cursor,
    width,
    color,
    cols,
  );
  return paintBriefCommits(
    commits,
    cursor,
    width,
    color,
    bodyH,
    headerLines,
    extra,
    view.listScroll,
    cols,
    view.rev,
    view.revShort,
  );
};

module.exports = {
  paintBodyCommits,
  commitMessageWidth,
  commitLine,
  commitText,
  splitMessage,
};
