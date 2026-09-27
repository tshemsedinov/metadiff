'use strict';

const detect = require('../detect.js');
const { detectLang } = detect;
const primitives = require('./primitives.js');
const diff = require('./diff.js');

const { paneResult } = primitives;
const { paintDiffLine, codeCursorInRows, expandSoftRows } = diff;
const diffLib = require('../diff/diff.js');
const { sameHunk } = diffLib;

const paintBodyUnit = (view, width, color) => {
  const lines = view.unitLines ?? [];
  const item = view.item;
  const lang = detectLang(view.reviewPath ?? '');
  const overlay = view.codeOverlay;
  const editing =
    view.mode === 'compose' && overlay && typeof overlay.cursor === 'number';
  const picked = editing ? overlay.scrollCol : 0;
  const scrollCol = picked ?? 0;
  const source = editing ? lines : expandSoftRows(lines, width, false, true);
  const { length } = source;
  const body = new Array(length);
  for (let i = 0; i < length; i++) {
    const line = source[i];
    const isBlock = item && sameHunk(line.item, item);
    const row = { ...line };
    if (editing) {
      row.mark = ' ';
    } else if ((row.type === 'add' || row.type === 'del') && !isBlock) {
      row.mark = ' ';
    }
    body[i] = paintDiffLine(row, width, color, row.origin, lang, scrollCol);
  }
  const edit = overlay ? overlay.cursor : null;
  const cursor = codeCursorInRows(source, false, width, edit, scrollCol);
  return paneResult({
    body,
    cursor,
  });
};

module.exports = { paintBodyUnit };
