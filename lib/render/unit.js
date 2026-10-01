'use strict';

const detect = require('../detect.js');
const diffLib = require('../diff/diff.js');
const primitives = require('./primitives.js');
const diff = require('./diff.js');

const { detectLang } = detect;
const { sameHunk } = diffLib;
const { paneResult } = primitives;
const { paintDiffLine, expandSoftRows, codeHits } = diff;

const paintBodyUnit = (view, width, color) => {
  const { item, codeOverlay: overlay } = view;
  const lang = detectLang(view.reviewPath ?? '');
  const editing =
    view.mode === 'compose' && typeof overlay?.cursor === 'number';
  const scrollCol = (editing ? overlay.scrollCol : 0) ?? 0;
  const lines = view.unitLines ?? [];
  const source = editing ? lines : expandSoftRows(lines, width, false, true);
  const body = source.map((line) => {
    const changed = line.type === 'add' || line.type === 'del';
    const outside = changed && !(item && sameHunk(line.item, item));
    const row = editing || outside ? { ...line, mark: ' ' } : line;
    return paintDiffLine(row, width, color, row.origin, lang, scrollCol);
  });
  const hits = codeHits(source, false, width, overlay, editing, scrollCol);
  return paneResult({ body, ...hits });
};

module.exports = { paintBodyUnit };
