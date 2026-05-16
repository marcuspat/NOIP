// Shared fixtures for the audit bounded-context test suites.
//
// Provides in-memory repositories + an in-memory archive store that
// implement the new context's port interfaces. We deliberately avoid
// `mongodb-memory-server` here so the unit suite stays fast and
// dependency-free.

import { createHash } from 'crypto';
import { FixedClock, type Clock } from '../../../../src/shared/kernel';
import type { AuditLogRepository } from '../../../../src/contexts/audit/infrastructure/persistence/audit-log.repository';
import type { SecurityEventRepository } from '../../../../src/contexts/audit/infrastructure/persistence/security-event.repository';
import type { RetentionPolicyRepository } from '../../../../src/contexts/audit/infrastructure/persistence/retention-policy.repository';
import {
  RetentionPolicy,
  type RetentionCollection,
} from '../../../../src/contexts/audit/domain/retention-policy';
import type {
  AuditArchiveStore,
  AuditArchiveUploadOpts,
  AuditArchiveUploadResult,
} from '../../../../src/contexts/audit/domain/ports/archive-store';
import type {
  AuditFilter,
  AuditPage,
  SecurityEventFilter,
  AuditEntryCursor,
} from '../../../../src/contexts/audit/domain/value-objects';
import type {
  AuditLogEntry,
  ActorRef,
} from '../../../../src/models/audit-log.model';
import type {
  SecurityEvent,
  SecurityEventType,
  SecurityEventSeverity,
} from '../../../../src/types/auth.types';
import type { PolicyId } from '../../../../src/shared/kernel';

export const TEST_CLOCK_AT = new Date('2026-05-16T00:00:00Z');

export function fixedClock(at: Date = TEST_CLOCK_AT): Clock {
  return new FixedClock(at);
}

export class InMemoryAuditLogRepository implements AuditLogRepository {
  public readonly entries: AuditLogEntry[] = [];

  push(entry: AuditLogEntry): void {
    this.entries.push(entry);
  }

  async query(filter: AuditFilter): Promise<AuditPage> {
    const matches = this.entries.filter(e => this.matches(e, filter));
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 50;
    const slice = matches.slice(offset, offset + limit);
    return {
      items: slice.map(e => ({
        id: String(e._id ?? '') as unknown as AuditPage['items'][number]['id'],
        actor: e.actor,
        action: e.action,
        resource: e.resource,
        details: e.details,
        ipAddress: e.ipAddress,
        userAgent: e.userAgent,
        timestamp: e.timestamp,
        chain: e.chain,
        ...(e.resourceId !== undefined ? { resourceId: e.resourceId } : {}),
      })),
      total: matches.length,
      offset,
      limit,
    };
  }

  async findById(id: string): Promise<AuditLogEntry | null> {
    return this.entries.find(e => String(e._id) === id) ?? null;
  }

  async countOlderThan(cutoff: Date, shard?: string): Promise<number> {
    return this.entries.filter(
      e =>
        e.timestamp.getTime() <= cutoff.getTime() &&
        (shard === undefined || e.chain.shard === shard)
    ).length;
  }

