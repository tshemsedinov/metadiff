'use strict';

const ansi = require('./ansi.js');
const { graphemes } = ansi;
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
  }

  snapshot() {
    return { text: this.text, cursor: this.cursor };
  }

  restore(snap) {
    this.text = snap.text;
    this.cursor = snap.cursor;
  }

  edit(nextText, nextCursor) {
    this.undo.push(this.snapshot());
    if (this.undo.length > UNDO_CAP) {
      this.undo = this.undo.slice(this.undo.length - UNDO_CAP);
    }
    this.redo = [];
    this.text = nextText;
    this.cursor = nextCursor;
  }

  insert(chunk) {
    this.wantCol = null;
    const before = this.text.slice(0, this.cursor);
    const after = this.text.slice(this.cursor);
    this.edit(before + chunk + after, this.cursor + chunk.length);
  }

  replace(text) {
    this.wantCol = null;
    this.edit(text, text.length);
  }

  backspace() {
    this.wantCol = null;
    const { parts, i } = graphemeIndex(this.text, this.cursor);
    if (i === 0) return;
    const drop = parts[i - 1];
    const nextParts = [...parts.slice(0, i - 1), ...parts.slice(i)];
    this.edit(nextParts.join(''), this.cursor - drop.length);
  }

  delete() {
    this.wantCol = null;
    const { parts, i } = graphemeIndex(this.text, this.cursor);
    if (i >= parts.length) return;
    const nextParts = [...parts.slice(0, i), ...parts.slice(i + 1)];
    this.edit(nextParts.join(''), this.cursor);
  }

  move(delta) {
    this.wantCol = null;
    const { parts, i } = graphemeIndex(this.text, this.cursor);
    const next = i + delta;
    if (next < 0 || next > parts.length) return;
    this.cursor = offsetAt(parts, next);
  }

  moveWord(delta) {
    this.wantCol = null;
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

  moveLine(delta, width) {
    if (width !== undefined) {
      const col = this.wantCol;
      const moved = wrapMove(this.text, this.cursor, width, delta, col);
      this.wantCol = moved.col;
      this.cursor = moved.cursor;
      return;
    }
    const rows = this.text.split('\n');
    const { line, col } = this.linePos();
    const next = line + delta;
    if (next < 0 || next >= rows.length) return;
    const row = rows[next];
    const c = Math.min(col, row.length);
    let cursor = 0;
    for (let i = 0; i < next; i++) cursor += rows[i].length + 1;
    this.cursor = cursor + c;
  }

  home() {
    this.wantCol = null;
    const { col } = this.linePos();
    this.cursor -= col;
  }

  end() {
    this.wantCol = null;
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
