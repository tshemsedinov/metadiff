#!/usr/bin/env node
'use strict';

const { errorMessage } = require('../lib/common/utilities.js');

const fail = (reason) => {
  try {
    const { LEAVE_TERM } = require('../lib/session/terminal.js');
    process.stdout.write(LEAVE_TERM);
  } catch {
    // ignore
  }
  process.stderr.write(`reslop: ${errorMessage(reason)}\n`);
  process.exit(1);
};

process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

const start = () => {
  if (process.argv[2] !== 't') return require('../lib/cli.js').run(process);
  return require('../lib/report/run.js').runCapture(process, {});
};

start().then((code) => process.exit(code), fail);
