// Value objects for the Audit & Observability bounded context.
//
// Per DDD-11 §"Value Objects" we host the small, immutable types here
// so both the application services and the API barrel can reference a
// single source of truth. The Mongoose persistence layer reuses the
// raw shapes via `tsc`-level structural typing — there is no runtime
// schema validation here (that's the schema layer's job).

import type { AuditId, SessionId, UserId } from '../../../shared/kernel';

/**
 * Reference to the actor responsible for an audited interaction.
 * Exactly one of `userId` / `serviceAccountId` should be populated
 * for non-system actions; `system: true` is reserved for
 * unauthenticated paths (e.g. health probes) and scheduled jobs.
 */
export interface ActorRef {
  userId?: string;
  serviceAccountId?: string;
  system?: boolean;
}

/**
 * Hash-chain coordinates stamped onto every persisted audit entry.
 *
 * `currentHash = sha256( canonical_json(entryWithoutChain) || previousHash )`.
 * `previousHash` is `'0'.repeat(64)` for the genesis entry of a shard.
 */
export interface HashChain {
  shard: string;
  sequence: number;
  previousHash: string;
  currentHash: string;
}

/** Filter for `AuditService.query` — fields are AND-ed. */
export interface AuditFilter {
  actor?: { userId?: string; serviceAccountId?: string };
  action?: string;
  resource?: string;
  resourceId?: string;
  from?: Date;
  to?: Date;
  shard?: string;
  /** Page size; capped to 1000 by the service. */
  limit?: number;
  /** Skip count for naive paging. Prefer `cursor` when available. */
  offset?: number;
}

/** Cursor-free paged result. The next page can be fetched with `offset + items.length`. */
export interface AuditPage {
  items: ReadonlyArray<{
    id: AuditId;
    actor: ActorRef;
    action: string;
    resource: string;
    resourceId?: string;
    details: Record<string, unknown>;
    ipAddress: string;
    userAgent: string;
    sessionId?: SessionId;
    timestamp: Date;
    chain: HashChain;
  }>;
  total: number;
  offset: number;
  limit: number;
}

/** Inclusive time range used by chain integrity and archive selectors. */
export interface TimeRange {
  from: Date;
  to: Date;
}

/** Filter for `AuditService.listSecurityEvents`. AND-ed across fields. */
export interface SecurityEventFilter {
  userId?: UserId | string;
  type?: string;
  severity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  resolved?: boolean;
  from?: Date;
  to?: Date;
  limit?: number;
}

/**
 * Cursor for the streaming-archive read path. Encapsulates how the
 * archive service walks Mongo without buffering — the repository
 * implements it via `Model.find(...).cursor()`.
 */
export interface AuditEntryCursor {
  next(): Promise<{
    actor: ActorRef;
    action: string;
    resource: string;
    resourceId?: string;
    details: Record<string, unknown>;
    ipAddress: string;
    userAgent: string;
    sessionId?: string;
    timestamp: Date;
    chain: HashChain;
  } | null>;
  close(): Promise<void>;
}
