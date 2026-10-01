'use strict';

const addBlockRange = (hunk, blockId) => {
  let newLine = hunk.newStart;
  let start = 0;
  let count = 0;
  for (const line of hunk.lines) {
    if (line.type === 'del') {
      if (line.blockId === blockId && start === 0) start = newLine;
      continue;
    }
    if (line.type === 'add' && line.blockId === blockId) {
      if (count === 0) start = newLine;
      count += 1;
    }
    newLine += 1;
  }
  if (start === 0) start = hunk.newStart;
  return { start, count };
};

const replaceBlockAdds = (content, hunk, blockId, text) => {
  const range = addBlockRange(hunk, blockId);
  const ended = content.endsWith('\n');
  const body = ended ? content.slice(0, -1) : content;
  const lines = content === '' ? [] : body.split('\n');
  const from = Math.min(lines.length, Math.max(0, range.start - 1));
  const added = text === '' ? [] : text.split('\n');
  lines.splice(from, range.count, ...added);
  return lines.join('\n') + (ended ? '\n' : '');
};

module.exports = { addBlockRange, replaceBlockAdds };
