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
//
// Architectural boundary enforcement (ADR-0010 + ADR-0011 + ADR-0022) is
// configured via `eslint-plugin-import`'s `no-restricted-paths` rule and a
// supplementary `no-restricted-imports` rule for third-party libraries the
// domain layer must not see. The zones below mirror the matrix documented in
// ADR-0022 § "Architecture-enforcement rules".
import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';
import prettierRecommended from 'eslint-plugin-prettier/recommended';

// `@typescript-eslint/eslint-plugin@8` ships flat-config arrays under
// `configs['flat/...']`. The `flat/recommended` entry is an array of
// flat-config objects ready to be spread into the exported config.
const tsRecommendedFlat = tsPlugin.configs['flat/recommended'];

// Bounded contexts that own a `src/contexts/<ctx>/` folder (existing or
// planned per ADR-0011 / DDD-03). Each context gets a zone that forbids
// sibling contexts from reaching anything but its `api/index.ts` barrel.
// Adding a new context here is the one-line change required to bring it
// under boundary enforcement.
const CONTEXTS = [
  'ai',
  'discovery',
  'security',
  'audit',
  'iam',
  'dashboard',
  'performance',
];

// Cross-context isolation: for each context `<ctx>`, forbid any file under
// `src/contexts/<ctx>/**` from importing anything inside a sibling
// `src/contexts/<other>/` *except* the sibling's `api/` barrel. This is the
// ADR-0011 "Public-API rule" in lint form.
//
// `eslint-plugin-import`'s `no-restricted-paths` semantics (verified by
// reading lib/rules/no-restricted-paths.js):
//   * `target`  — the directory whose files have the restriction (the
//                 *importer* — current file being linted).
//   * `from`    — the directory whose files MUST NOT be imported.
//   * `except`  — sub-paths of `from` that ARE allowed to be imported
//                 (e.g. the context's public `api/` barrel).
// Naming is counter-intuitive: "from" reads as "the source you import
// FROM", not the importer. So "iam cannot reach into discovery internals"
// becomes: target=iam (the importer), from=discovery (the forbidden source
// to import from), except=['./api'] (allow `discovery/api`).
const crossContextZones = CONTEXTS.flatMap((ctx) =>
  CONTEXTS.filter((other) => other !== ctx).map((other) => ({
    target: `./src/contexts/${ctx}`,
    from: `./src/contexts/${other}`,
    except: [`./api`],
    message: `Cross-context imports must go through src/contexts/${other}/api/index.ts (ADR-0011 Public-API rule).`,
  })),
);

