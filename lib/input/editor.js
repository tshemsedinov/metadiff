'use strict';

const { clamp } = require('../common/utilities.js');
const { graphemes, visibleWidth } = require('../term/ansi.js');
const { wrapMove } = require('../term/wrap.js');

const UNDO_CAP = 100;
const WORD_RE = /[\p{L}\p{N}_]/u;

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

const isWordChar = (ch) => WORD_RE.test(ch);

const isSeparator = (ch) => !isWordChar(ch);

const skipWhile = (parts, at, dir, pred) => {
  if (dir > 0) {
    while (at < parts.length && pred(parts[at])) at += 1;
    return at;
  }
  while (at > 0 && pred(parts[at - 1])) at -= 1;
  return at;
};

const wordIndex = (parts, at, dir) => {
  const ahead = dir > 0 ? parts[at] : parts[at - 1];
  const inWord = ahead !== undefined && isWordChar(ahead);
  const start = inWord ? at : skipWhile(parts, at, dir, isSeparator);
  return skipWhile(parts, start, dir, isWordChar);
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
    this.anchor = snap.anchor;
  }

  hasSelect() {
    return this.anchor !== null && this.anchor !== this.cursor;
  }

  span() {
    if (!this.hasSelect()) return { lo: this.cursor, hi: this.cursor };
    const lo = Math.min(this.anchor, this.cursor);
    const hi = Math.max(this.anchor, this.cursor);
    return { lo, hi };
  }

  selectedText() {
    const { lo, hi } = this.span();
    return this.text.slice(lo, hi);
  }

  beginSelect() {
    if (this.anchor === null) this.anchor = this.cursor;
  }

  clearSelect() {
    this.anchor = null;
  }

  collapse(delta) {
    const { lo, hi } = this.span();
    this.anchor = null;
    this.cursor = delta < 0 ? lo : hi;
  }

  removeSpan() {
    if (!this.hasSelect()) return false;
    const { lo, hi } = this.span();
    this.edit(this.text.slice(0, lo) + this.text.slice(hi), lo);
    return true;
  }

  edit(nextText, nextCursor) {
    this.undo.push(this.snapshot());
    if (this.undo.length > UNDO_CAP) this.undo.shift();
    this.redo = [];
    this.text = nextText;
    this.cursor = nextCursor;
    this.anchor = null;
  }

  insert(chunk) {
    this.wantCol = null;
    const { lo, hi } = this.span();
    const next = this.text.slice(0, lo) + chunk + this.text.slice(hi);
    this.edit(next, lo + chunk.length);
  }

  replace(text) {
    this.wantCol = null;
    this.edit(text, text.length);
  }

  place(offset) {
    this.wantCol = null;
    this.anchor = null;
    this.cursor = clamp(offset, 0, this.text.length);
  }

  backspace() {
    this.wantCol = null;
    if (this.removeSpan()) return;
    const { parts, i, pos } = graphemeIndex(this.text, this.cursor);
    if (i === 0) return;
    const size = parts[i - 1].length;
    const next = this.text.slice(0, pos - size) + this.text.slice(pos);
    this.edit(next, this.cursor - size);
  }

  delete() {
    this.wantCol = null;
    if (this.removeSpan()) return;
    const { parts, i, pos } = graphemeIndex(this.text, this.cursor);
    if (i >= parts.length) return;
    const next =
      this.text.slice(0, pos) + this.text.slice(pos + parts[i].length);
    this.edit(next, this.cursor);
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
    const line = before.split('\n').length - 1;
    const col = before.length - before.lastIndexOf('\n') - 1;
    return { line, col };
  }

  visibleLineCol() {
    const { col, line } = this.linePos();
    const row = this.text.split('\n')[line];
    return visibleWidth(row.slice(0, col));
  }

  reveal(width) {
    const col = this.visibleLineCol();
    const room = Math.max(1, width);
    if (col < this.scrollCol) this.scrollCol = col;
    if (col >= this.scrollCol + room) this.scrollCol = col - room + 1;
  }

  moveLine(delta, width, extend) {
    if (extend) this.beginSelect();
    else this.clearSelect();
    if (width !== undefined) {
      const moved = wrapMove(
        this.text,
        this.cursor,
        width,
        delta,
        this.wantCol,
      );
      this.wantCol = moved.col;
      this.cursor = moved.cursor;
      return;
    }
    const rows = this.text.split('\n');
    const { line, col } = this.linePos();
    const next = clamp(line + delta, 0, rows.length - 1);
    if (next === line) return;
    let cursor = 0;
    for (let i = 0; i < next; i++) cursor += rows[i].length + 1;
    this.cursor = cursor + Math.min(col, rows[next].length);
  }

  home(extend) {
    this.wantCol = null;
    if (extend) this.beginSelect();
    else this.clearSelect();
    this.cursor -= this.linePos().col;
  }

  end(extend) {
    this.wantCol = null;
    if (extend) this.beginSelect();
    else this.clearSelect();
    const { line, col } = this.linePos();
    this.cursor += this.text.split('\n')[line].length - col;
  }

  undoEdit() {
    if (!this.undo.length) return;
    this.wantCol = null;
    this.redo.push(this.snapshot());
    this.restore(this.undo.pop());
  }

  redoEdit() {
    if (!this.redo.length) return;
    this.wantCol = null;
    this.undo.push(this.snapshot());
    this.restore(this.redo.pop());
  }
}

module.exports = { Editor };
