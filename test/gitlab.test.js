'use strict';

const nodeTest = require('node:test');
const { test } = nodeTest;
const assert = require('node:assert/strict');

const gitlab = require('../lib/gitlab.js');
const diff = require('../lib/diff/diff.js');
const { parseGitlabMrUrl, gitlabToken, loadMergeRequest } = gitlab;
const { filterChangeFiles, mrApiUrl, discussionToNotes } = gitlab;
const { formatImportedText } = gitlab;
const { parseDiff, itemsFromFiles } = diff;

const MR = {
  host: 'gitlab.com',
  project: 'acme/app',
  number: 123,
  origin: 'https://gitlab.com',
};

const MR_DIFF = `diff --git a/lib/parser.js b/lib/parser.js
index 1111111..2222222 100644
--- a/lib/parser.js
+++ b/lib/parser.js
@@ -1,3 +1,4 @@
 keep
-old
+new
 keep
diff --git a/README.md b/README.md
index 1111111..2222222 100644
--- a/README.md
+++ b/README.md
@@ -1,1 +1,1 @@
-hello
+Hello
`;

const MR_JSON = JSON.parse(`{
  "iid": 123,
  "title": "Fix parser",
  "web_url": "https://gitlab.com/acme/app/-/merge_requests/123",
  "author": { "username": "alice" },
  "target_branch": "main",
  "source_branch": "fix-parser",
  "references": { "full": "acme/app!123" }
}`);

const jsonResponse = (status, body, extraHeaders = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: extraHeaders,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const mockFetch = (json, diffText, status = 200, routes = {}) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const headers = init.headers || {};
    calls.push({
      url,
      accept: headers.Accept,
      auth: headers['PRIVATE-TOKEN'] || '',
      method: init.method || 'GET',
    });
    const href = `${url}`;
    if (href.includes('/raw_diffs')) {
      return jsonResponse(status, diffText);
    }
    if (href.includes('/discussions')) {
      const page = routes.discussions ?? [];
      const extra = routes.discussionHeaders ?? {};
      return jsonResponse(200, page, extra);
    }
    return jsonResponse(status, json);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
};

const expectedMr = {
  host: 'gitlab.com',
  project: 'acme/app',
  number: 123,
  origin: 'https://gitlab.com',
};

test('parseGitlabMrUrl reads gitlab merge request URLs', () => {
  const urls = [
    'https://gitlab.com/acme/app/-/merge_requests/123',
    'https://gitlab.com/acme/app/-/merge_requests/123/',
    'https://gitlab.com/acme/app/-/merge_requests/123/diffs',
    'https://gitlab.com/acme/app/-/merge_requests/123/commits',
    'https://www.gitlab.com/acme/app/-/merge_requests/123',
    'http://gitlab.com/acme/app/-/merge_requests/123',
    'gitlab.com/acme/app/-/merge_requests/123',
    'https://gitlab.com/acme/app/-/merge_requests/123.diff',
    'https://gitlab.com/acme/app/-/merge_requests/123.patch',
    'https://gitlab.com/acme/app/-/merge_requests/123/diffs?w=1',
    'https://gitlab.com/acme/app/-/merge_requests/123#note_9',
    'https://gitlab.com/acme/app/merge_requests/123',
  ];
  for (const url of urls) {
    const parsed = parseGitlabMrUrl(url);
    assert.equal(parsed.host, expectedMr.host, url);
    assert.equal(parsed.project, expectedMr.project, url);
    assert.equal(parsed.number, expectedMr.number, url);
    assert.match(parsed.origin, /^https?:\/\/gitlab\.com$/, url);
  }
});

test('parseGitlabMrUrl reads nested groups and self-hosted hosts', () => {
  const nested = parseGitlabMrUrl(
    'https://gitlab.example.com/group/sub/app/-/merge_requests/9',
  );
  assert.deepEqual(nested, {
    host: 'gitlab.example.com',
    project: 'group/sub/app',
    number: 9,
    origin: 'https://gitlab.example.com',
  });
});

test('parseGitlabMrUrl rejects non merge request URLs', () => {
  const urls = [
    '',
    'lib/parser.js',
    'https://gitlab.com/acme/app',
    'https://gitlab.com/acme/app/-/issues/123',
    'https://gitlab.com/acme/app/-/merge_requests',
    'https://github.com/acme/app/pull/123',
    'https://gitlab.com/acme/app/-/merge_requests/0',
  ];
  for (const url of urls) {
    assert.equal(parseGitlabMrUrl(url), null, url);
  }
});

