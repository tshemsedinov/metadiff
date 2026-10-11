'use strict';

const { clamp } = require('../common/utilities.js');
const ansi = require('../term/ansi.js');
const { listWindowStart, scrollMark } = require('./primitives.js');
const { THEME, paint, visibleWidth, trimVisible } = ansi;

const menuBoxWidth = (options, columnW, room) => {
  let widest = Math.max(columnW, 4);
  for (const label of options) {
    widest = Math.max(widest, visibleWidth(`${label ?? ''}`));
  }
  return clamp(widest + 2, 4, room);
};

const menuItem = (label, boxW, color, selected, mark, disabled) => {
  const barW = mark ? 1 : 0;
  const faceW = Math.max(1, boxW - barW);
  const room = Math.max(0, faceW - 1);
  const shown = trimVisible(`${label ?? ''}`, room);
  const pad = ' '.repeat(Math.max(0, room - visibleWidth(shown)));
  const face = ` ${shown}${pad}`;
  if (!color) return `${face}${' '.repeat(barW)}`;
  const hot = selected && !disabled;
  const fgRgb = disabled ? THEME.mutedFg : THEME.chromeFg;
  const hotFg = hot ? THEME.buttonHotFg : fgRgb;
  const bgRgb = hot ? THEME.checkBg : THEME.noteBg;
  let row = paint(face, hotFg, bgRgb, color, hot);
  if (!mark) return row;
  const barBg = mark === 'thumb' ? THEME.taskHeadBg : THEME.buttonBg;
  row += paint(' ', fgRgb, barBg, color);
  return row;
};

const dropBox = (options, cursor, scroll, room) => {
  const count = options.length;
  const focus = count ? clamp(cursor ?? 0, 0, count - 1) : 0;
  const inner = Math.max(1, Math.min(count || 1, room, 8));
  const start = listWindowStart(focus, scroll, inner, count);
  return { focus, inner, span: inner, start, count };
};

const menuFaces = (options, box, boxW, color, off = new Set()) => {
  const faces = [];
  for (let i = 0; i < box.inner; i++) {
    const index = box.start + i;
    const label = options[index];
    const mark = scrollMark(i, box.count, box.inner, box.start);
    const disabled = label !== undefined && off.has(label);
    const face =
      label === undefined
        ? menuItem('none', boxW, color, false, mark, false)
        : menuItem(label, boxW, color, index === box.focus, mark, disabled);
    faces.push({ index, face });
  }
  return faces;
};

module.exports = { menuBoxWidth, dropBox, menuFaces };
