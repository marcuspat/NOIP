// Fixture for tests/unit/architecture/boundaries.spec.ts.
//
// ADR-0011 Public-API rule: cross-context imports MUST go through the
// target context's `api/index.ts` barrel. Here `security` reaches into
// `discovery/infrastructure/**` directly — a clear violation flagged by
// the `import/no-restricted-paths` cross-context zone.

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import * as clusterSchema from '../../discovery/infrastructure/persistence/cluster.schema';

export const violation = 'security→discovery/infrastructure';