test('gitlabToken reads GITLAB_TOKEN then GL_TOKEN', () => {
  assert.equal(gitlabToken({ GITLAB_TOKEN: 'a', GL_TOKEN: 'b' }), 'a');
  assert.equal(gitlabToken({ GL_TOKEN: 'b' }), 'b');
  assert.equal(gitlabToken({}), '');
});

const DEP_MR_DIFF = `diff --git a/package.json b/package.json
index 1111111..2222222 100644
--- a/package.json
+++ b/package.json
@@ -1,6 +1,6 @@
 {
   "name": "demo",
   "dependencies": {
-    "lodash": "^4.17.20"
+    "lodash": "^4.17.21"
   }
 }
diff --git a/package-lock.json b/package-lock.json
index 1111111..2222222 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,8 +1,8 @@
 {
   "lockfileVersion": 3,
   "packages": {
     "node_modules/lodash": {
-      "version": "4.17.20"
+      "version": "4.17.21"
     }
   }
 }
`;

test('loadMergeRequest converts a GitLab patch into pr items', async () => {
  const fetchImpl = mockFetch(MR_JSON, MR_DIFF);
  const loaded = await loadMergeRequest(MR, {
    fetch: fetchImpl,
    token: '',
    cwd: '/tmp',
  });
  assert.equal(fetchImpl.calls.length, 3);
  const url = mrApiUrl(MR);
  assert.equal(fetchImpl.calls[0].url, url);
  assert.equal(loaded.sourceLabel, '!123');
  assert.equal(loaded.change.title, 'Fix parser');
  assert.equal(loaded.change.author, 'alice');
  assert.equal(loaded.change.repository, 'acme/app');
  assert.equal(loaded.change.base, 'main');
  assert.equal(loaded.change.head, 'fix-parser');
  assert.equal(loaded.change.number, 123);
  assert.equal(loaded.change.source, 'mr');
  assert.deepEqual(loaded.change.files, ['lib/parser.js', 'README.md']);
  assert.equal(loaded.items.length, 2);
  assert.equal(loaded.items[0].origin, 'pr');
  assert.equal(loaded.items[0].file.newPath, 'lib/parser.js');
  assert.ok(loaded.items[0].hunk);
  assert.equal(loaded.items[1].file.newPath, 'README.md');
  assert.deepEqual(loaded.imported, { feedback: [], todos: [] });
});

test('mrApiUrl encodes nested project paths', () => {
  const nested = {
    host: 'gitlab.example.com',
    project: 'group/sub/app',
    number: 9,
    origin: 'https://gitlab.example.com',
  };
  const url = mrApiUrl(nested);
  const encoded = 'group%2Fsub%2Fapp';
  const expected =
    `https://gitlab.example.com/api/v4/projects/${encoded}` +
    '/merge_requests/9';
  assert.equal(url, expected);
});

test('loadMergeRequest folds package.json and lockfile changes', async () => {
  const fetchImpl = mockFetch(MR_JSON, DEP_MR_DIFF);
  const loaded = await loadMergeRequest(MR, {
    fetch: fetchImpl,
    token: '',
    cwd: '/tmp',
  });
  assert.deepEqual(loaded.change.files, ['package.json', 'package-lock.json']);
  assert.equal(loaded.items.length, 1);
  assert.ok(loaded.items[0].dep);
  const hunkLines = loaded.items[0].hunk.lines;
  const lines = hunkLines.map((line) => line.text);
  assert.equal(lines[0], 'Dependencies in package.json & package-lock.json');
  assert.ok(lines.includes('dependency version changed'));
});

test('loadMergeRequest sends a private token', async () => {
  const fetchImpl = mockFetch(MR_JSON, MR_DIFF);
  await loadMergeRequest(MR, { fetch: fetchImpl, token: 'secret' });
  assert.ok(fetchImpl.calls.length >= 2);
  for (const call of fetchImpl.calls) {
    assert.equal(call.auth, 'secret');
  }
});

test('loadMergeRequest filters files by path scope', async () => {
  const fetchImpl = mockFetch(MR_JSON, MR_DIFF);
  const loaded = await loadMergeRequest(MR, {
    fetch: fetchImpl,
    token: '',
    paths: ['lib'],
  });
  assert.deepEqual(loaded.change.files, ['lib/parser.js']);
  assert.equal(loaded.items.length, 1);
  assert.equal(loaded.items[0].file.newPath, 'lib/parser.js');
});

