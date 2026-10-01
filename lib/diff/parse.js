'use strict';

const LINE_TYPE = { '+': 'add', '-': 'del', ' ': 'ctx' };

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

const parseGitPaths = (line) => {
  const rest = line.slice('diff --git '.length);
  const mid = rest.lastIndexOf(' b/');
  if (mid < 0 || !rest.startsWith('a/')) return { oldPath: '', newPath: '' };
  return { oldPath: rest.slice(2, mid), newPath: rest.slice(mid + 3) };
};

const parsePathLine = (line) => {
  const space = line.indexOf(' ');
  if (space < 0) return '';
  let rest = line.slice(space + 1);
  if (rest.startsWith('"') && rest.endsWith('"')) rest = rest.slice(1, -1);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  if (rest.startsWith('a/') || rest.startsWith('b/')) return rest.slice(2);
  return rest;
};

const parseCount = (text) => (text === undefined ? 1 : parseInt(text, 10));

const startGitFile = (line, ctx) => {
  if (ctx.file) ctx.files.push(ctx.file);
  ctx.hunk = null;
  ctx.file = {
    ...parseGitPaths(line),
    isNew: false,
    isDeleted: false,
    isBinary: false,
    preamble: [line],
    hunks: [],
  };
};

const markBinary = (line, ctx) => {
  ctx.file.isBinary = true;
  ctx.file.preamble.push(line);
  ctx.hunk = null;
};

const markNewFile = (line, ctx) => {
  ctx.file.isNew = true;
  ctx.file.preamble.push(line);
};

const markDeleted = (line, ctx) => {
  ctx.file.isDeleted = true;
  ctx.file.preamble.push(line);
};

const setOldPath = (line, ctx) => {
  const parsed = parsePathLine(line);
  if (parsed === '/dev/null') ctx.file.isNew = true;
  else ctx.file.oldPath = parsed;
  ctx.file.preamble.push(line);
};

const setNewPath = (line, ctx) => {
  const parsed = parsePathLine(line);
  if (parsed === '/dev/null') ctx.file.isDeleted = true;
  else ctx.file.newPath = parsed;
  ctx.file.preamble.push(line);
};

const startHunk = (line, ctx) => {
  const match = HUNK_RE.exec(line);
  if (!match) return;
  ctx.hunk = {
    oldStart: parseInt(match[1], 10),
    oldCount: parseCount(match[2]),
    newStart: parseInt(match[3], 10),
    newCount: parseCount(match[4]),
    header: line,
    lines: [],
  };
  ctx.file.hunks.push(ctx.hunk);
};

const DIFF_PREFIX = [
  { prefix: 'diff --git ', apply: startGitFile, needFile: false },
  { prefix: 'Binary files ', apply: markBinary, needFile: true },
  { prefix: 'GIT binary', apply: markBinary, needFile: true },
  { prefix: 'new file mode', apply: markNewFile, needFile: true },
  { prefix: 'deleted file mode', apply: markDeleted, needFile: true },
  { prefix: '--- ', apply: setOldPath, needFile: true },
  { prefix: '+++ ', apply: setNewPath, needFile: true },
  { prefix: '@@ ', apply: startHunk, needFile: true },
];

const takeHunkLine = (line, hunk) => {
  if (line.startsWith('\\')) {
    const prev = hunk.lines[hunk.lines.length - 1];
    if (prev) prev.noNl = true;
    return;
  }
  const type = LINE_TYPE[line[0]];
  const text = type ? line.slice(1) : line;
  hunk.lines.push({ type: type ?? 'ctx', text, noNl: false });
};

const parseDiff = (text) => {
  const files = [];
  if (!text) return files;
  const rawLines = text.split('\n');
  if (rawLines.at(-1) === '') rawLines.pop();
  const ctx = { files, file: null, hunk: null };
  for (const raw of rawLines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const rule = DIFF_PREFIX.find((entry) => line.startsWith(entry.prefix));
    if (rule) {
      if (rule.needFile && !ctx.file) continue;
      rule.apply(line, ctx);
      continue;
    }
    if (!ctx.file) continue;
    if (ctx.hunk) takeHunkLine(line, ctx.hunk);
    else ctx.file.preamble.push(line);
  }
  if (ctx.file) files.push(ctx.file);
  return files;
};

module.exports = { parseDiff };
