'use strict';

const { detectLang } = require('../detect.js');
const { sameHunk } = require('../diff/diff.js');
const { paneResult } = require('./primitives.js');
const {
  paintDiffLine,
  expandSoftRows,
  codeHits,
  viewDigits,
} = require('./diff.js');

const paintBodyUnit = (view, width, color) => {
  const { item, codeOverlay: overlay } = view;
  const lang = detectLang(view.reviewPath ?? '');
  const editing =
    view.mode === 'compose' && typeof overlay?.cursor === 'number';
  const scrollCol = (editing ? overlay.scrollCol : 0) ?? 0;
  const lines = view.unitLines ?? [];
  const digits = viewDigits(view);
  const source = editing
    ? lines
    : expandSoftRows(lines, width, false, true, digits);
  const body = source.map((line) => {
    const changed = line.type === 'add' || line.type === 'del';
    const outside = changed && !(item && sameHunk(line.item, item));
    const row = editing || outside ? { ...line, mark: ' ' } : line;
    return paintDiffLine(
      row,
      width,
      color,
      row.origin,
      lang,
      scrollCol,
      digits,
    );
  });
  const hits = codeHits(
    source,
    false,
    width,
    overlay,
    editing,
    scrollCol,
    digits,
  );
  return paneResult({ body, ...hits });
};

module.exports = { paintBodyUnit };