test('filterChangeFiles keeps matching paths', () => {
  const files = [
    { newPath: 'lib/a.js', oldPath: 'lib/a.js' },
    { newPath: 'README.md', oldPath: 'README.md' },
  ];
  const kept = filterChangeFiles(files, ['lib']);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].newPath, 'lib/a.js');
});

test('loadMergeRequest maps 404 to a not found error', async () => {
  const fetchImpl = mockFetch({ message: '404 Not Found' }, '', 404);
  await assert.rejects(
    () => loadMergeRequest(MR, { fetch: fetchImpl, token: '' }),
    /GitLab merge request not found/,
  );
});

test('loadMergeRequest maps rate limit errors', async () => {
  const fetchImpl = mockFetch({ message: 'Retry later' }, '', 429);
  await assert.rejects(
    () =>
      loadMergeRequest(MR, {
        fetch: fetchImpl,
        token: 'tok',
        retry: { attempts: 1 },
      }),
    /rate limit exceeded/,
  );
});

test('loadMergeRequest maps network failures', async () => {
  const fetchImpl = async () => {
    const error = new Error('fetch failed');
    error.code = 'ECONNRESET';
    throw error;
  };
  await assert.rejects(
    () =>
      loadMergeRequest(MR, {
        fetch: fetchImpl,
        token: '',
        retry: { attempts: 1 },
      }),
    /GitLab request failed/,
  );
});

test('loadMergeRequest retries a transient network error', async () => {
  const base = mockFetch(MR_JSON, MR_DIFF);
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    if (calls === 1) {
      const error = new Error('fetch failed');
      error.code = 'ECONNRESET';
      throw error;
    }
    return base(url, init);
  };
  const loaded = await loadMergeRequest(MR, {
    fetch: fetchImpl,
    token: '',
    retry: { delayMs: 0 },
  });
  assert.equal(loaded.change.number, 123);
  assert.ok(calls >= 3);
});

test('loadMergeRequest rejects invalid merge request JSON', async () => {
  const fetchImpl = async (url) => {
    if (`${url}`.includes('/raw_diffs')) {
      return jsonResponse(200, MR_DIFF);
    }
    return jsonResponse(200, 'not json {');
  };
  await assert.rejects(
    () => loadMergeRequest(MR, { fetch: fetchImpl, token: '' }),
    /invalid merge request payload/,
  );
});

test('loadMergeRequest maps 401 to an auth error', async () => {
  const fetchImpl = mockFetch({ message: '401 Unauthorized' }, '', 401);
  await assert.rejects(
    () => loadMergeRequest(MR, { fetch: fetchImpl, token: 'tok' }),
    /GitLab authentication failed/,
  );
});

test('formatImportedText prefixes the GitLab reviewer', () => {
  const text = formatImportedText({
    reviewer: 'alice',
    body: 'use const',
  });
  assert.equal(text, '@alice review at gitlab: use const');
  assert.doesNotMatch(text, /source:/);
  assert.doesNotMatch(text, /\[alice\]/);
});

const inlineDiffNote = (extra = {}) => {
  const path = extra.path ?? 'lib/parser.js';
  const position = {};
  position['position_type'] = extra.positionType ?? 'text';
  position['new_path'] = path;
  position['old_path'] = path;
  position['new_line'] = extra.newLine ?? 2;
  position['old_line'] = extra.oldLine ?? null;
  return {
    id: extra.id ?? 10,
    type: 'DiffNote',
    system: false,
    author: { username: extra.username ?? 'alice' },
    body: extra.body ?? 'use const',
    resolved: extra.resolved === true,
    position,
  };
};

test('discussionToNotes maps an inline comment onto hunk feedback', () => {
  const items = itemsFromFiles(parseDiff(MR_DIFF), 'pr');
  const notes = discussionToNotes([{ notes: [inlineDiffNote()] }], items);
  assert.equal(notes.feedback.length, 1);
  assert.equal(notes.todos.length, 0);
  const note = notes.feedback[0];
  assert.equal(note.file, 'lib/parser.js');
  assert.equal(note.oldStart, 1);
  assert.equal(note.newStart, 1);
  assert.equal(note.blockId, 0);
  assert.equal(note.origin, 'pr');
  assert.equal(note.text, '@alice review at gitlab: use const');
  assert.equal(note.done, false);
});

