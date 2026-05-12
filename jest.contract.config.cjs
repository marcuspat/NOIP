// Jest config for the contract-test suite.
//
// Targets `tests/contract/**/*.contract.spec.ts` ONLY. These tests run
// against real external services (e.g. ChromaDB) and are skip-gated by
// availability probes — never expect them to be invoked by the default
// `npm test` script.
//
// Run with:
//   CHROMA_URL=http://localhost:8000 npm run test:contract
//
// See tests/contract/ai/README.md for setup and CI guidance.

module.exports = {
  preset: 'ts-jest/presets/js-with-ts',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/contract'],
  testMatch: ['**/*.contract.spec.ts'],
  transformIgnorePatterns: ['/node_modules/(?!(uuid|jose|nanoid)/)'],
  // No coverage thresholds — contract tests are about wire fidelity,
  // not line coverage of the adapter itself (that's the unit suite's
  // job).
  collectCoverage: false,
  // The unit-test setup file forces `services.ai.enabled = false` and
  // points mongo/redis at test URIs we don't need for contract tests.
  // Contract tests speak HTTP only.
  testTimeout: 30000,
  verbose: true,
};
