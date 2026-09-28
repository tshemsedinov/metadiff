'use strict';

const ansi = require('./ansi.js');
const { graphemes, visibleWidth } = ansi;
const wrap = require('./wrap.js');
const { wrapMove } = wrap;

const UNDO_CAP = 100;

const graphemeIndex = (text, cursor) => {
  const parts = graphemes(text);
  let pos = 0;
  let i = 0;
  while (i < parts.length && pos + parts[i].length <= cursor) {
    pos += parts[i].length;
    i += 1;
  }
  return { parts, i, pos };
};

const offsetAt = (parts, count) => {
  let pos = 0;
  for (let i = 0; i < count; i++) pos += parts[i].length;
  return pos;
};

const WORD_RE = /[\p{L}\p{N}_]/u;

const isWordChar = (ch) => WORD_RE.test(ch);

const skipWhile = (parts, at, dir, pred) => {
  if (dir > 0) {
    while (at < parts.length && pred(parts[at])) at += 1;
    return at;
  }
  while (at > 0 && pred(parts[at - 1])) at -= 1;
  return at;
};

const wordIndex = (parts, at, dir) => {
  const word = (ch) => isWordChar(ch);
  const sep = (ch) => !isWordChar(ch);
  if (dir > 0) {
    if (at < parts.length && word(parts[at])) {
      return skipWhile(parts, at, 1, word);
    }
    at = skipWhile(parts, at, 1, sep);
    return skipWhile(parts, at, 1, word);
  }
  if (at > 0 && word(parts[at - 1])) {
    return skipWhile(parts, at, -1, word);
  }
  at = skipWhile(parts, at, -1, sep);
  return skipWhile(parts, at, -1, word);
};

class Editor {
  constructor(text = '') {
    this.text = text;
    this.cursor = text.length;
    this.undo = [];
    this.redo = [];
    this.wantCol = null;
    this.scrollCol = 0;
    this.anchor = null;
  }

  snapshot() {
    return { text: this.text, cursor: this.cursor, anchor: this.anchor };
  }

  restore(snap) {
    this.text = snap.text;
    this.cursor = snap.cursor;
    this.anchor = snap.anchor ?? null;
  }

  hasSelect() {
    return this.anchor !== null && this.anchor !== this.cursor;
  }

  selectedText() {
    if (!this.hasSelect()) return '';
    const lo = Math.min(this.anchor, this.cursor);
    const hi = Math.max(this.anchor, this.cursor);
    return this.text.slice(lo, hi);
  }

  beginSelect() {
    if (this.anchor === null) this.anchor = this.cursor;
  }

  clearSelect() {
    this.anchor = null;
  }

  collapse(delta) {
    const lo = Math.min(this.anchor, this.cursor);
    const hi = Math.max(this.anchor, this.cursor);
    this.anchor = null;
    this.cursor = delta < 0 ? lo : hi;
  }

  removeSpan() {
    if (!this.hasSelect()) return false;
    const lo = Math.min(this.anchor, this.cursor);
    const hi = Math.max(this.anchor, this.cursor);
    const next = this.text.slice(0, lo) + this.text.slice(hi);
    this.edit(next, lo);
    return true;
  }

  edit(nextText, nextCursor) {
    this.undo.push(this.snapshot());
    if (this.undo.length > UNDO_CAP) {
      this.undo = this.undo.slice(this.undo.length - UNDO_CAP);
    }
    this.redo = [];
    this.text = nextText;
    this.cursor = nextCursor;
    this.anchor = null;
  }

  insert(chunk) {
    this.wantCol = null;
    const selected = this.hasSelect();
    const lo = selected ? Math.min(this.anchor, this.cursor) : this.cursor;
    const hi = selected ? Math.max(this.anchor, this.cursor) : this.cursor;
    const before = this.text.slice(0, lo);
    const after = this.text.slice(hi);
    this.edit(before + chunk + after, lo + chunk.length);
  }

  replace(text) {
    this.wantCol = null;
    this.edit(text, text.length);
  }