test('discussionToNotes maps file-level and general comments to todos', () => {
  const items = itemsFromFiles(parseDiff(MR_DIFF), 'pr');
  const fileNote = inlineDiffNote({
    id: 11,
    username: 'bob',
    body: 'add types',
    positionType: 'file',
    newLine: null,
  });
  const notes = discussionToNotes(
    [
      { notes: [fileNote] },
      {
        notes: [
          {
            author: { username: 'carol' },
            body: 'Looks good overall',
            system: false,
          },
          {
            author: { username: 'carol' },
            body: '  ',
            system: false,
          },
        ],
      },
      {
        notes: [
          {
            author: { username: 'dave' },
            body: 'Please add tests',
            system: false,
          },
        ],
      },
    ],
    items,
  );
  assert.equal(notes.feedback.length, 0);
  assert.equal(notes.todos.length, 3);
  assert.equal(notes.todos[0].file, 'lib/parser.js');
  assert.match(notes.todos[0].text, /add types/);
  assert.equal(notes.todos[1].file, 'merge request');
  assert.match(notes.todos[1].text, /Looks good overall/);
  assert.match(notes.todos[2].text, /Please add tests/);
});

test('discussionToNotes skips system notes', () => {
  const items = itemsFromFiles(parseDiff(MR_DIFF), 'pr');
  const notes = discussionToNotes(
    [
      {
        notes: [
          {
            author: { username: 'alice' },
            body: 'assigned to bob',
            system: true,
          },
        ],
      },
    ],
    items,
  );
  assert.deepEqual(notes, { feedback: [], todos: [] });
});

test('discussionToNotes marks resolved inline comments done', () => {
  const items = itemsFromFiles(parseDiff(MR_DIFF), 'pr');
  const notes = discussionToNotes(
    [{ notes: [inlineDiffNote({ resolved: true })] }],
    items,
  );
  assert.equal(notes.feedback[0].done, true);
  assert.equal(notes.feedback[0].text, '@alice review at gitlab: use const');
});

test('discussionToNotes maps a later hunk block by new line', () => {
  const item0 = {
    origin: 'pr',
    file: { newPath: 'a.js', oldPath: 'a.js' },
    hunk: {
      oldStart: 1,
      oldCount: 5,
      newStart: 1,
      newCount: 5,
      header: '@@ -1,5 +1,5 @@',
      lines: [
        { type: 'ctx', text: 'keep', noNl: false, blockId: null },
        { type: 'del', text: 'a', noNl: false, blockId: 0 },
        { type: 'add', text: 'b', noNl: false, blockId: 0 },
        { type: 'ctx', text: 'mid', noNl: false, blockId: null },
        { type: 'del', text: 'c', noNl: false, blockId: 1 },
        { type: 'add', text: 'd', noNl: false, blockId: 1 },
      ],
    },
    blockId: 0,
  };
  const item1 = { ...item0, blockId: 1 };
  const notes = discussionToNotes(
    [
      {
        notes: [
          inlineDiffNote({
            path: 'a.js',
            body: 'rename d',
            newLine: 4,
          }),
        ],
      },
    ],
    [item0, item1],
  );
  assert.equal(notes.feedback.length, 1);
  assert.equal(notes.feedback[0].blockId, 1);
});

test('discussionToNotes skips empty bodies and out of scope paths', () => {
  const items = itemsFromFiles(parseDiff(MR_DIFF), 'pr');
  const notes = discussionToNotes(
    [
      { notes: [inlineDiffNote({ id: 1, username: 'a', body: '  ' })] },
      {
        notes: [
          inlineDiffNote({
            id: 2,
            username: 'a',
            body: 'readme nit',
            path: 'README.md',
            newLine: 1,
          }),
        ],
      },
      {
        notes: [
          inlineDiffNote({
            id: 3,
            username: 'a',
            body: 'parser nit',
          }),
        ],
      },
      {
        notes: [
          {
            author: { username: 'b' },
            body: 'please add tests',
            system: false,
          },
        ],
      },
    ],
    items,
    ['lib'],
  );
  assert.equal(notes.feedback.length, 1);
  assert.match(notes.feedback[0].text, /parser nit/);
  assert.equal(notes.todos.length, 1);
  assert.match(notes.todos[0].text, /please add tests/);
});

test('loadMergeRequest imports review discussion', async () => {
  const fetchImpl = mockFetch(MR_JSON, MR_DIFF, 200, {
    discussions: [
      { notes: [inlineDiffNote({ resolved: true })] },
      {
        notes: [
          {
            author: { username: 'carol' },
            body: 'Looks good overall',
            system: false,
          },
        ],
      },
      {
        notes: [
          {
            author: { username: 'dave' },
            body: 'Please add tests',
            system: false,
          },
        ],
      },
    ],
  });
  const loaded = await loadMergeRequest(MR, { fetch: fetchImpl, token: '' });
  assert.equal(loaded.imported.feedback.length, 1);
  assert.equal(loaded.imported.feedback[0].done, true);
  assert.match(loaded.imported.feedback[0].text, /use const/);
  assert.equal(loaded.imported.todos.length, 2);
});

