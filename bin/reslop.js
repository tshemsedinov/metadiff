#!/usr/bin/env node
'use strict';

const { run, errorMessage } = require('../lib/cli.js');
const { LEAVE_TERM } = require('../lib/session.js');

const fail = (reason) => {
  try {
    process.stdout.write(LEAVE_TERM);
  } catch {
    // ignore
  }
  process.stderr.write(`reslop: ${errorMessage(reason)}\n`);
  process.exit(1);
};

process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

run(process).then((code) => process.exit(code), fail);
