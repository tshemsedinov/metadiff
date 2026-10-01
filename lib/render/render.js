'use strict';

const chrome = require('./chrome.js');
const notes = require('./notes.js');
const diff = require('./diff.js');
const present = require('./present.js');
const frame = require('./frame.js');

const { formatBusyStatus, headerText, layoutButtons } = chrome;
const { todoBodyWidth, noteInnerWidth } = notes;
const { paintDiffLine, codeInnerWidth } = diff;
const { presentCursor, presentRows } = present;
const { renderFrame } = frame;

module.exports = {
  formatBusyStatus,
  headerText,
  layoutButtons,
  todoBodyWidth,
  noteInnerWidth,
  paintDiffLine,
  codeInnerWidth,
  renderFrame,
  presentCursor,
  presentRows,
};
