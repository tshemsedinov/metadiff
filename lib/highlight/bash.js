'use strict';

const core = require('./core.js');
const { SQUOTE, emit, wordStyle, readUntilNl } = core;

const BASH_QUOTE = `${SQUOTE}\``;

const KEYWORDS = [
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'function',
  'select',
  'in',
  'time',
  'coproc',
];

const BUILTINS = [
  'echo',
  'printf',
  'cd',
  'pwd',
  'exit',
  'export',
  'source',
  'alias',
  'unalias',
  'local',
  'declare',
  'typeset',
  'readonly',
  'unset',
  'shift',
  'read',
  'test',
  'true',
  'false',
  'exec',
  'eval',
  'set',
  'trap',
  'wait',
  'kill',
  'type',
  'command',
  'builtin',
  'return',
  'break',
  'continue',
  'pushd',
  'popd',
  'dirs',
  'getopts',
  'mapfile',
  'readarray',
  'let',
  'umask',
  'ulimit',
  'fg',
  'bg',
  'jobs',
  'hash',
  'help',
  'enable',
  'caller',
  'bind',
  'compgen',
  'complete',
];

const WORD_STYLE = {
  ...wordStyle(KEYWORDS, 'control'),
  ...wordStyle(BUILTINS, 'function'),
};

const readBashVar = (source, i) => {
  if (source[i + 1] === '{') {
    let j = i + 2;
    while (j < source.length && source[j] !== '}') j += 1;
    if (j < source.length) j += 1;
    return { text: source.slice(i, j), end: j };
  }
  if (/[0-9#?$!*@-]/.test(source[i + 1] || '')) {
    return { text: source.slice(i, i + 2), end: i + 2 };
  }
  let j = i + 1;
  while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
  if (j === i + 1) return { text: '$', end: i + 1 };
  return { text: source.slice(i, j), end: j };
};

const takeQuoted = (source, i) => {
  const q = source[i];
  let j = i + 1;
  const n = source.length;
  while (j < n && source[j] !== q) j += 1;
  if (j < n) j += 1;
  return { text: source.slice(i, j), end: j };
};

const takeBashDouble = (source, i, out) => {
  let j = i + 1;
  let chunk = '"';
  const n = source.length;
  while (j < n && source[j] !== '"') {
    if (source[j] === '\\' && j + 1 < n) {
      chunk += source.slice(j, j + 2);
      j += 2;
      continue;
    }
    if (source[j] === '$') {
      emit(out, 'string', chunk);
      chunk = '';
      const { text, end } = readBashVar(source, j);
      emit(out, 'variable', text);
      j = end;
      continue;
    }
    chunk += source[j];
    j += 1;
  }
  if (j < n) {
    chunk += '"';
    j += 1;
  }
  if (chunk) emit(out, 'string', chunk);
  return j;
};

const bashWordStyle = (word, nextCh) => {
  const known = WORD_STYLE[word];
  if (known) return known;
  if (nextCh === '=') return 'variable';
  return 'plain';
};

const highlight = (source) => {
  const out = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '#' && (i === 0 || /\s/.test(source[i - 1]))) {
      const { text, end } = readUntilNl(source, i);
      emit(out, 'comment', text);
      i = end;
      continue;
    }

    if (BASH_QUOTE.includes(ch)) {
      const { text, end } = takeQuoted(source, i);
      emit(out, 'string', text);
      i = end;
      continue;
    }

    if (ch === '"') {
      i = takeBashDouble(source, i, out);
      continue;
    }

    if (ch === '$') {
      const { text, end } = readBashVar(source, i);
      emit(out, 'variable', text);
      i = end;
      continue;
    }

    if (ch === '-' && /[A-Za-z0-9]/.test(next || '')) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_-]/.test(source[j])) j += 1;
      emit(out, 'attr', source.slice(i, j));
      i = j;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      const word = source.slice(i, j);
      emit(out, bashWordStyle(word, source[j]), word);
      i = j;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[0-9]/.test(source[j])) j += 1;
      emit(out, 'number', source.slice(i, j));
      i = j;
      continue;
    }

    if ('|&;<>(){}'.includes(ch)) {
      const j = i + ('|&><'.includes(ch) && next === ch ? 2 : 1);
      emit(out, 'operator', source.slice(i, j));
      i = j;
      continue;
    }

    emit(out, 'plain', ch);
    i += 1;
  }
  return out;
};

module.exports = {
  langs: ['bash'],
  aliases: { sh: 'bash', shell: 'bash', zsh: 'bash' },
  highlight,
};
