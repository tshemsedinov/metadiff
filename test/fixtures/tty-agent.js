'use strict';

const out = process.stdout;
const inn = process.stdin;
out.write(`tty=${out.isTTY}/${inn.isTTY}\n`);
inn.setRawMode(true);
inn.on('data', (buf) => {
  out.write(`key=${JSON.stringify(buf.toString())}\n`);
  process.exit(0);
});
setTimeout(() => process.exit(2), 4000);
