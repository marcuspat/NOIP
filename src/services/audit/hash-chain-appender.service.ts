// HashChainAppender — domain service that owns the tamper-evident chain
// across audit entries.
//
// Per ADR-0017 §"Tamper evidence" / DDD-11 §"Domain Services" the chain
// holds the invariant
//
//   currentHash_n = sha256( canonical_json(entry_n_without_chain) || previousHash_n )
//
// where `previousHash_n` is the prior entry's `currentHash` for the same
// shard, or `'0' * 64` for the genesis entry.
//
// Single-writer-per-shard semantics: appends are serialised through an
// in-process Promise-chained queue keyed by shard. The `(shard, sequence)`
// unique index in `audit-log.model.ts` is the backstop for cross-process
// races (multi-pod deployments) — if it fires we re-read and retry once.

import { createHash } from 'crypto';

import {
  compose,
  type Clock,
  type DomainEvent,
  type EventBus,
} from '../../shared/kernel';
import type { AuditLogEntry, ActorRef } from '../../models/audit-log.model';

/** Logger surface limited to what this service uses. */
export interface AuditLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Minimal collection surface so this service can be unit-tested with a
 * lightweight stub. Mongoose's `Model` exposes a superset of these methods.
 */
export interface AuditCollection {
  findOne(
    filter: Record<string, unknown>,
    options?: { sort?: Record<string, 1 | -1> }
  ): Promise<AuditLogEntry | null>;
  insertOne(entry: AuditLogEntry): Promise<{ insertedId: unknown }>;
  findRange(
    shard: string,
    fromSeq: number,
    toSeq: number
  ): Promise<AuditLogEntry[]>;
}

/** Input to `append` — the chain fields are computed by this service. */
export interface AuditEntryInput {
  actor: ActorRef;
  action: string;
  resource: string;
  resourceId?: string;
  details: Record<string, unknown>;
  ipAddress: string;
  userAgent: string;
  sessionId?: string;
  /** Optional — defaults to `'global'` (single shard until DDD-11 sharding). */
  shard?: string;
}

export interface ChainIntegrityReport {
  ok: boolean;
  shard: string;
  fromSequence: number;
  toSequence: number;
  /** Number of entries actually verified. */
  checked: number;
  brokenAtSequence?: number;
  expectedHash?: string;
  actualHash?: string;
}

const GENESIS_PREVIOUS_HASH = '0'.repeat(64);
export const DEFAULT_SHARD = 'global';

interface Deps {
  collection: AuditCollection;
  clock: Clock;
  logger: AuditLogger;
  /**
   * Optional EventBus. When provided, chain breaks are published as
   * `audit.chain.broken` DomainEvents in addition to the structured
   * `logger.error` line. The composition root injects the live bus; tests
   * may pass a stub or omit it entirely (logger-only path).
   */
  eventBus?: EventBus;
}

/**
 * Deterministic JSON serialisation used to compute the chain hash.
 * Object keys are sorted recursively; arrays preserve order; no
 * whitespace. Functions, undefined, and Symbol values are stripped (they
 * cannot appear in audit input but the contract is explicit).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

function canonicalise(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key];
      if (v === undefined) continue;
      if (typeof v === 'function' || typeof v === 'symbol') continue;
      out[key] = canonicalise(v);
    }
    return out;
  }
  if (typeof value === 'function' || typeof value === 'symbol') return null;
  return value;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Computes the hash for a candidate entry.
 *
 * Note: the input to the hash is `canonical_json(entryWithoutChain) || previousHash`,
 * where `||` is string concatenation. This matches ADR-0017 verbatim.
 */
export function computeEntryHash(
  entryWithoutChain: Omit<AuditLogEntry, 'chain' | '_id'>,
  previousHash: string
): string {
  return sha256Hex(canonicalJson(entryWithoutChain) + previousHash);
}

