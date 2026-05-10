// Jest config kept as .cjs because package.json has `"type": "module"`,
// which would otherwise cause Jest to try to load the config as ESM and
// fail. There is exactly one Jest config file in this repo; do not add
// jest.config.js / jest.config.mjs alongside it.
//
// We use ts-jest's `js-with-ts` preset (instead of the default `ts-jest`
// preset) so that .js files inside node_modules can be transformed too
// when allow-listed via `transformIgnorePatterns`. Several runtime deps
// (uuid v9+, jose, nanoid) ship as ESM-only and would otherwise throw
// "Unexpected token 'export'" inside Jest's CJS pipeline.
module.exports = {
  preset: 'ts-jest/presets/js-with-ts',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  // Allow-list ESM-only packages so they get transformed by ts-jest. The
  // default Jest behavior is to skip everything in node_modules.
  transformIgnorePatterns: ['/node_modules/(?!(uuid|jose|nanoid)/)'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/app.ts'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  testTimeout: 30000,
  verbose: true,
};
