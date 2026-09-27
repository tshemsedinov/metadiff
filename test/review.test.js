'use strict';

const nodeTest = require('node:test');
const { test } = nodeTest;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const review = require('../lib/review.js');
const { allocateReviewPath, rankedTemplates } = review;
const { prefixTemplates, upsertTemplate, createStore } = review;
const { hasNotes, setFeedback, setCode, noteCounts, rememberTemplate } = review;
const { addTodo, removeTodo, setTodoText, setTodoDone } = review;
const { serializeReview } = review;
const { applyImportedNotes, flushReview, loadTemplates, parseReview } = review;
const { resolveReviewPath, latestReviewName, parseFrontmatterStatus } = review;

test('allocateReviewPath uses 00 then 01 on the same day', () => {
  const date = new Date(2026, 8, 7);
  const dir = '/repo';
  const first = allocateReviewPath(dir, date, []);
  assert.equal(first, path.join('/repo', '.review', '2026-09-07-00.md'));
  const second = allocateReviewPath(dir, date, ['2026-09-07-00.md']);
  assert.equal(second, path.join('/repo', '.review', '2026-09-07-01.md'));
  const other = allocateReviewPath(dir, date, ['2026-09-06-09.md']);
  assert.equal(other, path.join('/repo', '.review', '2026-09-07-00.md'));
});

test('latestReviewName picks the newest date then index', () => {
  assert.equal(latestReviewName([]), '');
  assert.equal(
    latestReviewName([
      'templates.json',
      '2026-09-06-09.md',
      '2026-09-07-00.md',
    ]),
    '2026-09-07-00.md',
  );
  assert.equal(
    latestReviewName(['2026-09-07-09.md', '2026-09-07-10.md']),
    '2026-09-07-10.md',
  );
});