  async hardDeleteOlderThan(cutoff: Date, shard?: string): Promise<number> {
    const before = this.entries.length;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (
        e.timestamp.getTime() <= cutoff.getTime() &&
        (shard === undefined || e.chain.shard === shard)
      ) {
        this.entries.splice(i, 1);
      }
    }
    return before - this.entries.length;
  }

  streamRange(opts: {
    from?: Date;
    to: Date;
    shard?: string;
  }): AuditEntryCursor {
    const filtered = this.entries
      .filter(e => {
        if (e.timestamp.getTime() > opts.to.getTime()) return false;
        if (opts.from && e.timestamp.getTime() < opts.from.getTime())
          return false;
        if (opts.shard !== undefined && e.chain.shard !== opts.shard)
          return false;
        return true;
      })
      .sort((a, b) => {
        if (a.chain.shard !== b.chain.shard) {
          return a.chain.shard < b.chain.shard ? -1 : 1;
        }
        return a.chain.sequence - b.chain.sequence;
      });
    let idx = 0;
    return {
      next: async () => {
        if (idx >= filtered.length) return null;
        return filtered[idx++] ?? null;
      },
      close: async () => undefined,
    };
  }

  async latestTipForShard(shard: string): Promise<{
    sequence: number;
    currentHash: string;
    timestamp: Date;
  } | null> {
    const tip = this.entries
      .filter(e => e.chain.shard === shard)
      .sort((a, b) => b.chain.sequence - a.chain.sequence)[0];
    if (!tip) return null;
    return {
      sequence: tip.chain.sequence,
      currentHash: tip.chain.currentHash,
      timestamp: tip.timestamp,
    };
  }

  async listShards(): Promise<string[]> {
    return Array.from(new Set(this.entries.map(e => e.chain.shard))).sort();
  }

  private matches(entry: AuditLogEntry, filter: AuditFilter): boolean {
    if (filter.action !== undefined && entry.action !== filter.action)
      return false;
    if (filter.resource !== undefined && entry.resource !== filter.resource)
      return false;
    if (
      filter.resourceId !== undefined &&
      entry.resourceId !== filter.resourceId
    )
      return false;
    if (
      filter.actor?.userId !== undefined &&
      entry.actor.userId !== filter.actor.userId
    )
      return false;
    if (
      filter.actor?.serviceAccountId !== undefined &&
      entry.actor.serviceAccountId !== filter.actor.serviceAccountId
    )
      return false;
    if (filter.shard !== undefined && entry.chain.shard !== filter.shard)
      return false;
    if (filter.from && entry.timestamp.getTime() < filter.from.getTime())
      return false;
    if (filter.to && entry.timestamp.getTime() > filter.to.getTime())
      return false;
    return true;
  }
}

export class InMemorySecurityEventRepository
  implements SecurityEventRepository
{
  public readonly events: SecurityEvent[] = [];

  push(evt: SecurityEvent): void {
    this.events.push(evt);
  }

  async query(filter: SecurityEventFilter): Promise<SecurityEvent[]> {
    return this.events.filter(e => {
      if (filter.userId !== undefined && e.userId !== filter.userId)
        return false;
      if (filter.type !== undefined && e.type !== filter.type) return false;
      if (
        filter.severity !== undefined &&
        (e.severity as string) !== (filter.severity as string)
      )
        return false;
      if (filter.resolved !== undefined && e.resolved !== filter.resolved)
        return false;
      return true;
    });
  }

  async findById(id: string): Promise<SecurityEvent | null> {
    return this.events.find(e => String(e._id) === id) ?? null;
  }

  async resolve(
    id: string,
    by: string,
    note?: string
  ): Promise<SecurityEvent | null> {
    const evt = this.events.find(e => String(e._id) === id);
    if (!evt) return null;
    evt.resolved = true;
    evt.resolvedAt = new Date();
    evt.resolvedBy = by;
    if (note !== undefined) evt.resolutionNotes = note;
    return evt;
  }

  async hardDeleteOlderThan(cutoff: Date): Promise<number> {
    const before = this.events.length;
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i]!;
      if (e.createdAt && e.createdAt.getTime() <= cutoff.getTime()) {
        this.events.splice(i, 1);
      }
    }
    return before - this.events.length;
  }
}

export class InMemoryRetentionPolicyRepository
  implements RetentionPolicyRepository
{
  private readonly policies = new Map<RetentionCollection, RetentionPolicy>();

  setPolicy(policy: RetentionPolicy): void {
    this.policies.set(policy.collection, policy);
  }

  async findForCollection(
    collection: RetentionCollection
  ): Promise<RetentionPolicy> {
    const existing = this.policies.get(collection);
    if (existing) return existing;
    return RetentionPolicy.create({
      id: `default-${collection}` as PolicyId,
      collection,
      retentionDays: 365,
      archiveAfterDays: 30,
      immutable: false,
    });
  }

  async save(policy: RetentionPolicy): Promise<void> {
    this.policies.set(policy.collection, policy);
  }

  async list(): Promise<RetentionPolicy[]> {
    return Array.from(this.policies.values());
  }
}

export class InMemoryArchiveStore implements AuditArchiveStore {
  public readonly objects = new Map<string, Uint8Array>();
  public readonly checksums = new Map<string, string>();
  public uploadCount = 0;
  public failOnUpload: Error | null = null;
  public corruptOnDownload = false;

