// Fixture for tests/unit/architecture/boundaries.spec.ts.
//
// `src/contexts/<ctx>/domain/**` must be infrastructure-free per ADR-0011
// and DDD-13. Importing `mongoose` (a persistence library) inside the
// domain layer is a violation enforced by the `no-restricted-imports` rule
// scoped to `src/contexts/*/domain/**/*.ts` in eslint.config.mjs.

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import mongoose from 'mongoose';

export const violation = 'discovery/domain→mongoose';
