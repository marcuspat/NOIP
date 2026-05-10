// Public surface of the shared kernel. Importers outside the kernel
// should pull from this barrel rather than reaching into individual
// modules so the internal layout can evolve.

export type {
  Id,
  UserId,
  RoleId,
  PermissionId,
  SessionId,
  ApiKeyId,
  ServiceAccountId,
  ClusterId,
  ScanId,
  SnapshotId,
  DriftId,
  FindingId,
  PolicyId,
  ReportId,
  AnalysisId,
  PatternId,
  ContextId,
  ProbeId,
  LoadTestId,
  SLOId,
  DashboardId,
  WidgetId,
  AuditId,
  EventId,
} from './ids';
export { newId, parseId, tryParseId } from './ids';

export type { Instant, DurationMs, Clock } from './time';
export { asInstant, asDurationMs, SystemClock, FixedClock } from './time';

export type {
  DomainEvent,
  DomainEventActor,
  EventHandler,
  EventBus,
  EventBusLogger,
  Unsubscribe,
  ComposeClock,
} from './events';
export { InMemoryEventBus, compose } from './events';

export type { Result, Ok, Err } from './result';
export { ok, err, isOk, isErr, map, mapErr, unwrap } from './result';
