'use strict';

const { emit, highlightLines } = require('./core.js');

const ASSIGN_RE = /^(\s*)([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)(.*)$/;

const highlightDotLine = (line) => {
  const out = [];
  const trimmed = line.trimStart();
  if (trimmed.startsWith('#') || trimmed.startsWith(';')) {
    emit(out, 'comment', line);
    return out;
  }
  if (trimmed.startsWith('!')) {
    emit(out, 'plain', line.slice(0, line.length - trimmed.length));
    emit(out, 'operator', '!');
    emit(out, 'plain', trimmed.slice(1));
    return out;
  }
  const assign = ASSIGN_RE.exec(line);
  if (!assign) {
    emit(out, 'plain', line);
    return out;
  }
  emit(out, 'plain', assign[1]);
  emit(out, 'variable', assign[2]);
  emit(out, 'operator', assign[3]);
  emit(out, 'string', assign[4]);
  return out;
};

module.exports = {
  langs: ['dot'],
  aliases: {
    env: 'dot',
    ini: 'dot',
    conf: 'dot',
    cfg: 'dot',
    yaml: 'dot',
    yml: 'dot',
    toml: 'dot',
  },
  highlight: highlightLines(highlightDotLine),
};