/**
 * Per-shard mutex implemented as a Promise chain. Tasks queued for the
 * same shard run strictly in order; tasks for different shards proceed
 * concurrently. We never busy-wait — the queue resolves on the prior
 * task's microtask, yielding the event loop naturally.
 */
class ShardMutex {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(shard: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(shard) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(resolve => {
      release = resolve;
    });
    // The new tail is the chain *up to and including* this task.
    this.tails.set(
      shard,
      previous.then(() => next)
    );
    return previous.then(async () => {
      try {
        return await task();
      } finally {
        release();
        // If we're still the tail, drop the entry to avoid an unbounded
        // map across long-lived shards.
        if (this.tails.get(shard) === previous.then(() => next)) {
          // best-effort cleanup; benign if a newer task replaced us
          this.tails.delete(shard);
        }
      }
    });
  }
}

export class HashChainAppender {
  private readonly mutex = new ShardMutex();

  constructor(private readonly deps: Deps) {}

  async append(entry: AuditEntryInput): Promise<AuditLogEntry> {
    const shard = entry.shard ?? DEFAULT_SHARD;
    return this.mutex.run(shard, () => this.appendLocked(entry, shard));
  }

  private async appendLocked(
    entry: AuditEntryInput,
    shard: string,
    attempt = 0
  ): Promise<AuditLogEntry> {
    const previous = await this.deps.collection.findOne(
      { 'chain.shard': shard },
      { sort: { 'chain.sequence': -1 } }
    );

    const previousSequence = previous ? previous.chain.sequence : -1;
    const previousHash = previous
      ? previous.chain.currentHash
      : GENESIS_PREVIOUS_HASH;
    const sequence = previousSequence + 1;

    const entryWithoutChain: Omit<AuditLogEntry, 'chain' | '_id'> = {
      actor: entry.actor,
      action: entry.action,
      resource: entry.resource,
      ...(entry.resourceId !== undefined
        ? { resourceId: entry.resourceId }
        : {}),
      details: entry.details,
      ipAddress: entry.ipAddress,
      userAgent: entry.userAgent,
      ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
      timestamp: this.deps.clock.now(),
    };

    // Hash exactly once; the resulting string is stored verbatim.
    const currentHash = computeEntryHash(entryWithoutChain, previousHash);

    const candidate: AuditLogEntry = {
      ...(entryWithoutChain as Omit<AuditLogEntry, 'chain'>),
      chain: { shard, sequence, previousHash, currentHash },
    } as AuditLogEntry;

    try {
      await this.deps.collection.insertOne(candidate);
      return candidate;
    } catch (err: unknown) {
      if (isDuplicateKeyError(err) && attempt === 0) {
        // Another writer (or pod) raced us on the same (shard, sequence).
        // Re-read and retry exactly once. Beyond one retry we surface the
        // failure so callers can decide whether to drop the entry.
        this.deps.logger.warn('audit chain: duplicate sequence, retrying', {
          shard,
          sequence,
        });
        return this.appendLocked(entry, shard, attempt + 1);
      }
      throw err;
    }
  }

