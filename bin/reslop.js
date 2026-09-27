#!/usr/bin/env node
'use strict';

const cli = require('../lib/cli.js');
const { run, errorMessage } = cli;
const session = require('../lib/session.js');
const { LEAVE_TERM } = session;

const fail = (reason) => {
  try {
    process.stdout.write(LEAVE_TERM);
  } catch {
    // ignore
  }
  process.stderr.write(`reslop: ${errorMessage(reason)}\n`);
  process.exit(1);
};

process.on('uncaughtException', (error) => fail(error));
process.on('unhandledRejection', (reason) => fail(reason));

run(process).then(
  (code) => {
    process.exit(code);
  },
  (error) => fail(error),
);
