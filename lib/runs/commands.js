'use strict';

const utilities = require('../common/utilities.js');
const { npmBin, npmOpts } = utilities;
const { killTree, commandEnv, PipeProcess } = require('./process.js');
const scriptsPart = require('./scripts.js');
const { listCommands, saveScript, removeScript, reorderScript } = scriptsPart;
const outputPart = require('./output.js');
const { reduceOutput, isPassingTest, traceLine, relativize } = outputPart;
const { TABLE_KEY, TABLE_VAL, formatTable } = outputPart;
const logsPart = require('./logs.js');
const { logFileName, logText, nextLogFile, saveLogs } = logsPart;
const { readSavedRuns, readLogPair, staleLogFiles, removeStaleLogs } = logsPart;

const startNpm = (cwd, entry, onData, onClose) => {
  const isBin = entry.kind === 'bin';
  const args = isBin ? ['exec', '--', entry.name] : ['run', entry.name];
  const detached = process.platform !== 'win32';
  const options = npmOpts({ cwd, env: commandEnv(), detached });
  return new PipeProcess(onData, onClose).start(npmBin(), args, options);
};

module.exports = {
  listCommands,
  reduceOutput,
  logFileName,
  logText,
  nextLogFile,
  saveLogs,
  readSavedRuns,
  readLogPair,
  staleLogFiles,
  removeStaleLogs,
  saveScript,
  removeScript,
  reorderScript,
  startNpm,
  commandEnv,
  killTree,
  isPassingTest,
  traceLine,
  relativize,
  TABLE_KEY,
  TABLE_VAL,
  formatTable,
};
