'use strict';

const { ESC } = require('../ansi.js');

const presentCursor = (cursor) => {
  if (!cursor || cursor.x <= 0 || cursor.y <= 0) return `${ESC}[?25l`;
  const pos = `${ESC}[${cursor.y};${cursor.x}H`;
  return `${pos}${ESC}[1 q${ESC}[?12h${ESC}[?25h`;
};

const presentRows = (rows, options = {}) => {
  let out = `${ESC}[?25l${ESC}[?2026h`;
  if (options.clear === true) out += `${ESC}[H${ESC}[2J`;
  for (let i = 0; i < rows.length; i++) out += `${ESC}[${i + 1};1H${rows[i]}`;
  return `${out}${ESC}[?2026l${presentCursor(options.cursor)}`;
};

module.exports = { presentCursor, presentRows };
