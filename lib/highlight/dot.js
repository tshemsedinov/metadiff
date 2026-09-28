'use strict';

const core = require('./core.js');
const { emit, highlightLines } = core;

const highlightDotLine = (line) => {
  if (!line) return [];
  const out = [];
  const t = line.trimStart();
  if (t.startsWith('#') || t.startsWith(';')) {
    emit(out, 'comment', line);
    return out;
  }
  if (t.startsWith('!')) {
    const lead = line.slice(0, line.length - t.length);
    emit(out, 'plain', lead);
    emit(out, 'operator', '!');
    emit(out, 'plain', t.slice(1));
    return out;
  }
  const eq = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)(.*)$/);
  if (eq) {
    emit(out, 'plain', eq[1]);
    emit(out, 'variable', eq[2]);
    emit(out, 'operator', eq[3]);
    emit(out, 'string', eq[4]);
    return out;
  }
  emit(out, 'plain', line);
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