  place(offset) {
    const next = Math.max(0, Math.min(offset, this.text.length));
    this.wantCol = null;
    this.anchor = null;
    this.cursor = next;
  }

  backspace() {
    this.wantCol = null;
    if (this.removeSpan()) return;
    const { parts, i } = graphemeIndex(this.text, this.cursor);
    if (i === 0) return;
    const drop = parts[i - 1];
    const nextParts = [...parts.slice(0, i - 1), ...parts.slice(i)];
    this.edit(nextParts.join(''), this.cursor - drop.length);
  }

  delete() {
    this.wantCol = null;
    if (this.removeSpan()) return;
    const { parts, i } = graphemeIndex(this.text, this.cursor);
    if (i >= parts.length) return;
    const nextParts = [...parts.slice(0, i), ...parts.slice(i + 1)];
    this.edit(nextParts.join(''), this.cursor);
  }

  move(delta, extend) {
    this.wantCol = null;
    if (!extend && this.hasSelect()) return void this.collapse(delta);
    if (extend) this.beginSelect();
    const { parts, i } = graphemeIndex(this.text, this.cursor);
    const next = i + delta;
    if (next < 0 || next > parts.length) return;
    this.cursor = offsetAt(parts, next);
  }

  moveWord(delta, extend) {
    this.wantCol = null;
    if (!extend && this.hasSelect()) return void this.collapse(delta);
    if (extend) this.beginSelect();
    const dir = delta < 0 ? -1 : 1;
    const { parts, i } = graphemeIndex(this.text, this.cursor);
    this.cursor = offsetAt(parts, wordIndex(parts, i, dir));
  }

  linePos() {
    const before = this.text.slice(0, this.cursor);
    const at = before.lastIndexOf('\n');
    const line = before.split('\n').length - 1;
    const col = at < 0 ? before.length : before.length - at - 1;
    return { line, col };
  }

  visibleLineCol() {
    const { col, line } = this.linePos();
    const row = this.text.split('\n')[line] ?? '';
    return visibleWidth(row.slice(0, col));
  }

  reveal(width) {
    const col = this.visibleLineCol();
    const room = Math.max(1, width);
    if (col < this.scrollCol) this.scrollCol = col;
    if (col >= this.scrollCol + room) this.scrollCol = col - room + 1;
  }

  moveLine(delta, width, extend) {
    if (!extend) this.clearSelect();
    else this.beginSelect();
    if (width !== undefined) {
      const col = this.wantCol;
      const moved = wrapMove(this.text, this.cursor, width, delta, col);
      this.wantCol = moved.col;
      this.cursor = moved.cursor;
      return;
    }
    const rows = this.text.split('\n');
    const { line, col } = this.linePos();
    let next = line + delta;
    if (next < 0) next = 0;
    if (next >= rows.length) next = rows.length - 1;
    if (next === line) return;
    const row = rows[next];
    const c = Math.min(col, row.length);
    let cursor = 0;
    for (let i = 0; i < next; i++) cursor += rows[i].length + 1;
    this.cursor = cursor + c;
  }

  home(extend) {
    this.wantCol = null;
    if (!extend) this.clearSelect();
    else this.beginSelect();
    const { col } = this.linePos();
    this.cursor -= col;
  }

  end(extend) {
    this.wantCol = null;
    if (!extend) this.clearSelect();
    else this.beginSelect();
    const { line, col } = this.linePos();
    const rows = this.text.split('\n');
    const row = rows[line] ?? '';
    this.cursor += row.length - col;
  }

  undoEdit() {
    if (!this.undo.length) return;
    this.wantCol = null;
    const prev = this.undo.pop();
    this.redo.push(this.snapshot());
    this.restore(prev);
  }

  redoEdit() {
    if (!this.redo.length) return;
    this.wantCol = null;
    const next = this.redo.pop();
    this.undo.push(this.snapshot());
    this.restore(next);
  }
}

module.exports = { Editor };
