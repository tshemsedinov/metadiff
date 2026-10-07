'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { Linter } = require('eslint');

const SESSION_FILE = path.resolve(__dirname, '../lib/session.js');

const resolveRelative = (fromFile, spec) => {
  if (typeof spec !== 'string' || !spec.startsWith('.')) return null;
  let resolved = path.resolve(path.dirname(fromFile), spec);
  if (path.extname(resolved) === '') resolved += '.js';
  return path.normalize(resolved);
};

const requireSpecifier = (node) => {
  if (node.type === 'Literal') return node.value;
  if (node.type !== 'TemplateLiteral') return null;
  if (node.expressions.length) return null;
  return node.quasis[0].value.cooked;
};

const local = {
  rules: {
    'session-class-lines': {
      meta: {
        type: 'problem',
        schema: [{ type: 'integer', minimum: 1 }],
        messages: {
          tooLong: 'Session class is {{span}} lines (max {{max}}).',
        },
      },
      create(context) {
        const max = context.options[0] ?? 500;
        const check = (node) => {
          if (!node.id || node.id.name !== 'Session') return;
          const loc = node.loc;
          if (!loc) return;
          const span = loc.end.line - loc.start.line + 1;
          if (span <= max) return;
          context.report({
            node,
            messageId: 'tooLong',
            data: { span, max },
          });
        };
        return {
          ClassDeclaration: check,
          ClassExpression: check,
        };
      },
    },
    'no-session-require': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          forbidden: 'Session modules must not import Session.',
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            if (node.callee.type !== 'Identifier') return;
            if (node.callee.name !== 'require') return;
            if (node.arguments.length !== 1) return;
            const spec = requireSpecifier(node.arguments[0]);
            const resolved = resolveRelative(context.filename, spec);
            if (resolved !== SESSION_FILE) return;
            context.report({ node, messageId: 'forbidden' });
          },
        };
      },
    },
  },
};

const FUNCTION_RULE = [
  'error',
  {
    max: 100,
    skipBlankLines: false,
    skipComments: false,
    IIFEs: true,
  },
];

const lint = (code, rules, filename = 'file.js') => {
  const linter = new Linter();
  return linter.verify(
    code,
    [
      {
        files: ['**/*.js'],
        languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs' },
        plugins: { local },
        rules,
      },
    ],
    { filename },
  );
};

const checkDirectory = (directory, messages) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      checkDirectory(filename, messages);
      continue;
    }
    if (!filename.endsWith('.js')) continue;
    const rules = {
      'max-lines': ['error', 1000],
      'max-lines-per-function': FUNCTION_RULE,
      'local/session-class-lines': ['error', 500],
    };
    const sessionDir = path.join(path.dirname(SESSION_FILE), 'session');
    if (filename.startsWith(`${sessionDir}${path.sep}`)) {
      rules['local/no-session-require'] = 'error';
    }
    const code = fs.readFileSync(filename, 'utf8');
    for (const result of lint(code, rules, filename)) {
      messages.push(`${filename}:${result.line}: ${result.message}`);
    }
  }
};

test('lib files satisfy the structural limits and dependency direction', () => {
  const messages = [];
  checkDirectory(path.dirname(SESSION_FILE), messages);
  assert.deepEqual(messages, []);
});