test('loadMergeRequest paginates discussions', async () => {
  const first = inlineDiffNote({
    id: 1,
    username: 'a',
    body: 'first',
  });
  const second = inlineDiffNote({
    id: 2,
    username: 'b',
    body: 'second',
  });
  const next = `${mrApiUrl(MR)}/discussions?page=2&per_page=100`;
  let commentPages = 0;
  const base = mockFetch(MR_JSON, MR_DIFF);
  const fetchImpl = async (url, init) => {
    if (`${url}`.includes('/discussions')) {
      commentPages += 1;
      if (commentPages === 1) {
        return jsonResponse(200, [{ notes: [first] }], {
          Link: `<${next}>; rel="next"`,
        });
      }
      return jsonResponse(200, [{ notes: [second] }]);
    }
    return base(url, init);
  };
  const loaded = await loadMergeRequest(MR, { fetch: fetchImpl, token: '' });
  assert.equal(commentPages, 2);
  assert.equal(loaded.imported.feedback.length, 2);
  assert.match(loaded.imported.feedback[0].text, /first/);
  assert.match(loaded.imported.feedback[1].text, /second/);
});

test('loadMergeRequest paginates with x-next-page', async () => {
  const first = inlineDiffNote({
    id: 1,
    username: 'a',
    body: 'first',
  });
  const second = inlineDiffNote({
    id: 2,
    username: 'b',
    body: 'second',
  });
  let commentPages = 0;
  const base = mockFetch(MR_JSON, MR_DIFF);
  const fetchImpl = async (url, init) => {
    if (`${url}`.includes('/discussions')) {
      commentPages += 1;
      if (commentPages === 1) {
        return jsonResponse(200, [{ notes: [first] }], {
          'x-next-page': '2',
        });
      }
      return jsonResponse(200, [{ notes: [second] }]);
    }
    return base(url, init);
  };
  const loaded = await loadMergeRequest(MR, { fetch: fetchImpl, token: '' });
  assert.equal(commentPages, 2);
  assert.equal(loaded.imported.feedback.length, 2);
  assert.match(loaded.imported.feedback[1].text, /second/);
});

test('discussionToNotes falls back to a todo when unmatched', () => {
  const items = itemsFromFiles(parseDiff(MR_DIFF), 'pr');
  const notes = discussionToNotes(
    [
      {
        notes: [
          inlineDiffNote({
            body: 'orphan',
            newLine: 99,
          }),
        ],
      },
    ],
    items,
  );
  assert.equal(notes.feedback.length, 0);
  assert.equal(notes.todos.length, 1);
  assert.equal(notes.todos[0].file, 'lib/parser.js');
  assert.match(notes.todos[0].text, /orphan/);
});

test('loadMergeRequest abort during discussion does not fallback', async () => {
  const ac = new AbortController();
  const base = mockFetch(MR_JSON, MR_DIFF);
  const fetchImpl = async (url, init) => {
    if (`${url}`.includes('/discussions')) {
      const error = new Error('fetch failed');
      error.code = 'ECONNRESET';
      throw error;
    }
    return base(url, init);
  };
  const pending = loadMergeRequest(MR, {
    fetch: fetchImpl,
    token: '',
    retry: { attempts: 3, delayMs: 30_000 },
    signal: ac.signal,
  });
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
  ac.abort();
  await assert.rejects(pending, (error) => {
    assert.equal(ac.signal.aborted, true);
    return error.name === 'AbortError' || error === ac.signal.reason;
  });
});

test('loadMergeRequest still opens when discussion import fails', async () => {
  const base = mockFetch(MR_JSON, MR_DIFF);
  const fetchImpl = async (url, init) => {
    if (`${url}`.includes('/discussions')) {
      return jsonResponse(500, { message: 'boom' });
    }
    return base(url, init);
  };
  const loaded = await loadMergeRequest(MR, {
    fetch: fetchImpl,
    token: '',
    retry: { attempts: 1 },
  });
  assert.equal(loaded.change.number, 123);
  assert.deepEqual(loaded.imported, { feedback: [], todos: [] });
});
