// Fixture for tests/unit/architecture/boundaries.spec.ts.
//
// ADR-0010: application-layer services (`src/contexts/<ctx>/application/**`)
// MUST NOT import `express`. HTTP types belong in the http/ layer; the
// application layer speaks domain concepts only. This is enforced via the
// `no-restricted-imports` rule scoped to the application folder in
// eslint.config.mjs.

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import express from 'express';

export const violation = 'dashboard/application→express';
