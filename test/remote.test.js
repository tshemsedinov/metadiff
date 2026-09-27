'use strict';

const nodeTest = require('node:test');
const { test } = nodeTest;
const assert = require('node:assert/strict');

const remote = require('../lib/remote.js');
const { createTransport, parseLinkNext, parseNextPage, noteFromLocation } =
  remote;
const diff = require('../lib/diff/diff.js');
const { parseDiff, itemsFromFiles } = diff;

const DIFF = `diff --git a/lib/parser.js b/lib/parser.js
index 1111111..2222222 100644
--- a/lib/parser.js
+++ b/lib/parser.js
@@ -1,3 +1,4 @@
 keep
-old
+new
 keep
`;

const requestPolicy = {
  retry: { attempts: 1 },
  isRetryable: () => false,
  wrapNetwork: (error) => error,
  missingFetch: () => new Error('fetch is not available'),
  toHttpError: (status, body) => {
    const error = new Error(`${body || status}`);
    error.status = status;
    return error;
  },
  parsePage: (text) => JSON.parse(text),
};

const jsonOk = (body, headers = {}) => ({
  ok: true,
  status: 200,
  headers,
  text: async () => body,
});

test('abort stops retry wait', async () => {
  const ac = new AbortController();
  const transport = createTransport({
    fetch: async () => {
      throw new Error('reset');
    },
    signal: ac.signal,
  });
  const pending = transport.request('https://example.test/x', {
    ...requestPolicy,
    retry: { attempts: 3, delayMs: 30_000 },
    isRetryable: () => true,
  });
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  const started = Date.now();
  ac.abort();
  await assert.rejects(
    pending,
    (error) => error.name === 'AbortError' || ac.signal.aborted,
  );
  assert.ok(Date.now() - started < 1000);
});

test('request passes abort signal to fetch', async () => {
  const ac = new AbortController();
  let received;
  const transport = createTransport({
    fetch: async (_url, init) => {
      received = init.signal;
      return jsonOk('ok');
    },
    signal: ac.signal,
  });
  await transport.request('https://example.test/x', requestPolicy);
  assert.equal(received, ac.signal);
});

test('listPages follows Link rel=next', async () => {
  const calls = [];
  const pages = new Map([
    [
      'https://api.test/items',
      jsonOk('[{"id":1}]', {
        Link: '<https://api.test/items?page=2>; rel="next"',
      }),
    ],
    ['https://api.test/items?page=2', jsonOk('[{"id":2}]')],
  ]);
  const transport = createTransport({
    fetch: async (url) => {
      calls.push(`${url}`);
      return pages.get(`${url}`);
    },
  });
  const items = await transport.listPages('https://api.test/items', {
    ...requestPolicy,
    nextPage: (headers) => parseLinkNext(headers),
  });
  assert.deepEqual(items, [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(calls, [
    'https://api.test/items',
    'https://api.test/items?page=2',
  ]);
});

test('listPages falls back to x-next-page', async () => {
  const calls = [];
  const transport = createTransport({
    fetch: async (url) => {
      calls.push(`${url}`);
      if (`${url}` === 'https://api.test/items') {
        return jsonOk('[{"id":1}]', { 'x-next-page': '2' });
      }
      return jsonOk('[{"id":2}]');
    },
  });
  const items = await transport.listPages('https://api.test/items', {
    ...requestPolicy,
    nextPage: parseNextPage,
  });
  assert.deepEqual(items, [{ id: 1 }, { id: 2 }]);
  assert.equal(calls[1], 'https://api.test/items?page=2');
});

test('parseNextPage prefers Link over x-next-page', () => {
  const next = parseNextPage(
    {
      Link: '<https://api.test/items?page=3>; rel="next"',
      'x-next-page': '2',
    },
    'https://api.test/items',
  );
  assert.equal(next, 'https://api.test/items?page=3');
});

test('noteFromLocation maps RIGHT and LEFT lines onto feedback', () => {
  const items = itemsFromFiles(parseDiff(DIFF), 'pr');
  const right = noteFromLocation(
    items,
    { path: 'lib/parser.js', line: 2, side: 'RIGHT' },
    { reviewer: 'alice', body: 'use const' },
    'github',
    'pull request',
  );
  assert.equal(right.kind, 'feedback');
  assert.equal(right.file, 'lib/parser.js');
  const left = noteFromLocation(
    items,
    { path: 'lib/parser.js', line: 2, side: 'LEFT' },
    { reviewer: 'alice', body: 'keep old' },
    'gitlab',
    'merge request',
  );
  assert.equal(left.kind, 'feedback');
  assert.match(left.text, /keep old/);
});

test('noteFromLocation falls back to a todo when unmatched', () => {
  const items = itemsFromFiles(parseDiff(DIFF), 'pr');
  const note = noteFromLocation(
    items,
    { path: 'lib/parser.js', line: 99, side: 'RIGHT' },
    { reviewer: 'alice', body: 'orphan' },
    'github',
    'pull request',
  );
  assert.equal(note.kind, 'todo');
  assert.equal(note.file, 'lib/parser.js');
  assert.match(note.text, /orphan/);
  const noPath = noteFromLocation(
    items,
    { path: '', line: 2, side: 'RIGHT' },
    { reviewer: 'bob', body: 'general' },
    'github',
    'pull request',
  );
  assert.equal(noPath.kind, 'todo');
  assert.equal(noPath.file, 'pull request');
});
