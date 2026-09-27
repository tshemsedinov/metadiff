'use strict';

const align = require('./align.js');
const { isCtxType, attachInline, LAYOUT_ALIGN } = align;
const patch = require('./patch.js');
const { flattenBlock } = patch;

const DISPLAY_CONTEXT = 3;

const windowAroundBlock = (lines, blockId, radius) => {
  let start = -1;
  let end = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].blockId !== blockId) continue;
    if (start < 0) start = i;
    end = i + 1;
  }
  if (start < 0) return lines;
  const from = Math.max(0, start - radius);
  const to = Math.min(lines.length, end + radius);
  return lines.slice(from, to);
};

const insertAddIndex = (lines) => {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isCtxType(lines[i].type)) continue;
    return i + 1;
  }
  return lines.length;
};

const taggedAdd = (text, blockId, start, end) => ({
  type: 'add',
  text,
  noNl: false,
  blockId,
  wrap: true,
  editStart: start,
  editEnd: end,
  editLast: true,
});

const replaceAdds = (lines, overlay, blockId) => {
  const text = overlay.text ?? '';
  const keepEmpty = overlay.keepEmpty === true;
  if (text === '' && !keepEmpty) {
    return lines.filter((line) => line.type !== 'add');
  }
  const texts = text.split('\n');
  const { length } = texts;
  const tagged = new Array(length);
  let offset = 0;
  for (let i = 0; i < length; i++) {
    const row = texts[i];
    const start = offset;
    const end = start + row.length;
    const isLast = i === length - 1;
    tagged[i] = taggedAdd(row, blockId, start, end);
    offset = isLast ? end : end + 1;
  }
  const out = [];
  let placed = 0;
  let lastAdd = -1;
  for (const line of lines) {
    if (line.type !== 'add') {
      out.push(line);
      continue;
    }
    if (placed >= tagged.length) continue;
    out.push(tagged[placed]);
    lastAdd = out.length - 1;
    placed += 1;
  }
  const extras = tagged.slice(placed);
  if (!extras.length) return out;
  const at = lastAdd >= 0 ? lastAdd + 1 : insertAddIndex(out);
  out.splice(at, 0, ...extras);
  return out;
};

const blockAddText = (hunk, blockId) => {
  if (!hunk) return '';
  const parts = [];
  for (const line of hunk.lines) {
    if (line.type !== 'add') continue;
    if (line.blockId !== blockId) continue;
    parts.push(line.text);
  }
  return parts.join('\n');
};

const displayLines = (hunk, blockId, layout = 'unified', radius, overlay) => {
  const flat = flattenBlock(hunk, blockId, 'new');
  const source = overlay ? replaceAdds(flat, overlay, blockId) : flat;
  const around = radius ?? DISPLAY_CONTEXT;
  const windowed = windowAroundBlock(source, blockId, around);
  const painted = attachInline(windowed);
  const alignRows = LAYOUT_ALIGN[layout];
  if (alignRows) return alignRows(painted);
  return painted;
};

module.exports = { DISPLAY_CONTEXT, displayLines, blockAddText };
