// Re-export shim — audit event subscribers moved to
// `src/contexts/audit/application/`. Kept here so `src/app.ts` and the
// existing test suite import path keep compiling unchanged.

export {
  installAuditSubscribers,
  toSecurityEventInput,
} from '../../contexts/audit/application/event-subscribers';
export type {
  AuditSubscribersLogger,
  InstallAuditSubscribersDeps,
} from '../../contexts/audit/application/event-subscribers';
