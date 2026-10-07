'use strict';

const { isCtxType, attachInline, LAYOUT_ALIGN } = require('./align.js');
const { flattenBlock } = require('./patch.js');

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
    if (!isCtxType(lines[i].type)) return i + 1;
  }
  return lines.length;
};

const taggedAdds = (text, blockId) => {
  const tagged = [];
  let offset = 0;
  for (const row of text.split('\n')) {
    tagged.push({
      type: 'add',
      text: row,
      noNl: false,
      blockId,
      wrap: true,
      editStart: offset,
      editEnd: offset + row.length,
      editLast: true,
    });
    offset += row.length + 1;
  }
  return tagged;
};

const replaceAdds = (lines, overlay, blockId) => {
  if (overlay.text === '' && !overlay.keepEmpty) {
    return lines.filter((line) => line.type !== 'add');
  }
  const tagged = taggedAdds(overlay.text, blockId);
  const out = [];
  let placed = 0;
  let lastAdd = -1;
  for (const line of lines) {
    if (line.type !== 'add') {
      out.push(line);
      continue;
    }
    if (placed >= tagged.length) continue;
    out.push(tagged[placed++]);
    lastAdd = out.length - 1;
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
    if (line.type === 'add' && line.blockId === blockId) parts.push(line.text);
  }
  return parts.join('\n');
};

const displayLines = (hunk, blockId, layout = 'unified', radius, overlay) => {
  const flat = flattenBlock(hunk, blockId, 'new');
  const source = overlay ? replaceAdds(flat, overlay, blockId) : flat;
  const around = radius ?? DISPLAY_CONTEXT;
  const painted = attachInline(windowAroundBlock(source, blockId, around));
  const alignRows = LAYOUT_ALIGN[layout];
  return alignRows ? alignRows(painted) : painted;
};

module.exports = { DISPLAY_CONTEXT, displayLines, blockAddText };