// ADR-0010 layered architecture: lower layers must not import from upper
// layers. `models/` and `types/` are leaf layers; `shared/kernel/` is the
// leaf-most of all per ADR-0011 Shared Kernel rules.
//
// Per the direction convention documented above: `target` is the *importer*
// (the layer with the restriction). "models cannot import services" →
// target=models, from=services.
const layerZones = [
  // models/ — domain entities, framework-free. Cannot reach upward into
  // services / controllers / routes / contexts.
  {
    target: './src/models',
    from: './src/services',
    message: 'ADR-0010: models cannot import from services (top-down rule).',
  },
  {
    target: './src/models',
    from: './src/controllers',
    message: 'ADR-0010: models cannot import from controllers (top-down rule).',
  },
  {
    target: './src/models',
    from: './src/routes',
    message: 'ADR-0010: models cannot import from routes (top-down rule).',
  },
  {
    target: './src/models',
    from: './src/contexts',
    message: 'ADR-0010: models cannot import from contexts (top-down rule).',
  },

  // types/ — shared type declarations, also a leaf.
  {
    target: './src/types',
    from: './src/services',
    message: 'ADR-0010: types cannot import from services (top-down rule).',
  },
  {
    target: './src/types',
    from: './src/controllers',
    message: 'ADR-0010: types cannot import from controllers (top-down rule).',
  },
  {
    target: './src/types',
    from: './src/routes',
    message: 'ADR-0010: types cannot import from routes (top-down rule).',
  },
  {
    target: './src/types',
    from: './src/contexts',
    message: 'ADR-0010: types cannot import from contexts (top-down rule).',
  },

  // shared/kernel/ — the leaf-most module (DDD-04 Shared Kernel).
  {
    target: './src/shared/kernel',
    from: './src/services',
    message: 'ADR-0011: shared kernel cannot import from services.',
  },
  {
    target: './src/shared/kernel',
    from: './src/controllers',
    message: 'ADR-0011: shared kernel cannot import from controllers.',
  },
  {
    target: './src/shared/kernel',
    from: './src/routes',
    message: 'ADR-0011: shared kernel cannot import from routes.',
  },
  {
    target: './src/shared/kernel',
    from: './src/middleware',
    message: 'ADR-0011: shared kernel cannot import from middleware.',
  },
  {
    target: './src/shared/kernel',
    from: './src/contexts',
    message: 'ADR-0011: shared kernel cannot import from contexts.',
  },
  {
    target: './src/shared/kernel',
    from: './src/utils',
    message: 'ADR-0011: shared kernel cannot import from utils.',
  },
  {
    target: './src/shared/kernel',
    from: './src/database',
    message: 'ADR-0011: shared kernel cannot import from database.',
  },
];

const allZones = [...layerZones, ...crossContextZones];

// Third-party libraries forbidden inside any `src/contexts/<ctx>/domain/**`
// file. The domain layer must be infrastructure-free per ADR-0011 and
// DDD-13. Application layer (use-case services) additionally must not see
// `express` per ADR-0010 (HTTP types stay in the http/ layer).
const FORBIDDEN_IN_DOMAIN = [
  'express',
  'mongoose',
  'ioredis',
  '@kubernetes/client-node',
  '@anthropic-ai/sdk',
];

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
      // Architecture-boundary fixtures intentionally violate lint rules so
      // the test suite can assert each zone fires; they are linted on
      // demand by tests/unit/architecture/boundaries.spec.ts.
      'tests/unit/architecture/fixtures/**',
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

  // Architecture-boundary enforcement (ADR-0010 + ADR-0011 + ADR-0022).
  // Applied to every source file under src/ so layer and cross-context
  // rules are evaluated regardless of which folder the importer lives in.
  //
  // `import/no-restricted-paths` silently skips imports whose targets it
  // cannot resolve, so we must teach the node resolver about TypeScript
  // extensions; without `.ts` in `extensions`, the rule would be a no-op
  // for a TS-only codebase.
  {
    files: ['src/**/*.ts'],
    plugins: {
      import: importPlugin,
    },
    settings: {
      'import/resolver': {
        node: {
          extensions: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.d.ts'],
        },
      },
    },
    rules: {
      'import/no-restricted-paths': [
        'error',
        {
          zones: allZones,
        },
      ],
    },
  },

  // Domain-layer purity: no infrastructure libraries inside any
  // `src/contexts/<ctx>/domain/**`. `no-restricted-paths` cannot match on
  // a package-name `from`, so we use `no-restricted-imports` here.
  {
    files: ['src/contexts/*/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: FORBIDDEN_IN_DOMAIN.map((name) => ({
            name,
            message:
              'ADR-0011: domain layer must be infrastructure-free; move this dependency into infrastructure/.',
          })),
          patterns: [
            {
              group: ['@aws-sdk/**'],
              message:
                'ADR-0011: domain layer must be infrastructure-free; move this dependency into infrastructure/.',
            },
          ],
        },
      ],
    },
  },

  // Application-layer rule: services don't see Express types.
  {
    files: ['src/contexts/*/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'express',
              message:
                'ADR-0010: application services must not import express; HTTP types belong in the http/ layer.',
            },
          ],
        },
      ],
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