  /**
   * Verifies the chain over `[fromSeq, toSeq]` (inclusive). Reads entries
   * in sequence order and recomputes hashes. Stops at the first break and
   * emits `audit.chain.broken` via the logger for ops to pick up.
   *
   * The first verified entry's `previousHash` must equal either the
   * predecessor's `currentHash` (when `fromSeq > 0`) or
   * `'0' * 64` (genesis case).
   */
  async verifyRange(
    shard: string,
    fromSeq: number,
    toSeq: number
  ): Promise<ChainIntegrityReport> {
    if (toSeq < fromSeq) {
      return {
        ok: true,
        shard,
        fromSequence: fromSeq,
        toSequence: toSeq,
        checked: 0,
      };
    }

    const entries = await this.deps.collection.findRange(shard, fromSeq, toSeq);

    let expectedPrevious: string;
    if (fromSeq === 0) {
      expectedPrevious = GENESIS_PREVIOUS_HASH;
    } else {
      const predecessor = await this.deps.collection.findOne({
        'chain.shard': shard,
        'chain.sequence': fromSeq - 1,
      });
      if (!predecessor) {
        return {
          ok: false,
          shard,
          fromSequence: fromSeq,
          toSequence: toSeq,
          checked: 0,
          brokenAtSequence: fromSeq,
          expectedHash: '<missing-predecessor>',
          actualHash: '<n/a>',
        };
      }
      expectedPrevious = predecessor.chain.currentHash;
    }

    let checked = 0;
    for (const entry of entries) {
      const { chain, ...rest } = entry as AuditLogEntry & { _id?: unknown };
      // Drop `_id` (Mongo-assigned) before hashing — it isn't part of the
      // canonical record.
      const withoutId: Omit<AuditLogEntry, 'chain' | '_id'> = {
        actor: rest.actor,
        action: rest.action,
        resource: rest.resource,
        ...(rest.resourceId !== undefined
          ? { resourceId: rest.resourceId }
          : {}),
        details: rest.details,
        ipAddress: rest.ipAddress,
        userAgent: rest.userAgent,
        ...(rest.sessionId !== undefined ? { sessionId: rest.sessionId } : {}),
        timestamp: rest.timestamp,
      };

      if (chain.previousHash !== expectedPrevious) {
        this.emitBroken(
          shard,
          chain.sequence,
          expectedPrevious,
          chain.previousHash,
          'previousHash mismatch'
        );
        return {
          ok: false,
          shard,
          fromSequence: fromSeq,
          toSequence: toSeq,
          checked,
          brokenAtSequence: chain.sequence,
          expectedHash: expectedPrevious,
          actualHash: chain.previousHash,
        };
      }

      const recomputed = computeEntryHash(withoutId, chain.previousHash);
      if (recomputed !== chain.currentHash) {
        this.emitBroken(
          shard,
          chain.sequence,
          recomputed,
          chain.currentHash,
          'currentHash mismatch'
        );
        return {
          ok: false,
          shard,
          fromSequence: fromSeq,
          toSequence: toSeq,
          checked,
          brokenAtSequence: chain.sequence,
          expectedHash: recomputed,
          actualHash: chain.currentHash,
        };
      }

      expectedPrevious = chain.currentHash;
      checked++;
    }

    return {
      ok: true,
      shard,
      fromSequence: fromSeq,
      toSequence: toSeq,
      checked,
    };
  }

  private emitBroken(
    shard: string,
    atSequence: number,
    expectedHash: string,
    actualHash: string,
    reason: string
  ): void {
    // Always log first — the structured line is the primary signal for
    // ops alerting and remains intact when the bus is absent (tests, dry
    // runs). The DomainEvent below is the new ADR-0018 surface.
    this.deps.logger.error('audit.chain.broken', {
      shard,
      atSequence,
      expectedHash,
      actualHash,
      reason,
    });
    if (!this.deps.eventBus) return;
    try {
      const event: DomainEvent<{
        shard: string;
        atSequence: number;
        expectedHash: string;
        actualHash: string;
        reason: string;
      }> = compose(
        {
          type: 'audit.chain.broken',
          context: 'audit',
          aggregateType: 'chain',
          aggregateId: shard,
          actor: { type: 'system' },
          payload: { shard, atSequence, expectedHash, actualHash, reason },
        },
        this.deps.clock
      );
      this.deps.eventBus.publish(event);
    } catch (err) {
      // Don't recurse into append; just log.
      this.deps.logger.error('failed to publish audit.chain.broken event', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function isDuplicateKeyError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { code?: number; codeName?: string; name?: string };
  return (
    e.code === 11000 ||
    e.codeName === 'DuplicateKey' ||
    (e.name === 'MongoServerError' && e.code === 11000)
  );
}

export const __testing = { canonicalise, sha256Hex, GENESIS_PREVIOUS_HASH };
