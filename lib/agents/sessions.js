'use strict';

const os = require('node:os');
const path = require('node:path');
const { listDir, readJson } = require('../common/utilities.js');

const claudeRoot = () => path.join(os.homedir(), '.claude', 'projects');

const cursorRoot = () => path.join(os.homedir(), '.cursor', 'chats');

const claudeSession = (cwd, root = claudeRoot()) => {
  const dir = path.join(root, `${cwd ?? ''}`.split(path.sep).join('-'));
  return listDir(dir).some((name) => name.endsWith('.jsonl'));
};

const cursorSession = (cwd, root = cursorRoot()) => {
  for (const bucket of listDir(root)) {
    const dir = path.join(root, bucket);
    for (const chat of listDir(dir)) {
      const meta = readJson(path.join(dir, chat, 'meta.json'));
      if (!meta || meta.cwd !== cwd) continue;
      if (meta.hasConversation === true) return true;
    }
  }
  return false;
};

const PROBE = {
  claude: claudeSession,
  cursor: cursorSession,
};

const ranBefore = (jobs, id) => {
  if (!Array.isArray(jobs)) return false;
  return jobs.some((job) => job.cliId === id && job.action === 'run');
};

const hasAgentSession = (row, cwd, jobs = [], probe = PROBE) => {
  const resume = row && row.spec ? row.spec.resume : null;
  if (!resume || !resume.length) return false;
  if (ranBefore(jobs, row.id)) return true;
  const check = probe[row.id];
  return check ? check(cwd) : false;
};

module.exports = {
  claudeSession,
  cursorSession,
  hasAgentSession,
};
