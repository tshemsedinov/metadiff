'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { spawnSync } = childProcess;

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

const makeRepo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-'));
  const git = (args, input) => {
    const result = spawnSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      input,
      env: gitEnv,
    });
    if (result.status !== 0) {
      const msg = result.stderr || result.stdout || 'git failed';
      throw new Error(msg.trim());
    }
    return result.stdout;
  };
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.autocrlf', 'false']);
  git(['config', 'core.eol', 'lf']);
  const write = (rel, content) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  const read = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
  const exists = (rel) => fs.existsSync(path.join(dir, rel));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return { dir, git, write, read, exists, cleanup };
};

const sink = () => {
  let text = '';
  return {
    isTTY: false,
    columns: 80,
    rows: 24,
    write: (chunk) => {
      text += chunk;
      return true;
    },
    dump: () => text,
  };
};

const uiSink = () => {
  const stdout = sink();
  stdout.rows = 16;
  return stdout;
};

const tempDir = (prefix = 'reslop-') =>
  fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const ttySink = () => {
  const stream = sink();
  stream.isTTY = true;
  return stream;
};

const sampleHunk = (lines) => ({
  oldStart: 1,
  oldCount: 1,
  newStart: 1,
  newCount: 1,
  header: '@@ -1,1 +1,1 @@',
  lines,
});

const reviewView = (item, extra = {}) => ({
  item,
  index: 0,
  total: 1,
  scroll: 0,
  status: '',
  counts: { staged: 0, unstaged: 1, untracked: 0 },
  repoName: 'demo',
  ...extra,
});

module.exports = {
  makeRepo,
  sink,
  uiSink,
  tempDir,
  ttySink,
  sampleHunk,
  reviewView,
};
