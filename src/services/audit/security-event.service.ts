// Re-export shim — the SecurityEventService has moved to
// `src/contexts/audit/application/`. Legacy callers (`src/app.ts`,
// existing test suites) continue to import from this path; new
// callers should reach for `src/contexts/audit/api`.

export {
  SecurityEventService,
  defaultSeverityFor,
} from '../../contexts/audit/application/security-event.service';
export type {
  SecurityEventInput,
  SecurityEventLogger,
  SecurityEventPersistShape,
  SecurityEventStore,
} from '../../contexts/audit/application/security-event.service';