  async upload(
    key: string,
    body: Uint8Array,
    opts: AuditArchiveUploadOpts = {}
  ): Promise<AuditArchiveUploadResult> {
    this.uploadCount++;
    if (this.failOnUpload) throw this.failOnUpload;
    this.objects.set(key, body);
    if (opts.checksum) this.checksums.set(key, opts.checksum);
    return { uri: `memory://${key}`, size: body.byteLength };
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async download(key: string): Promise<Uint8Array> {
    const body = this.objects.get(key);
    if (!body) throw new Error(`not found: ${key}`);
    if (this.corruptOnDownload) {
      // Return a slightly different payload so the checksum differs.
      const tampered = new Uint8Array(body);
      if (tampered.length > 0) tampered[0] = (tampered[0] ?? 0) ^ 0x01;
      return tampered;
    }
    return body;
  }

  async list(prefix: string, limit = 1000): Promise<string[]> {
    return Array.from(this.objects.keys())
      .filter(k => k.startsWith(prefix))
      .slice(0, limit)
      .sort();
  }
}

/**
 * Build a pre-hashed `AuditLogEntry`. The hash is computed exactly the
 * way `HashChainAppender` does it so the in-memory data set passes
 * end-to-end verification.
 */
let nextObjId = 1;
export function buildEntry(opts: {
  shard?: string;
  sequence: number;
  previousHash?: string;
  timestamp: Date;
  action?: string;
  actor?: ActorRef;
  resource?: string;
  resourceId?: string;
  details?: Record<string, unknown>;
}): AuditLogEntry {
  const shard = opts.shard ?? 'global';
  const previousHash = opts.previousHash ?? '0'.repeat(64);
  const actor: ActorRef = opts.actor ?? { userId: 'user-1' };
  const action = opts.action ?? 'iam.user.create';
  const resource = opts.resource ?? '/api/users';
  const details = opts.details ?? { method: 'POST', statusCode: 201 };

  const noChain: Omit<AuditLogEntry, 'chain' | '_id'> = {
    actor,
    action,
    resource,
    ...(opts.resourceId !== undefined ? { resourceId: opts.resourceId } : {}),
    details,
    ipAddress: '127.0.0.1',
    userAgent: 'jest',
    timestamp: opts.timestamp,
  };
  const currentHash = createHash('sha256')
    .update(canonicalJson(noChain) + previousHash)
    .digest('hex');
  return {
    _id: `oid-${nextObjId++}` as unknown as AuditLogEntry['_id'],
    ...noChain,
    chain: { shard, sequence: opts.sequence, previousHash, currentHash },
  } as AuditLogEntry;
}

/**
 * Construct a chain of `count` linked entries starting at `startSeq`.
 * The genesis entry uses `'0' * 64` as its previousHash; subsequent
 * entries link forward correctly.
 */
export function buildChain(opts: {
  shard?: string;
  count: number;
  startAt: Date;
  stepMs?: number;
}): AuditLogEntry[] {
  const shard = opts.shard ?? 'global';
  const step = opts.stepMs ?? 1000;
  const entries: AuditLogEntry[] = [];
  let prevHash = '0'.repeat(64);
  for (let i = 0; i < opts.count; i++) {
    const e = buildEntry({
      shard,
      sequence: i,
      previousHash: prevHash,
      timestamp: new Date(opts.startAt.getTime() + i * step),
      action: `bench.action.${i}`,
    });
    entries.push(e);
    prevHash = e.chain.currentHash;
  }
  return entries;
}

/** Build a security event with sensible defaults. */
export function buildSecurityEvent(
  overrides: Partial<SecurityEvent> = {}
): SecurityEvent {
  const base: SecurityEvent = {
    _id: `sec-${nextObjId++}` as unknown as SecurityEvent['_id'],
    type: 'LOGIN_FAILURE' as SecurityEventType,
    severity: 'HIGH' as SecurityEventSeverity,
    description: 'failed login',
    ipAddress: '127.0.0.1',
    userAgent: 'jest',
    resolved: false,
    createdAt: new Date('2026-05-16T00:00:00Z'),
    ...overrides,
  } as SecurityEvent;
  return base;
}

// Canonical JSON used by `buildEntry`'s hash. Mirrors
// `application/hash-chain-appender.service.ts`.
function canonicalJson(value: unknown): string {
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
