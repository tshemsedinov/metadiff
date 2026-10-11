'use strict';

const { npmBin, npmOpts } = require('../common/process.js');
const { commandEnv, PipeProcess } = require('./process.js');

const startNpm = (cwd, entry, onData, onClose) => {
  const isBin = entry.kind === 'bin';
  const args = isBin ? ['exec', '--', entry.name] : ['run', entry.name];
  const detached = process.platform !== 'win32';
  const options = npmOpts({ cwd, env: commandEnv(), detached });
  return new PipeProcess(onData, onClose).start(npmBin(), args, options);
};

module.exports = { startNpm };