test('resolveReviewPath resumes editing and starts new otherwise', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-review-'));
  try {
    const date = new Date(2026, 8, 7);
    const folder = path.join(dir, '.review');
    fs.mkdirSync(folder);
    const current = path.join(folder, '2026-09-07-00.md');
    const names = ['2026-09-07-00.md'];
    const writeStatus = (status) => {
      fs.writeFileSync(current, `---\nstatus: ${status}\n---\n`);
    };
    writeStatus('editing');
    const editing = resolveReviewPath(dir, date, names);
    assert.equal(editing.resume, true);
    assert.equal(editing.reviewPath, current);
    writeStatus('ready');
    const ready = resolveReviewPath(dir, date, names);
    assert.equal(ready.resume, false);
    assert.equal(
      ready.reviewPath,
      path.join(dir, '.review', '2026-09-07-01.md'),
    );
    writeStatus('pending');
    assert.equal(resolveReviewPath(dir, date, names).resume, false);
    writeStatus('partial');
    assert.equal(resolveReviewPath(dir, date, names).resume, false);
    writeStatus('done');
    assert.equal(resolveReviewPath(dir, date, names).resume, false);
    writeStatus('editing');
    const forced = resolveReviewPath(dir, date, names, { forceNew: true });
    assert.equal(forced.resume, false);
    assert.equal(
      forced.reviewPath,
      path.join(dir, '.review', '2026-09-07-01.md'),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rankedTemplates sorts by frequency then text', () => {
  const ranked = rankedTemplates([
    { text: 'b', count: 1 },
    { text: 'a', count: 3 },
    { text: 'c', count: 3 },
  ]);
  assert.deepEqual(
    ranked.map((entry) => entry.text),
    ['a', 'c', 'b'],
  );
});

test('prefixTemplates keeps entries that start with the typed text', () => {
  const all = [
    { text: 'extract helper', count: 2 },
    { text: 'add tests', count: 1 },
    { text: 'extract type', count: 1 },
  ];
  assert.equal(prefixTemplates(all, ''), all);
  assert.deepEqual(
    prefixTemplates(all, 'extract').map((entry) => entry.text),
    ['extract helper', 'extract type'],
  );
  assert.deepEqual(prefixTemplates(all, 'z'), []);
});

test('upsertTemplate increments matching text', () => {
  const once = upsertTemplate([], 'extract helper');
  assert.deepEqual(once, [{ text: 'extract helper', count: 1 }]);
  const twice = upsertTemplate(once, 'extract helper');
  assert.deepEqual(twice, [{ text: 'extract helper', count: 2 }]);
  assert.deepEqual(once[0].count, 1);
});

test('rememberTemplate skips when the same hunk text is saved again', () => {
  const store = createStore('/tmp/x.md');
  rememberTemplate(store, '', 'extract helper');
  assert.deepEqual(store.templates, [{ text: 'extract helper', count: 1 }]);
  rememberTemplate(store, 'extract helper', 'extract helper');
  assert.equal(store.templates[0].count, 1);
  rememberTemplate(store, 'extract helper', 'extract helper\n');
  assert.equal(store.templates[0].count, 1);
});

test('rememberTemplate increments when reused on a new hunk', () => {
  const store = createStore('/tmp/x.md');
  rememberTemplate(store, '', 'extract helper');
  rememberTemplate(store, '', 'extract helper');
  assert.equal(store.templates[0].count, 2);
});

test('serializeReview groups todos then feedback with position', () => {
  const store = createStore('/repo/.review/2026-09-07-00.md');
  addTodo(store, 'lib/session.js', 'rewrite the retry loop');
  setFeedback(store, 'unstaged:lib/session.js:84:84:0', {
    file: 'lib/session.js',
    oldStart: 84,
    newStart: 84,
    blockId: 0,
    origin: 'unstaged',
    header: '@@ -84,12 +84,20 @@',
    text: 'extract a helper',
  });
  const md = serializeReview(store);
  assert.match(md, /status: editing/);
  assert.match(md, /# reslop review 2026-09-07-00/);
  assert.match(md, /## Agent instructions/);
  assert.match(md, /^## TODOs$/m);
  assert.match(md, /^## lib\/session\.js$/m);
  assert.ok(!md.includes('> lib/session.js'));
  assert.ok(!md.includes('### Todo'));
  assert.ok(!md.includes('### Feedback'));
  assert.match(md, /- \[ \] rewrite the retry loop/);
  assert.match(md, /- \[ \] extract a helper - lib\/session\.js:84:84:0/);
  assert.ok(!md.includes('<!-- reslop:'));
  assert.ok(!md.includes('Feedback `'));
  assert.ok(!md.includes('@@ -84,12 +84,20 @@'));
  assert.equal(hasNotes(store), true);
});

test('serializeReview writes ready when status is ready', () => {
  const store = createStore('/repo/.review/2026-09-07-00.md');
  store.status = 'ready';
  addTodo(store, 'a.js', 'follow up');
  const md = serializeReview(store);
  assert.match(md, /status: ready/);
  assert.match(md, /Execute reviews with `status` `ready, partial, editing`/);
  assert.match(md, /Do not start or change `done` review files/);
  assert.match(
    md,
    /If not `editing`, set `status` to `partial` if some remain/,
  );
});

test('parseFrontmatterStatus maps pending to ready', () => {
  const pending = '---\nstatus: pending\n---\n';
  const ready = '---\nstatus: ready\n---\n';
  assert.equal(parseFrontmatterStatus(pending), 'ready');
  assert.equal(parseFrontmatterStatus(ready), 'ready');
});

test('parseReview restores todos and feedback keys', () => {
  const store = createStore('/repo/.review/2026-09-07-00.md');
  addTodo(store, 'lib/session.js', 'rewrite the retry loop');
  const key = 'lib/session.js:84:84:0';
  setFeedback(store, key, {
    file: 'lib/session.js',
    oldStart: 84,
    newStart: 84,
    blockId: 0,
    origin: 'unstaged',
    header: '@@ -84,12 +84,20 @@',
    text: 'extract a helper',
  });
  const md = serializeReview(store);
  assert.equal(parseFrontmatterStatus(md), 'editing');
  const loaded = parseReview(md, store.reviewPath);
  assert.equal(loaded.status, 'editing');
  assert.equal(loaded.todos.length, 1);
  assert.equal(loaded.todos[0].file, 'TODOs');
  assert.equal(loaded.todos[0].text, 'rewrite the retry loop');
  assert.equal(loaded.todos[0].done, false);
  assert.equal(loaded.feedback.get(key).text, 'extract a helper');
  assert.equal(loaded.feedback.get(key).done, false);
  assert.equal(loaded.feedback.get(key).file, 'lib/session.js');
  assert.equal(loaded.feedback.get(key).oldStart, 84);
  assert.equal(loaded.feedback.get(key).blockId, 0);
  assert.equal(loaded.dirty, false);
});

test('parseReview reads the old HTML comment feedback format', () => {
  const md = [
    '---',
    'status: editing',
    '---',
    '',
    '## lib/database.js',
    '',
    '### Feedback `lib/database.js` +41 (@@ -41,1 +41,1 @@, block 0)',
    '',
    '<!-- reslop:staged:lib/database.js:41:41:0 -->',
    '- [ ] old note',
    '',
  ].join('\n');
  const loaded = parseReview(md, '/repo/.review/x.md');
  const note = loaded.feedback.get('lib/database.js:41:41:0');
  assert.equal(note.text, 'old note');
  assert.equal(note.file, 'lib/database.js');
  assert.equal(note.origin, 'staged');
  assert.equal(note.oldStart, 41);
  assert.equal(note.newStart, 41);
  assert.equal(note.blockId, 0);
  assert.equal(note.done, false);
});

test('parseReview keeps checked todos and feedback', () => {
  const md = [
    '---',
    'status: partial',
    '---',
    '',
    '> a.js',
    '',
    '- [x] rewrite loop',
    '- [ ] still open',
    '- [X] extract helper - a.js:1:1:0',
    '',
  ].join('\n');
  const loaded = parseReview(md, '/repo/.review/x.md');
  assert.equal(loaded.todos[0].done, true);
  assert.equal(loaded.todos[0].text, 'rewrite loop');
  assert.equal(loaded.todos[1].done, false);
  assert.equal(loaded.feedback.get('a.js:1:1:0').done, true);
  const out = serializeReview(loaded);
  assert.match(out, /^## a\.js$/m);
  assert.ok(!out.includes('> a.js'));
  assert.match(out, /- \[x\] rewrite loop/);
  assert.match(out, /- \[ \] still open/);
  assert.match(out, /- \[x\] extract helper - a\.js:1:1:0/);
});

test('noteCounts counts filled feedback todos and code', () => {
  const empty = { feedback: 0, todo: 0, todoDone: 0, code: 0 };
  const store = createStore('/repo/.review/x.md');
  assert.deepEqual(noteCounts(null), empty);
  assert.deepEqual(noteCounts(store), empty);
  addTodo(store, 'a.js', '');
  assert.deepEqual(noteCounts(store), empty);
  addTodo(store, 'a.js', 'rewrite loop');
  setFeedback(store, 'a.js:1:1:0', {
    file: 'a.js',
    oldStart: 1,
    newStart: 1,
    blockId: 0,
    text: 'extract helper',
  });
  assert.deepEqual(noteCounts(store), {
    feedback: 1,
    todo: 1,
    todoDone: 0,
    code: 0,
  });
  store.todos[1].done = true;
  assert.equal(noteCounts(store).todoDone, 1);
  setCode(store, 'a.js:1:1:0', {
    file: 'a.js',
    oldStart: 1,
    newStart: 1,
    blockId: 0,
    text: 'fixed',
  });
  assert.deepEqual(noteCounts(store), {
    feedback: 1,
    todo: 1,
    todoDone: 1,
    code: 1,
  });
  assert.equal(hasNotes(store), true);
});

test('empty text is omitted from markdown and hasNotes', () => {
  const store = createStore('/repo/.review/2026-09-07-00.md');
  addTodo(store, 'a.js', '   ');
  setFeedback(store, 'k', {
    file: 'a.js',
    newStart: 1,
    text: '',
  });
  assert.equal(hasNotes(store), false);
  const md = serializeReview(store);
  assert.ok(!md.includes('### Todo'));
  assert.ok(!md.includes('### Feedback'));
  assert.ok(!md.includes('## a.js'));
  assert.ok(!md.includes('> a.js'));
});

test('setFeedback keeps one latest note per key', () => {
  const store = createStore('/tmp/x.md');
  setFeedback(store, 'k', {
    file: 'a.js',
    newStart: 1,
    text: 'first draft',
  });
  setFeedback(store, 'k', {
    file: 'a.js',
    newStart: 1,
    text: 'latest',
  });
  assert.equal(store.feedback.size, 1);
  assert.equal(store.feedback.get('k').text, 'latest');
  assert.equal(store.templates.length, 0);
  const md = serializeReview(store);
  assert.equal([...md.matchAll(/^## a\.js$/gm)].length, 1);
  assert.match(md, /- \[ \] latest - a\.js:0:1:0/);
  assert.ok(!md.includes('first draft'));
  assert.ok(!md.includes('### Feedback'));
});

test('removeTodo drops a todo by id', () => {
  const store = createStore('/tmp/x.md');
  const first = addTodo(store, 'a.js', 'keep');
  const second = addTodo(store, 'a.js', 'drop');
  assert.equal(removeTodo(store, second.id), true);
  assert.deepEqual(
    store.todos.map((todo) => todo.id),
    [first.id],
  );
  assert.equal(removeTodo(store, 99), false);
  assert.equal(store.todos.length, 1);
});

test('setTodoDone keeps the text and round-trips through the file', () => {
  const store = createStore('/tmp/x.md');
  const todo = addTodo(store, 'a.js', 'ship it');
  setTodoDone(store, todo.id, true);
  assert.equal(store.todos[0].done, true);
  assert.equal(store.todos[0].text, 'ship it');
  const loaded = parseReview(serializeReview(store), store.reviewPath);
  assert.equal(loaded.todos[0].done, true);
  assert.equal(loaded.todos[0].text, 'ship it');
  setTodoDone(store, todo.id, false);
  assert.equal(store.todos[0].done, false);
});

test('setTodoText deletes empty todos without template history', () => {
  const store = createStore('/tmp/x.md');
  const todo = addTodo(store, 'a.js', '');
  setTodoText(store, todo.id, 'add tests');
  setTodoText(store, todo.id, 'add tests please');
  assert.equal(store.todos.length, 1);
  assert.equal(store.todos[0].text, 'add tests please');
  assert.equal(store.templates.length, 0);
  setTodoText(store, todo.id, '');
  assert.equal(store.todos.length, 0);
});

test('flushReview writes markdown and templates when notes exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-review-'));
  try {
    const reviewPath = path.join(dir, '.review', '2026-09-07-00.md');
    const store = createStore(reviewPath);
    setFeedback(store, 'k', {
      file: 'a.js',
      newStart: 3,
      blockId: 0,
      header: '@@ -3,1 +3,1 @@',
      text: 'rename this',
    });
    const wrote = flushReview(store);
    assert.equal(wrote, true);
    assert.equal(store.dirty, false);
    const md = fs.readFileSync(reviewPath, 'utf8');
    assert.match(md, /rename this/);
    const templates = loadTemplates(dir);
    assert.equal(templates.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('flushReview merges disk todos instead of overwriting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-review-'));
  try {
    const reviewPath = path.join(dir, '.review', '2026-09-07-00.md');
    const store = createStore(reviewPath);
    addTodo(store, 'TODOs', 'alpha');
    const beta = addTodo(store, 'TODOs', 'beta');
    setFeedback(store, 'a.js:1:1:0', {
      file: 'a.js',
      oldStart: 1,
      newStart: 1,
      blockId: 0,
      text: 'rename this',
    });
    assert.equal(flushReview(store), true);
    const md = fs.readFileSync(reviewPath, 'utf8');
    const edited = md
      .replace('- [ ] alpha', '- [x] alpha')
      .replace('rename this', 'rename that')
      .replace('- [ ] beta\n', '- [ ] beta\n- [ ] gamma\n');
    fs.writeFileSync(reviewPath, edited);
    setTodoText(store, beta.id, 'beta two');
    addTodo(store, 'TODOs', 'delta');
    assert.equal(flushReview(store), true);
    const loaded = parseReview(fs.readFileSync(reviewPath, 'utf8'), reviewPath);
    const texts = loaded.todos.map((todo) => {
      const mark = todo.done ? 'x' : ' ';
      return `${mark}:${todo.text}`;
    });
    assert.deepEqual(texts, ['x:alpha', ' :gamma', ' :beta two', ' :delta']);
    const note = loaded.feedback.get('a.js:1:1:0');
    assert.equal(note.text, 'rename that');
    assert.equal(store.todos.length, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('flushReview skips write when there are no notes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-review-'));
  try {
    const reviewPath = path.join(dir, '.review', '2026-09-07-00.md');
    const store = createStore(reviewPath);
    store.dirty = true;
    const wrote = flushReview(store);
    assert.equal(wrote, false);
    assert.equal(store.dirty, false);
    assert.equal(fs.existsSync(reviewPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('serializeReview collects todos under TODOs not file headings', () => {
  const store = createStore('/tmp/x.md');
  addTodo(store, 'a.js', 'todo a');
  addTodo(store, 'b.js', 'todo b');
  setFeedback(store, 'k', {
    file: 'a.js',
    oldStart: 1,
    newStart: 1,
    blockId: 0,
    text: 'nit',
  });
  const md = serializeReview(store);
  assert.match(md, /^## TODOs$/m);
  assert.match(md, /- \[ \] todo a/);
  assert.match(md, /- \[ \] todo b/);
  const fileAt = md.indexOf('## a.js');
  const todosAt = md.indexOf('## TODOs');
  assert.ok(todosAt >= 0 && todosAt < fileAt);
  assert.ok(!md.slice(fileAt).includes('todo a'));
  const loaded = parseReview(md, store.reviewPath);
  assert.equal(loaded.todos.length, 2);
  assert.equal(loaded.todos[0].file, 'TODOs');
  assert.equal(loaded.todos[1].file, 'TODOs');
});

test('applyImportedNotes maps comments onto feedback and todos', () => {
  const store = createStore('/tmp/x.md');
  applyImportedNotes(store, {
    feedback: [
      {
        file: 'lib/parser.js',
        oldStart: 1,
        newStart: 1,
        blockId: 0,
        origin: 'pr',
        header: '',
        text: 'first',
        done: true,
      },
      {
        file: 'lib/parser.js',
        oldStart: 1,
        newStart: 1,
        blockId: 0,
        origin: 'pr',
        header: '',
        text: 'second',
        done: true,
      },
    ],
    todos: [
      { file: 'pull request', text: 'add tests', done: false },
      { file: 'lib/parser.js', text: 'types', done: true },
    ],
  });
  const note = store.feedback.get('lib/parser.js:1:1:0');
  assert.equal(note.text, 'first\n\nsecond');
  assert.equal(note.done, true);
  assert.equal(store.todos.length, 2);
  assert.equal(store.todos[0].text, 'add tests');
  assert.equal(store.todos[0].done, false);
  assert.equal(store.todos[1].done, true);
});

test('applyImportedNotes keeps feedback open if any comment is open', () => {
  const store = createStore('/tmp/x.md');
  applyImportedNotes(store, {
    feedback: [
      {
        file: 'a.js',
        oldStart: 1,
        newStart: 1,
        blockId: 0,
        text: 'a',
        done: true,
      },
      {
        file: 'a.js',
        oldStart: 1,
        newStart: 1,
        blockId: 0,
        text: 'b',
        done: false,
      },
    ],
  });
  assert.equal(store.feedback.get('a.js:1:1:0').done, false);
});

test('imported feedback serializes reviewer and location once', () => {
  const store = createStore('/repo/.review/2026-09-07-00.md');
  applyImportedNotes(store, {
    feedback: [
      {
        file: 'lib/websocket/frameParser.js',
        oldStart: 127,
        newStart: 127,
        blockId: 0,
        origin: 'pr',
        text: '@tshemsedinov review at github: It is null by default',
        done: false,
      },
    ],
  });
  const md = serializeReview(store);
  const line =
    '- [ ] @tshemsedinov review at github: It is null by default' +
    ' - lib/websocket/frameParser.js:127:127:0';
  assert.equal(md.includes(line), true);
  assert.equal(md.split('tshemsedinov').length - 1, 1);
  assert.doesNotMatch(md, /source:/);
  assert.doesNotMatch(md, /reviewer:/);
  assert.doesNotMatch(md, /line:/);
});

test('serializeReview writes fenced code proposals', () => {
  const store = createStore('/repo/.review/2026-09-07-00.md');
  setCode(store, 'a.js:1:1:0', {
    file: 'a.js',
    oldStart: 1,
    newStart: 1,
    blockId: 0,
    text: 'const x = 1;\nconst y = 2;',
  });
  const md = serializeReview(store);
  assert.match(md, /^- \[ \] code `a\.js:1:1:0`$/m);
  assert.match(md, /^```\nconst x = 1;\nconst y = 2;\n```$/m);
  const loaded = parseReview(md, store.reviewPath);
  const note = loaded.code.get('a.js:1:1:0');
  assert.equal(note.text, 'const x = 1;\nconst y = 2;');
  assert.equal(note.done, false);
  assert.equal(hasNotes(loaded), true);
});

test('code proposal with fence markers uses a longer fence', () => {
  const store = createStore('/repo/.review/2026-09-07-00.md');
  setCode(store, 'a.js:1:1:0', {
    file: 'a.js',
    oldStart: 1,
    newStart: 1,
    blockId: 0,
    text: '```\ninner\n```',
  });
  const md = serializeReview(store);
  assert.match(md, /^````\n```\ninner\n```\n````$/m);
  const loaded = parseReview(md, store.reviewPath);
  assert.equal(loaded.code.get('a.js:1:1:0').text, '```\ninner\n```');
});

test('empty code proposal still counts as a note', () => {
  const store = createStore('/repo/.review/2026-09-07-00.md');
  setCode(store, 'a.js:1:1:0', {
    file: 'a.js',
    oldStart: 1,
    newStart: 1,
    blockId: 0,
    text: '',
  });
  assert.equal(hasNotes(store), true);
  assert.deepEqual(noteCounts(store), {
    feedback: 0,
    todo: 0,
    todoDone: 0,
    code: 1,
  });
  const md = serializeReview(store);
  assert.match(md, /^- \[ \] code `a\.js:1:1:0`$/m);
  const loaded = parseReview(md, store.reviewPath);
  assert.equal(loaded.code.get('a.js:1:1:0').text, '');
});
