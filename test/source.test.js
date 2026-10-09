'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { selectChangeSource, createLoadedSource } = require('../lib/source.js');

test('selectChangeSource recognizes a GitHub pull request URL', () => {
  const url = 'https://github.com/acme/app/pull/123';
  const selected = selectChangeSource([url]);
  assert.equal(selected.kind, 'pr');
  assert.deepEqual(selected.pr, { owner: 'acme', repo: 'app', number: 123 });
  assert.deepEqual(selected.paths, []);
});

test('selectChangeSource recognizes a GitLab merge request URL', () => {
  const url = 'https://gitlab.com/acme/app/-/merge_requests/123';
  const selected = selectChangeSource([url]);
  assert.equal(selected.kind, 'mr');
  assert.deepEqual(selected.mr, {
    host: 'gitlab.com',
    project: 'acme/app',
    number: 123,
    origin: 'https://gitlab.com',
  });
  assert.deepEqual(selected.paths, []);
});

test('selectChangeSource recognizes a GitHub issue URL', () => {
  const url = 'https://github.com/acme/app/issues/12';
  const selected = selectChangeSource([url, 'lib']);
  assert.equal(selected.kind, 'issue');
  assert.deepEqual(selected.issue, { owner: 'acme', repo: 'app', number: 12 });
  assert.deepEqual(selected.paths, ['lib']);
});

test('selectChangeSource recognizes a GitLab issue URL', () => {
  const url = 'https://gitlab.com/group/app/-/issues/4';
  const selected = selectChangeSource([url]);
  assert.equal(selected.kind, 'gl-issue');
  assert.deepEqual(selected.issue, {
    host: 'gitlab.com',
    project: 'group/app',
    number: 4,
    origin: 'https://gitlab.com',
  });
  assert.deepEqual(selected.paths, []);
});

test('selectChangeSource recognizes a GitHub issue list', () => {
  const list = 'https://github.com/tshemsedinov/reslop/issues';
  const repo = 'https://github.com/tshemsedinov/reslop';
  const fromList = selectChangeSource([list]);
  const fromRepo = selectChangeSource([repo]);
  const expected = { owner: 'tshemsedinov', repo: 'reslop', list: true };
  assert.equal(fromList.kind, 'issue');
  assert.deepEqual(fromList.issue, expected);
  assert.equal(fromRepo.kind, 'issue');
  assert.deepEqual(fromRepo.issue, expected);
});

test('selectChangeSource recognizes a GitLab issue list', () => {
  const list = 'https://gitlab.com/acme/app/-/issues';
  const repo = 'https://gitlab.com/acme/app';
  const fromList = selectChangeSource([list]);
  const fromRepo = selectChangeSource([repo]);
  assert.equal(fromList.kind, 'gl-issue');
  assert.equal(fromList.issue.project, 'acme/app');
  assert.equal(fromList.issue.list, true);
  assert.equal(fromRepo.kind, 'gl-issue');
  assert.equal(fromRepo.issue.project, 'acme/app');
  const numbered = selectChangeSource([
    'https://gitlab.com/acme/app/-/issues/4',
  ]);
  assert.equal(numbered.kind, 'gl-issue');
  assert.equal(numbered.issue.number, 4);
  assert.equal(numbered.issue.list, undefined);
});

test('selectChangeSource does not treat review as a subcommand', () => {
  const url = 'https://github.com/acme/app/pull/123';
  const selected = selectChangeSource(['review', url, 'lib']);
  assert.equal(selected.kind, 'local');
  assert.deepEqual(selected.paths, ['review', url, 'lib']);
});

test('selectChangeSource keeps local paths and commits', () => {
  assert.deepEqual(selectChangeSource([]), { kind: 'local', paths: [] });
  assert.deepEqual(selectChangeSource(['lib']), {
    kind: 'local',
    paths: ['lib'],
  });
  assert.deepEqual(selectChangeSource(['7ac260c', 'lib']), {
    kind: 'local',
    paths: ['7ac260c', 'lib'],
  });
  assert.deepEqual(selectChangeSource(['review', 'lib']), {
    kind: 'local',
    paths: ['review', 'lib'],
  });
});

test('createLoadedSource is read only and returns a copy of items', () => {
  const item = { origin: 'pr', file: { newPath: 'a.js' } };
  const loaded = { items: [item], sourceLabel: '#1' };
  const source = createLoadedSource(loaded);
  const first = source.load();
  first.items.push({ origin: 'task' });
  const second = source.load();
  assert.equal(second.items.length, 1);
  assert.equal(typeof source.add, 'undefined');
  assert.equal(typeof source.unstage, 'undefined');
  assert.equal(typeof source.revert, 'undefined');
  assert.equal(typeof source.revertFile, 'undefined');
  assert.equal(typeof source.commit, 'undefined');
  assert.equal(source.resolveRev(), null);
  assert.equal(second.items[0].origin, 'pr');
  assert.equal(source.capabilities.changes, false);
  assert.equal(source.capabilities.branches, false);
});
