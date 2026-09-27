'use strict';

const nodeTest = require('node:test');
const { test } = nodeTest;
const assert = require('node:assert/strict');

const editor = require('../lib/editor.js');
const { Editor } = editor;

test('insert and backspace at cursor', () => {
  const editor = new Editor();
  editor.insert('ab');
  assert.equal(editor.text, 'ab');
  assert.equal(editor.cursor, 2);
  editor.move(-1);
  editor.insert('X');
  assert.equal(editor.text, 'aXb');
  editor.backspace();
  assert.equal(editor.text, 'ab');
  assert.equal(editor.cursor, 1);
});

test('undo and redo restore text and cursor', () => {
  const editor = new Editor('hi');
  editor.insert('!');
  assert.equal(editor.text, 'hi!');
  editor.undoEdit();
  assert.equal(editor.text, 'hi');
  assert.equal(editor.cursor, 2);
  editor.redoEdit();
  assert.equal(editor.text, 'hi!');
});

test('newline and line movement', () => {
  const editor = new Editor('ab');
  editor.home();
  editor.end();
  assert.equal(editor.cursor, 2);
  editor.insert('\n');
  editor.insert('cd');
  assert.equal(editor.text, 'ab\ncd');
  editor.moveLine(-1);
  assert.equal(editor.linePos().line, 0);
  editor.moveLine(1);
  assert.equal(editor.linePos().line, 1);
});

test('moveLine with width follows visual wrap', () => {
  const editor = new Editor('hello world');
  editor.home();
  assert.equal(editor.cursor, 0);
  editor.moveLine(1, 8);
  assert.equal(editor.cursor, 6);
  editor.moveLine(-1, 8);
  assert.equal(editor.cursor, 0);
  editor.end();
  editor.moveLine(-1, 8);
  assert.equal(editor.cursor, 5);
  editor.moveLine(1, 8);
  assert.equal(editor.cursor, 11);
  editor.moveLine(-20, 8);
  assert.equal(editor.cursor, 5);
});

test('reveal keeps the cursor column on screen', () => {
  const editor = new Editor('abcdefghijklmnopqrstuvwxyz');
  editor.reveal(10);
  assert.equal(editor.scrollCol, 17);
  editor.move(-1);
  editor.reveal(10);
  assert.equal(editor.scrollCol, 17);
  editor.home();
  editor.reveal(10);
  assert.equal(editor.scrollCol, 0);
});

test('moveWord jumps by identifier', () => {
  const editor = new Editor('hello world.foo');
  editor.home();
  editor.moveWord(1);
  assert.equal(editor.cursor, 5);
  editor.moveWord(1);
  assert.equal(editor.cursor, 11);
  editor.moveWord(1);
  assert.equal(editor.cursor, 15);
  editor.moveWord(1);
  assert.equal(editor.cursor, 15);
  editor.moveWord(-1);
  assert.equal(editor.cursor, 12);
  editor.moveWord(-1);
  assert.equal(editor.cursor, 6);
  editor.moveWord(-1);
  assert.equal(editor.cursor, 0);
});
