'use strict';
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/', 'trip.db*', '.claude/'] },
  js.configs.recommended,
  {
    files: ['server.js', 'eslint.config.js', 'lib/**/*.js', 'test/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: globals.node },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: globals.browser },
    rules: { 'no-implicit-globals': 'error' },
  },
  {
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }], // allow the `x == null` idiom
      'prefer-const': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
];
