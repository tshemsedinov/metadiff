'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { captureBaseline, mergeReview } = require('../lib/review-merge.js');

const todo = (id, text, done = false) => ({ id, file: 'TODO', text, done });

const storeWith = (tasks) => {
  const store = {
    status: 'partial',
    tasks,
    nextTaskId: 100,
    feedback: new Map(),
    code: new Map(),
  };
  captureBaseline(store);
  return store;
};

const disk = (tasks) => ({
  status: 'partial',
  tasks,
  feedback: new Map(),
  code: new Map(),
});

const texts = (store) => store.tasks.map((item) => [item.text, item.done]);

test('mergeReview keeps our done change when disk deleted the todo', () => {
  const store = storeWith([todo(1, 'a'), todo(2, 'b')]);
  store.tasks[0] = todo(1, 'a', true);
  mergeReview(store, disk([todo(0, 'b')]));
  assert.deepEqual(texts(store), [
    ['a', true],
    ['b', false],
  ]);
});

test('mergeReview takes disk done change for a todo we deleted', () => {
  const store = storeWith([todo(1, 'a'), todo(2, 'b')]);
  store.tasks = [todo(2, 'b')];
  mergeReview(store, disk([todo(0, 'a', true), todo(0, 'b')]));
  assert.deepEqual(texts(store), [
    ['a', true],
    ['b', false],
  ]);
  assert.equal(store.tasks[0].id, 100);
});

test('mergeReview drops todos deleted on one side and unchanged', () => {
  const store = storeWith([todo(1, 'a'), todo(2, 'b'), todo(3, 'c')]);
  store.tasks = [todo(1, 'a'), todo(3, 'c')];
  mergeReview(store, disk([todo(0, 'b'), todo(0, 'c')]));
  assert.deepEqual(texts(store), [['c', false]]);
});

test('mergeReview puts a disk rename in place of our todo', () => {
  const store = storeWith([todo(1, 'a'), todo(2, 'b')]);
  mergeReview(store, disk([todo(0, 'a2'), todo(0, 'b')]));
  assert.deepEqual(texts(store), [
    ['a2', false],
    ['b', false],
  ]);
  assert.equal(store.tasks[0].id, 1);
});

test('mergeReview inserts new disk todos next to their neighbours', () => {
  const store = storeWith([todo(1, 'b')]);
  store.tasks.push(todo(3, 'e'));
  mergeReview(store, disk([todo(0, 'a'), todo(0, 'b'), todo(0, 'c')]));
  assert.deepEqual(
    store.tasks.map((item) => item.text),
    ['a', 'b', 'c', 'e'],
  );
});
