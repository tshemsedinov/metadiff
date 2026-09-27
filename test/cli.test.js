'use strict';

const nodeTest = require('node:test');
const { test } = nodeTest;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../lib/cli.js');
const { run, parseArgv, resolveScope } = cli;
const git = require('../lib/git.js');
const { createGitRepo } = git;
const helpers = require('./helpers.js');
const { makeRepo, sink, sampleHunk } = helpers;

const fakeProc = (cwd, extra = {}) => {
  const stdout = sink();
  const stderr = sink();
  return {
    argv: extra.argv ?? ['node', 'reslop'],
    cwd: () => cwd,
    stdin: { isTTY: extra.tty ?? false },
    stdout,
    stderr,
    env: extra.env ?? {},
    stdoutText: () => stdout.dump(),
    stderrText: () => stderr.dump(),
  };
};

test('AC11 not a git directory exits 1', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-nogit-'));
  try {
    const proc = fakeProc(dir);
    const code = await run(proc);
    assert.equal(code, 1);
    assert.match(proc.stderrText(), /not a git repository/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AC12 clean repo prints nothing to review', async () => {
  const repo = makeRepo();
  try {
    repo.write('a.txt', 'ok\n');
    repo.git(['add', 'a.txt']);
    repo.git(['commit', '-m', 'init']);
    const proc = fakeProc(repo.dir);
    const code = await run(proc);
    assert.equal(code, 0);
    assert.equal(proc.stdoutText(), 'nothing to review\n');
  } finally {
    repo.cleanup();
  }
});

test('parseArgv accepts -n and -r', () => {
  assert.equal(parseArgv([]).newReview, false);
  assert.equal(parseArgv([]).readOnly, false);
  assert.equal(parseArgv(['-n']).newReview, true);
  assert.equal(parseArgv(['-r']).readOnly, true);
  assert.deepEqual(parseArgv(['-n', 'lib']).paths, ['lib']);
  assert.equal(parseArgv(['-n', 'lib']).newReview, true);
  assert.equal(parseArgv(['-n', '-r']).newReview, true);
  assert.equal(parseArgv(['-n', '-r']).readOnly, true);
  const unknown = ['--new', '--help', '-h', '--version', '-v'];
  for (const flag of unknown) {
    const message = `unknown option ${flag}`;
    assert.throws(() => parseArgv([flag]), new RegExp(message));
  }
});

test('parseArgv reads -light', () => {
  assert.equal(parseArgv([]).theme, 'dark');
  assert.equal(parseArgv(['-light']).theme, 'light');
  assert.equal(parseArgv(['-n', '-light']).theme, 'light');
  assert.deepEqual(parseArgv(['-light', 'lib']).paths, ['lib']);
  assert.equal(parseArgv(['-light', 'lib']).newReview, false);
});

test('unknown option exits 1', async () => {
  const proc = fakeProc(process.cwd(), {
    argv: ['node', 'reslop', '--nope'],
  });
  const code = await run(proc);
  assert.equal(code, 1);
  const err = proc.stderrText();
  assert.match(err, /unknown option/);
  const usage = new RegExp(
    [
      'Usage: reslop \\[-n\\] \\[-r\\] \\[-light\\]',
      '\\[path \\| commit \\| pr-url \\| mr-url\\]',
    ].join(' '),
  );
  assert.match(err, usage);
  assert.doesNotMatch(err, /--help/);
});

test('AC22 resolveScope peels a commit from argv', async () => {
  const repo = makeRepo();
  try {
    repo.write('src/a.txt', 'ok\n');
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    const sha = repo.git(['rev-parse', 'HEAD']).trim();
    const peeled = await resolveScope(
      repo.dir,
      [sha.slice(0, 7)],
      createGitRepo(),
    );
    assert.equal(peeled.rev, sha);
    assert.deepEqual(peeled.paths, []);
    await assert.rejects(
      () => resolveScope(repo.dir, [sha.slice(0, 7), 'lib'], createGitRepo()),
      /commit or a path/,
    );
    const pathWins = await resolveScope(repo.dir, ['src'], createGitRepo());
    assert.equal(pathWins.rev, null);
    assert.deepEqual(pathWins.paths, ['src']);
  } finally {
    repo.cleanup();
  }
});

test('AC22 unknown sha exits 1', async () => {
  const repo = makeRepo();
  try {
    repo.write('a.txt', 'ok\n');
    repo.git(['add', 'a.txt']);
    repo.git(['commit', '-m', 'init']);
    const fake = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const proc = fakeProc(repo.dir, {
      argv: ['node', 'reslop', fake],
    });
    const code = await run(proc);
    assert.equal(code, 1);
    assert.match(proc.stderrText(), /bad revision/);
  } finally {
    repo.cleanup();
  }
});

test('commit plus a path exits 1', async () => {
  const repo = makeRepo();
  try {
    repo.write('a.txt', 'ok\n');
    repo.git(['add', 'a.txt']);
    repo.git(['commit', '-m', 'init']);
    const sha = repo.git(['rev-parse', 'HEAD']).trim();
    const proc = fakeProc(repo.dir, {
      argv: ['node', 'reslop', sha, 'a.txt'],
    });
    const code = await run(proc);
    assert.equal(code, 1);
    assert.match(proc.stderrText(), /commit or a path/);
  } finally {
    repo.cleanup();
  }
});

test('AC20 commit argv loads that commit not worktree', async () => {
  const repo = makeRepo();
  try {
    repo.write('a.txt', 'one\n');
    repo.git(['add', 'a.txt']);
    repo.git(['commit', '-m', 'one']);
    repo.write('a.txt', 'two\n');
    repo.git(['add', 'a.txt']);
    repo.git(['commit', '-m', 'two']);
    const sha = repo.git(['rev-parse', 'HEAD']).trim();
    repo.write('a.txt', 'DIRTY\n');
    const proc = fakeProc(repo.dir, {
      argv: ['node', 'reslop', sha],
    });
    const code = await run(proc);
    assert.equal(code, 1);
    assert.match(proc.stderrText(), /interactive terminal required/);
    assert.equal(proc.stdoutText().includes('nothing to review'), false);
  } finally {
    repo.cleanup();
  }
});

const prItem = () => ({
  origin: 'pr',
  file: {
    oldPath: 'lib/a.js',
    newPath: 'lib/a.js',
    isNew: false,
    isDeleted: false,
    isBinary: false,
    preamble: ['diff --git a/lib/a.js b/lib/a.js'],
    hunks: [],
  },
  hunk: sampleHunk([
    { type: 'del', text: 'a', noNl: false, blockId: 0 },
    { type: 'add', text: 'b', noNl: false, blockId: 0 },
  ]),
  blockId: 0,
  patchAdd: '',
  patchRevert: '',
});

const mockPrLoad =
  (dir, extra = {}) =>
  async () => ({
    top: dir,
    items: extra.items ?? [prItem()],
    sourceLabel: extra.sourceLabel ?? '#123',
    change: {
      source: 'pr',
      title: extra.title ?? 'Fix parser',
      author: extra.author ?? 'alice',
      repository: extra.repository ?? 'acme/app',
      number: extra.number ?? 123,
      base: extra.base ?? 'main',
      head: extra.head ?? 'fix-parser',
      url: extra.url ?? 'https://github.com/acme/app/pull/123',
      files: extra.files ?? ['lib/a.js'],
    },
  });

test('GitHub PR URL opens without a local git repository', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-pr-'));
  try {
    const url = 'https://github.com/acme/app/pull/123';
    const proc = fakeProc(dir, {
      argv: ['node', 'reslop', url],
    });
    const code = await run(proc, { loadPullRequest: mockPrLoad(dir) });
    assert.equal(code, 1);
    assert.match(proc.stderrText(), /interactive terminal required/);
    assert.doesNotMatch(proc.stderrText(), /not a git repository/);
    assert.equal(proc.stdoutText().includes('nothing to review'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('review is not a subcommand before a GitHub PR URL', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-pr-'));
  try {
    const url = 'https://github.com/acme/app/pull/123';
    const proc = fakeProc(dir, {
      argv: ['node', 'reslop', 'review', url],
    });
    let loaded = false;
    const code = await run(proc, {
      loadPullRequest: async () => {
        loaded = true;
        return mockPrLoad(dir)();
      },
    });
    assert.equal(loaded, false);
    assert.equal(code, 1);
    assert.match(proc.stderrText(), /not a git repository/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('empty GitHub PR prints nothing to review', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-pr-'));
  try {
    const url = 'https://github.com/acme/app/pull/123';
    const proc = fakeProc(dir, {
      argv: ['node', 'reslop', url],
    });
    const code = await run(proc, {
      loadPullRequest: mockPrLoad(dir, { items: [] }),
    });
    assert.equal(code, 0);
    assert.equal(proc.stdoutText(), 'nothing to review\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GitHub PR load errors exit 1', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-pr-'));
  try {
    const url = 'https://github.com/acme/app/pull/123';
    const proc = fakeProc(dir, {
      argv: ['node', 'reslop', url],
    });
    const code = await run(proc, {
      loadPullRequest: async () => {
        throw new Error('GitHub pull request not found');
      },
    });
    assert.equal(code, 1);
    assert.match(proc.stderrText(), /GitHub pull request not found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const mockMrLoad =
  (dir, extra = {}) =>
  async () => ({
    top: dir,
    items: extra.items ?? [prItem()],
    sourceLabel: extra.sourceLabel ?? '!123',
    change: {
      source: 'mr',
      title: extra.title ?? 'Fix parser',
      author: extra.author ?? 'alice',
      repository: extra.repository ?? 'acme/app',
      number: extra.number ?? 123,
      base: extra.base ?? 'main',
      head: extra.head ?? 'fix-parser',
      url: extra.url ?? 'https://gitlab.com/acme/app/-/merge_requests/123',
      files: extra.files ?? ['lib/a.js'],
    },
  });

test('GitLab MR URL opens without a local git repository', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-mr-'));
  try {
    const url = 'https://gitlab.com/acme/app/-/merge_requests/123';
    const proc = fakeProc(dir, {
      argv: ['node', 'reslop', url],
    });
    const code = await run(proc, { loadMergeRequest: mockMrLoad(dir) });
    assert.equal(code, 1);
    assert.match(proc.stderrText(), /interactive terminal required/);
    assert.doesNotMatch(proc.stderrText(), /not a git repository/);
    assert.equal(proc.stdoutText().includes('nothing to review'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('empty GitLab MR prints nothing to review', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-mr-'));
  try {
    const url = 'https://gitlab.com/acme/app/-/merge_requests/123';
    const proc = fakeProc(dir, {
      argv: ['node', 'reslop', url],
    });
    const code = await run(proc, {
      loadMergeRequest: mockMrLoad(dir, { items: [] }),
    });
    assert.equal(code, 0);
    assert.equal(proc.stdoutText(), 'nothing to review\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GitLab MR load errors exit 1', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-mr-'));
  try {
    const url = 'https://gitlab.com/acme/app/-/merge_requests/123';
    const proc = fakeProc(dir, {
      argv: ['node', 'reslop', url],
    });
    const code = await run(proc, {
      loadMergeRequest: async () => {
        throw new Error('GitLab merge request not found');
      },
    });
    assert.equal(code, 1);
    assert.match(proc.stderrText(), /GitLab merge request not found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
