// Re-export of the `AuditLogEntry` aggregate shape.
//
// The Mongoose model in `src/models/audit-log.model.ts` is the canonical
// source of truth (it enforces the append-only invariants at the
// driver level). DDD-11 reaches the same shape via this aggregate
// module so callers inside the context don't need to know about the
// `src/models/` location. The model itself remains there to avoid
// disturbing other model imports — DDD-14 will move it under
// `infrastructure/persistence/` in a later pass.

export type {
  AuditLogEntry,
  AuditLogDocument,
  HashChain,
  ActorRef,
} from '../../../models/audit-log.model';
export { AuditLogModel, AuditLogSchema } from '../../../models/audit-log.model';
