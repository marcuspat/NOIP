// Jest config for the security-context contract suite.
//
// Runs only `tests/contract/security/**/*.contract.spec.ts`. These tests
// shell out to real CLIs (trivy, kube-bench, kube-linter, gitleaks) and
// skip cleanly when those binaries are absent. The default `npm test`
// run uses jest.config.cjs and does NOT pick these up.

module.exports = {
  preset: 'ts-jest/presets/js-with-ts',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/contract/security'],
  testMatch: ['**/*.contract.spec.ts'],
  transformIgnorePatterns: ['/node_modules/(?!(uuid|jose|nanoid)/)'],
  testTimeout: 60_000,
  verbose: true,
};
