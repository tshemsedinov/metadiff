'use strict';

const chrome = require('./chrome.js');
const notes = require('./notes.js');
const diff = require('./diff.js');
const present = require('./present.js');
const frame = require('./frame.js');
const { renderFrame } = frame;

const { QUIT_PROMPT, PUSH_PROMPT } = chrome;
const { updatePrompt, dropPrompt } = chrome;
const { formatBusyStatus, headerText, layoutButtons } = chrome;
const { delCharBg, addCharBg, paintDiffLine, codeInnerWidth } = diff;
const { todoInnerWidth, todoBodyWidth, noteInnerWidth } = notes;
const { presentCursor, presentRows } = present;

module.exports = {
  QUIT_PROMPT,
  PUSH_PROMPT,
  updatePrompt,
  dropPrompt,
  delCharBg,
  addCharBg,
  paintDiffLine,
  headerText,
  layoutButtons,
  todoInnerWidth,
  todoBodyWidth,
  noteInnerWidth,
  codeInnerWidth,
  formatBusyStatus,
  renderFrame,
  presentCursor,
  presentRows,
};
