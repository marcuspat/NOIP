// Fixture for tests/unit/architecture/boundaries.spec.ts.
//
// This file is INTENTIONALLY ill-formed: a `src/models/**` file is not
// allowed to import a `src/controllers/**` file (ADR-0010 top-down rule).
// The boundaries test lints this snippet with a virtual filename that
// places it inside `src/models/` and asserts that the
// `import/no-restricted-paths` zone fires.
//
// This file is in the global `ignores` list in eslint.config.mjs so a
// regular `npm run lint:check` does not flag it.

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import * as ctrl from '../controllers/auth.controller';

export const violation = 'models→controllers';
