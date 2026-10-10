'use strict';

const { Editor } = require('../editor.js');
const { isTextKey } = require('../keys.js');
const clipboard = require('../clipboard.js');

const copyLine = (editor, ui) => {
  const text = editor.selectedText();
  if (!text) return;
  const ok = clipboard.copyText(text, ui.stdout);
  ui.status = ok ? 'copied' : 'copy failed';
};

const cutLine = (editor, ui) => {
  if (!editor.hasSelect()) return;
  copyLine(editor, ui);
  editor.removeSpan();
};

const pasteLine = (editor) => {
  const raw = clipboard.pasteText() ?? '';
  const text = `${raw}`.replaceAll('\r', '').replaceAll('\n', '');
  if (text) editor.insert(text);
};

const LINE_OP = {
  left: (editor) => editor.move(-1),
  right: (editor) => editor.move(1),
  'shift-left': (editor) => editor.move(-1, true),
  'shift-right': (editor) => editor.move(1, true),
  'ctrl-left': (editor) => editor.moveWord(-1),
  'ctrl-right': (editor) => editor.moveWord(1),
  'ctrl-shift-left': (editor) => editor.moveWord(-1, true),
  'ctrl-shift-right': (editor) => editor.moveWord(1, true),
  backspace: (editor) => editor.backspace(),
  delete: (editor) => editor.delete(),
  'ctrl-x': cutLine,
  'ctrl-v': (editor) => pasteLine(editor),
};

const END_OP = {
  home: (editor) => editor.home(),
  end: (editor) => editor.end(),
  'shift-home': (editor) => editor.home(true),
  'shift-end': (editor) => editor.end(true),
};

const LINE_ENDS = { ...LINE_OP, ...END_OP };

const lineKey = (editor, key, ui, ends) => {
  if (key === 'ctrl-c') {
    copyLine(editor, ui);
    return 'caret';
  }
  const op = (ends ? LINE_ENDS : LINE_OP)[key];
  if (!op && !isTextKey(key)) return null;
  const before = editor.text;
  if (op) op(editor, ui);
  else editor.insert(key);
  return editor.text === before ? 'caret' : 'text';
};

const lineField = (name) => {
  const editor = new Editor('');
  return {
    editor,
    get [name]() {
      return editor.text;
    },
  };
};

module.exports = { lineKey, lineField };
