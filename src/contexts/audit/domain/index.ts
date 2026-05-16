// Audit domain barrel — re-exports the aggregates, value objects,
// and port interfaces so application services and the public API
// barrel can pull a single import.

export type {
  ActorRef,
  AuditEntryCursor,
  AuditFilter,
  AuditPage,
  HashChain,
  SecurityEventFilter,
  TimeRange,
} from './value-objects';
export type { ChainIntegrityReport } from './chain-integrity-report';
export {
  RetentionPolicy,
  DEFAULT_RETENTION,
  type RetentionCollection,
  type RetentionPolicyProps,
} from './retention-policy';
export type { AuditLogEntry, AuditLogDocument } from './audit-log-entry';
export { AuditLogModel, AuditLogSchema } from './audit-log-entry';
export type {
  SecurityEvent,
  SecurityEventDocument,
  SecurityEventModelType,
} from './security-event';
export {
  SecurityEventModel,
  SecurityEventType,
  SecurityEventSeverity,
} from './security-event';
export type {
  AuditArchiveStore,
  AuditArchiveUploadOpts,
  AuditArchiveUploadResult,
} from './ports/archive-store';
export { buildAuditArchiveKey } from './ports/archive-store';
export type {
  TransparencyLog,
  TransparencyLogReceipt,
  TransparencyLogSubmission,
} from './ports/transparency-log';
