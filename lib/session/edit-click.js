'use strict';

const { indexAtRow } = require('../wrap.js');
const { codeInnerWidth, activeDigits } = require('../render/diff.js');

const hitAt = (hits, cell) => {
  for (const hit of hits) {
    if (hit.y !== cell.y) continue;
    const x0 = hit.x0 ?? hit.textX;
    if (cell.x < x0) continue;
    if (hit.x1 !== undefined && cell.x >= hit.x1) continue;
    return hit;
  }
  return null;
};

const offsetOf = (hit, cellX) => {
  const shown = cellX - hit.textX;
  const col = Math.max(0, shown) + (hit.scroll || 0);
  const at = indexAtRow(hit.start || 0, hit.text, col);
  if (hit.limit !== undefined && at > hit.limit) return hit.limit;
  return at;
};

const revealCode = (ui) => {
  const kind = ui.composeKind;
  if (kind !== 'code' && kind !== 'file') return;
  const size = ui.lastSize ?? ui.getSize();
  const digits = activeDigits(ui);
  ui.editor.reveal(codeInnerWidth(size.width, ui.layout, digits));
};

const focusField = (ui, hit) => {
  if (!hit.field || !ui.npm) return true;
  if (hit.field === ui.npm.editField) return true;
  return ui.npm.focusField(hit.field);
};

const placeClick = (ui, cell) => {
  if (ui.mode !== 'compose' || !ui.editor) return false;
  const hits = ui.lastFrame && ui.lastFrame.editHits;
  if (!hits || !hits.length) return false;
  const hit = hitAt(hits, cell);
  if (!hit) return false;
  if (!focusField(ui, hit)) {
    ui.paint();
    return true;
  }
  ui.editor.place(offsetOf(hit, cell.x));
  revealCode(ui);
  ui.paint();
  return true;
};

module.exports = { placeClick };
