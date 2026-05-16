// Re-export shim — sanitiser moved to
// `src/contexts/audit/application/`. Kept here so `src/middleware/audit.middleware.ts`
// and existing tests import paths continue to compile unchanged.

export {
  sanitise,
  __testing,
} from '../../contexts/audit/application/sanitiser';
export type {
  SanitiseInput,
  SanitiseOptions,
  SanitisedRequest,
  SanitisedResponse,
} from '../../contexts/audit/application/sanitiser';
