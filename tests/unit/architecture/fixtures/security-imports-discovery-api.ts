// Fixture for tests/unit/architecture/boundaries.spec.ts.
//
// Happy-path control: importing another context strictly via its public
// `api/` barrel is the supported way to collaborate across bounded
// contexts (ADR-0011). The boundaries test asserts ZERO errors fire here,
// proving the `except: ['./api']` allow-list in the cross-context zones
// behaves correctly.

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import * as discoveryApi from '../../discovery/api';

export const allowed = 'security→discovery/api (OK)';
