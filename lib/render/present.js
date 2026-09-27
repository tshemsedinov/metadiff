'use strict';

const ansi = require('../ansi.js');
const { ESC } = ansi;

const presentCursor = (cursor) => {
  if (!cursor || cursor.x <= 0 || cursor.y <= 0) return `${ESC}[?25l`;
  const pos = `${ESC}[${cursor.y};${cursor.x}H`;
  return `${pos}${ESC}[1 q${ESC}[?12h${ESC}[?25h`;
};

const presentRows = (rows, options = {}) => {
  const clear = options.clear === true;
  const cursor = options.cursor;
  const parts = [`${ESC}[?25l`, `${ESC}[?2026h`];
  if (clear) parts.push(`${ESC}[H${ESC}[2J`);
  for (let i = 0; i < rows.length; i++) {
    parts.push(`${ESC}[${i + 1};1H`);
    parts.push(rows[i]);
  }
  parts.push(`${ESC}[?2026l`);
  parts.push(presentCursor(cursor));
  return parts.join('');
};

module.exports = { presentCursor, presentRows };
