'use strict';

const detect = require('../detect.js');
const { detectLang } = detect;
const primitives = require('./primitives.js');
const diff = require('./diff.js');

const { paneResult } = primitives;
const { paintDiffLine, codeCursorInRows } = diff;
const diffLib = require('../diff/diff.js');
const { sameHunk } = diffLib;

const paintBodyUnit = (view, width, color) => {
  const lines = view.unitLines ?? [];
  const item = view.item;
  const lang = detectLang(view.reviewPath ?? '');
  const overlay = view.codeOverlay;
  const editing = view.mode === 'compose' && overlay;
  const { length } = lines;
  const body = new Array(length);
  for (let i = 0; i < length; i++) {
    const line = lines[i];
    const isBlock = item && sameHunk(line.item, item);
    const row = { ...line };
    if (editing) {
      row.mark = ' ';
    } else if ((row.type === 'add' || row.type === 'del') && !isBlock) {
      row.mark = ' ';
    }
    body[i] = paintDiffLine(row, width, color, row.origin, lang);
  }
  const edit = overlay ? overlay.cursor : null;
  const cursor = codeCursorInRows(lines, false, width, edit);
  return paneResult({
    body,
    cursor,
  });
};

module.exports = { paintBodyUnit };
