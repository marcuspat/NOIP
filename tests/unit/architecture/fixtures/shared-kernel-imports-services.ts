// Fixture for tests/unit/architecture/boundaries.spec.ts.
//
// `src/shared/kernel/**` is the leaf-most layer (DDD-04 Shared Kernel) and
// MUST NOT reach upward into application code such as `src/services/**`.
// The boundaries test lints this with a virtual filename that places it
// inside `src/shared/kernel/` and asserts the
// `import/no-restricted-paths` zone fires.

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import * as authSvc from '../../services/auth.service';

export const violation = 'shared/kernel→services';
