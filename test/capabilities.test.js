'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const caps = require('../lib/capabilities.js');
const { SOURCE_CAPS, capabilitiesFor, attachCapabilities } = caps;
const { sessionCapabilities } = caps;

const hasMethod = (source, name) => typeof source[name] === 'function';

test('capability matrix covers local commit remotes and read-only', () => {
  assert.deepEqual(SOURCE_CAPS.local, {
    read: true,
    changes: true,
    branches: true,
    review: true,
  });
  assert.deepEqual(capabilitiesFor('commit'), {
    read: true,
    changes: false,
    branches: false,
    review: true,
  });
  assert.deepEqual(capabilitiesFor('pr'), SOURCE_CAPS.pr);
  assert.deepEqual(capabilitiesFor('mr'), SOURCE_CAPS.mr);
  assert.equal(capabilitiesFor('readonly').changes, false);
  assert.equal(capabilitiesFor('local', { readOnly: true }).changes, false);
  assert.equal(capabilitiesFor('local', { readOnly: true }).branches, false);
});

test('attachCapabilities omits writes the source does not advertise', () => {
  const impl = {
    load: () => ({ items: [] }),
    add: () => 'added',
    commit: () => 'committed',
    listBranches: () => [],
  };
  const remote = attachCapabilities(impl, capabilitiesFor('pr'));
  assert.equal(hasMethod(remote, 'load'), true);
  assert.equal(hasMethod(remote, 'add'), false);
  assert.equal(hasMethod(remote, 'commit'), false);
  assert.equal(hasMethod(remote, 'listBranches'), false);
  assert.equal(remote.add, undefined);
  const local = attachCapabilities(impl, capabilitiesFor('local'));
  assert.equal(local.add(), 'added');
  assert.equal(local.commit(), 'committed');
});

test('sessionCapabilities follows rev change source and -r', () => {
  assert.equal(sessionCapabilities({ rev: 'abc' }).changes, false);
  assert.equal(sessionCapabilities({ readOnly: true }).branches, false);
  const pr = sessionCapabilities({
    change: { source: 'pr' },
  });
  assert.equal(pr.changes, false);
  const mr = sessionCapabilities({
    change: { source: 'mr' },
  });
  assert.equal(mr.branches, false);
  const fromRepo = sessionCapabilities({
    repo: { capabilities: SOURCE_CAPS.local },
    readOnly: true,
  });
  assert.equal(fromRepo.changes, false);
});
