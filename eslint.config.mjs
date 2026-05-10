// ESLint v9 flat config.
//
// We do not depend on the umbrella `typescript-eslint` package; instead we use
// `@typescript-eslint/eslint-plugin@8`'s `configs['flat/recommended']` array
// (which is the modern flat-config shape this version ships) plus the
// `@typescript-eslint/parser` package directly. This keeps devDependencies
// small while still using the recommended rule set.
//
// `eslint-plugin-prettier`'s flat `recommended` block surfaces prettier
// diffs as lint errors, and `eslint-config-prettier` (already pulled in by
// the prettier plugin) turns off conflicting stylistic rules.
import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierRecommended from 'eslint-plugin-prettier/recommended';

// `@typescript-eslint/eslint-plugin@8` ships flat-config arrays under
// `configs['flat/...']`. The `flat/recommended` entry is an array of
// flat-config objects ready to be spread into the exported config.
const tsRecommendedFlat = tsPlugin.configs['flat/recommended'];

export default [
  // Global ignores must live in their own object with no `files` key so
  // that ESLint applies them as global ignores rather than file-scoped.
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      '*.config.js',
      '*.config.cjs',
      '*.config.mjs',
      // k6 load-test scripts run externally with their own globals
      // (`__ENV`, k6 modules) — not part of the Jest test pyramid.
      'tests/performance/*.js',
    ],
  },

  // Baseline JS recommended rules.
  js.configs.recommended,

  // typescript-eslint v8 flat/recommended (registers the parser, the
  // `@typescript-eslint` plugin, and a curated rule set for *.ts files).
  ...tsRecommendedFlat,

  // Project-wide TypeScript settings & rules. We intentionally do NOT pass
  // a `project` to the parser; type-aware linting is too slow for the
  // `lint:check` gate and is not required by the rules we have enabled.
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        module: 'readonly',
        require: 'readonly',
        exports: 'readonly',
        global: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        NodeJS: 'readonly',
        jest: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        describe: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/interface-name-prefix': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // `process.env.X` access is idiomatic in Node and is enforced at the
      // tsc level via `noPropertyAccessFromIndexSignature` already; we don't
      // need ESLint to also flag it.
      '@typescript-eslint/dot-notation': 'off',
      'dot-notation': 'off',
      'no-console': 'warn',
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  // Tests: relax a few strictness rules where speed/clarity matters more
  // than type-perfection.
  {
    files: ['tests/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },

  // Prettier integration must come last so it can turn off any stylistic
  // rules enabled above and surface prettier diffs as lint errors.
  prettierRecommended,
];
