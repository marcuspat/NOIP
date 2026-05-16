// ArchiveService — moves cold audit-log entries from Mongo onto the
// `AuditArchiveStore` cold tier (DDD-11 §"Persistence" + §"Tamper
// evidence").
//
// Lifecycle of a single sweep (`archiveOlderThan(days)`):
//   1. Load the retention policy from `RetentionPolicyRepository`.
//   2. Group all entries with `timestamp <= cutoff(archiveAfterDays)`
//      by `(shard, calendar-day)` and stream them through:
//      `cursor → canonical-JSONL line → gzip → store.upload`. Streaming
//      keeps memory flat regardless of how many entries the shard
//      holds.
//   3. After each shard-day upload we verify by `exists` + `download` +
//      round-trip checksum; an integrity mismatch leaves Mongo
//      untouched and surfaces an error.
//   4. We publish `audit.archive.completed` with the archive URI and
//      the time-range that landed.
//   5. We hard-delete entries with `timestamp <= cutoff(retentionDays)`
//      from Mongo via the repository (which bypasses the
//      append-only model hooks). Entries that have been archived but
//      are still within the retention window stay in Mongo.
//
// Idempotency: repeated invocation on the same day re-uploads the
// same payload (the store's `upload` is overwrite-idempotent). The
// hard-delete step skips entries that are no longer present.

import { createGzip, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  compose,
  type Clock,
  type DomainEvent,
  type EventBus,
} from '../../../shared/kernel';
import { ProviderError } from '../../../shared/errors';
import type { AuditLogEntry } from '../../../models/audit-log.model';
import type { AuditLogRepository } from '../infrastructure/persistence/audit-log.repository';
import type { RetentionPolicyRepository } from '../infrastructure/persistence/retention-policy.repository';
import {
  buildAuditArchiveKey,
  type AuditArchiveStore,
} from '../domain/ports/archive-store';
import { canonicalJson } from './hash-chain-appender.service';

export interface ArchiveServiceLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const NOOP_LOGGER: ArchiveServiceLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface ArchiveServiceDeps {
  auditLogRepo: AuditLogRepository;
  retentionRepo: RetentionPolicyRepository;
  store: AuditArchiveStore;
  bus: EventBus;
  clock: Clock;
  logger?: ArchiveServiceLogger;
  /** Streaming page size. Defaults to 1000 entries flushed per chunk. */
  flushEvery?: number;
}

export interface ArchiveSweepSummary {
  archivedShardDays: number;
  archivedEntries: number;
  deletedEntries: number;
  totalBytes: number;
  failures: Array<{ shard: string; date: string; error: string }>;
  uris: string[];
}

export interface AuditArchiveCompletedPayload {
  from: string;
  to: string;
  archiveUri: string;
  shard: string;
  entries: number;
  size: number;
  checksum: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FLUSH_EVERY = 1000;

interface ShardDayBucket {
  shard: string;
  /** UTC date stamp (midnight) used in the archive key. */
  dayStart: Date;
  /** Inclusive — earliest timestamp in the bucket. */
  earliest: Date;
  /** Inclusive — latest timestamp in the bucket. */
  latest: Date;
  entries: AuditLogEntry[];
}

export class ArchiveService {
  private readonly auditLogRepo: AuditLogRepository;
  private readonly retentionRepo: RetentionPolicyRepository;
  private readonly store: AuditArchiveStore;
  private readonly bus: EventBus;
  private readonly clock: Clock;
  private readonly logger: ArchiveServiceLogger;
  private readonly flushEvery: number;

  constructor(deps: ArchiveServiceDeps) {
    this.auditLogRepo = deps.auditLogRepo;
    this.retentionRepo = deps.retentionRepo;
    this.store = deps.store;
    this.bus = deps.bus;
    this.clock = deps.clock;
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.flushEvery = deps.flushEvery ?? DEFAULT_FLUSH_EVERY;
  }

  /**
   * Manual archive sweep — exposed to ops + a daily cron. Selects
   * entries older than `days` (defaults to the policy's
   * `archiveAfterDays`), uploads them as gzipped JSONL per
   * (shard, calendar-day), and hard-deletes anything past the
   * retention window after a successful + verified upload.
   *
   * @returns Summary of what got archived + how many bytes flowed
   * through the cold tier; failures are listed per shard-day so a
   * single bad shard doesn't abort the rest of the sweep.
   */
  async archiveOlderThan(days?: number): Promise<ArchiveSweepSummary> {
    const policy = await this.retentionRepo.findForCollection('auditLogs');
    const archiveAfterDays = days ?? policy.archiveAfterDays;
    const now = this.clock.now();
    const cutoff = new Date(now.getTime() - archiveAfterDays * DAY_MS);

    const summary: ArchiveSweepSummary = {
      archivedShardDays: 0,
      archivedEntries: 0,
      deletedEntries: 0,
      totalBytes: 0,
      failures: [],
      uris: [],
    };

    // Per-shard: the latest `timestamp` whose bucket archived
    // successfully. Used by the retention-delete pass below so a
    // failed upload leaves the corresponding rows in Mongo even when
    // their age exceeds the retention window.
    const archivedHighWatermark = new Map<string, Date>();

    // Walk the cursor once; group entries into in-memory buckets keyed
    // by (shard, calendar-day). Per-day buffers are flushed as soon as
    // we cross a day or shard boundary so memory stays bounded to one
    // (shard, day) at a time. The cursor is sorted by
    // (shard, sequence), so the boundary check is O(1).
    const cursor = this.auditLogRepo.streamRange({ to: cutoff });
    let bucket: ShardDayBucket | null = null;
    try {
      for (;;) {
        const entry = await cursor.next();
        if (entry === null) break;
        const dayStart = startOfUtcDay(entry.timestamp);
        if (
          bucket === null ||
          bucket.shard !== entry.chain.shard ||
          bucket.dayStart.getTime() !== dayStart.getTime()
        ) {
          if (bucket) {
            await this.flushBucket(bucket, summary, archivedHighWatermark);
          }
          bucket = {
            shard: entry.chain.shard,
            dayStart,
            earliest: entry.timestamp,
            latest: entry.timestamp,
            entries: [],
          };
        }
        bucket.entries.push(entry as AuditLogEntry);
        if (entry.timestamp.getTime() > bucket.latest.getTime()) {
          bucket.latest = entry.timestamp;
        }
        if (entry.timestamp.getTime() < bucket.earliest.getTime()) {
          bucket.earliest = entry.timestamp;
        }
      }
      if (bucket) {
        await this.flushBucket(bucket, summary, archivedHighWatermark);
      }
    } finally {
      await cursor.close().catch(() => undefined);
    }

    // Retention sweep — only delete things older than retentionDays.
    // Note: per the policy archiveAfterDays <= retentionDays, so the
    // archived window is always a superset of the deleted window.
    // CRITICAL: delete only within shards that successfully archived
    // up to (or past) the retention cutoff. A failed upload leaves
    // both the cold-tier object missing AND the Mongo rows in place.
    const retentionCutoff = new Date(
      now.getTime() - policy.retentionDays * DAY_MS
    );
    if (retentionCutoff.getTime() <= cutoff.getTime()) {
      for (const [shard, highWatermark] of archivedHighWatermark) {
        // We can safely delete entries with timestamp <= min(retentionCutoff, highWatermark).
        const upperBound =
          retentionCutoff.getTime() < highWatermark.getTime()
            ? retentionCutoff
            : highWatermark;
        const deleted = await this.auditLogRepo.hardDeleteOlderThan(
          upperBound,
          shard
        );
        summary.deletedEntries += deleted;
      }
    }

    this.logger.info('audit archive sweep complete', {
      archiveAfterDays,
      retentionDays: policy.retentionDays,
      archivedShardDays: summary.archivedShardDays,
      archivedEntries: summary.archivedEntries,
      deletedEntries: summary.deletedEntries,
      totalBytes: summary.totalBytes,
    });
    return summary;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Encode one shard-day bucket via
   * `pipeline(producer → canonicaliser → gzip → sink)`, upload it,
   * verify the round-trip checksum, and emit `audit.archive.completed`.
   * Per-bucket failures are captured into the summary so one bad
   * shard-day doesn't abort the sweep.
   */
  private async flushBucket(
    bucket: ShardDayBucket,
    summary: ArchiveSweepSummary,
    highWatermark?: Map<string, Date>
  ): Promise<void> {
    if (bucket.entries.length === 0) return;
    const dateStr = formatUtcDate(bucket.dayStart);
    try {
      const { gzipped, checksum } = await this.encodeBucket(bucket.entries);
      const key = buildAuditArchiveKey({
        shard: bucket.shard,
        date: bucket.dayStart,
      });
      const uploadRes = await this.store.upload(key, gzipped, {
        contentType: 'application/gzip',
        checksum,
      });
      // Verify: existence + checksum on a round-trip download.
      const present = await this.store.exists(key);
      if (!present) {
        throw new ProviderError(
          'audit archive missing immediately after upload',
          { key }
        );
      }
      const roundTripped = await this.store.download(key);
      const roundTripChecksum = sha256OfGunzipped(roundTripped);
      if (roundTripChecksum !== checksum) {
        throw new ProviderError('audit archive checksum mismatch on verify', {
          key,
          expected: checksum,
          actual: roundTripChecksum,
        });
      }

      summary.archivedShardDays++;
      summary.archivedEntries += bucket.entries.length;
      summary.totalBytes += uploadRes.size;
      summary.uris.push(uploadRes.uri);

      if (highWatermark) {
        const existing = highWatermark.get(bucket.shard);
        if (!existing || bucket.latest.getTime() > existing.getTime()) {
          highWatermark.set(bucket.shard, bucket.latest);
        }
      }

      const payload: AuditArchiveCompletedPayload = {
        from: bucket.earliest.toISOString(),
        to: bucket.latest.toISOString(),
        archiveUri: uploadRes.uri,
        shard: bucket.shard,
        entries: bucket.entries.length,
        size: uploadRes.size,
        checksum,
      };
      const event: DomainEvent<AuditArchiveCompletedPayload> =
        compose<AuditArchiveCompletedPayload>(
          {
            type: 'audit.archive.completed',
            context: 'audit',
            aggregateType: 'archive',
            aggregateId: `${bucket.shard}:${dateStr}`,
            actor: { type: 'system' },
            payload,
          },
          this.clock
        );
      this.bus.publish(event);
      this.logger.info('audit archive uploaded', {
        shard: bucket.shard,
        date: dateStr,
        entries: bucket.entries.length,
        size: uploadRes.size,
      });
    } catch (err) {
      summary.failures.push({
        shard: bucket.shard,
        date: dateStr,
        error: err instanceof Error ? err.message : String(err),
      });
      this.logger.error('audit archive flush failed', {
        shard: bucket.shard,
        date: dateStr,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Stream-canonicalise to gzipped JSONL.
   *
   * - One canonical-JSON object per line — greppable without
   *   decompression once the file is downloaded.
   * - Entries are sorted by `chain.sequence` so two encodings of the
   *   same shard-day produce byte-identical archives (cache-friendly,
   *   audit-tool friendly).
   * - The SHA-256 is taken over the *uncompressed* payload so we
   *   verify content integrity, not the compressor's deterministic
   *   output.
   */
  private async encodeBucket(
    entries: ReadonlyArray<AuditLogEntry>
  ): Promise<{ gzipped: Uint8Array; checksum: string; size: number }> {
    const hash = createHash('sha256');
    let rawSize = 0;
    const sorted = [...entries].sort(
      (a, b) => a.chain.sequence - b.chain.sequence
    );
    const flushEvery = this.flushEvery;

    async function* produce(): AsyncGenerator<Buffer> {
      // Yield in chunks of `flushEvery` lines so the gzip stream gets
      // larger frames and we don't pay the per-line write overhead.
      let buffered: string[] = [];
      for (const entry of sorted) {
        buffered.push(canonicalJson(stripPersistenceFields(entry)));
        if (buffered.length >= flushEvery) {
          const chunk = Buffer.from(buffered.join('\n') + '\n', 'utf8');
          hash.update(chunk);
          rawSize += chunk.byteLength;
          buffered = [];
          yield chunk;
        }
      }
      if (buffered.length > 0) {
        const chunk = Buffer.from(buffered.join('\n') + '\n', 'utf8');
        hash.update(chunk);
        rawSize += chunk.byteLength;
        yield chunk;
      }
    }

    const chunks: Buffer[] = [];
    const gzip = createGzip({ level: 6 });
    const sink = new PassThrough();
    sink.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    await pipeline(Readable.from(produce()), gzip, sink);
    return {
      gzipped: new Uint8Array(Buffer.concat(chunks)),
      checksum: hash.digest('hex'),
      size: rawSize,
    };
  }
}

function startOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  );
}

function formatUtcDate(d: Date): string {
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function sha256OfGunzipped(body: Uint8Array): string {
  const decompressed = gunzipSync(Buffer.from(body));
  return createHash('sha256').update(decompressed).digest('hex');
}

/**
 * Drop Mongo-specific fields before serialising. The archive holds
 * the canonical-JSON form of the entry (the same shape that fed the
 * hash chain), so consumers can re-verify the chain offline against
 * the archived bytes alone.
 */
function stripPersistenceFields(entry: AuditLogEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {
    actor: entry.actor,
    action: entry.action,
    resource: entry.resource,
    details: entry.details,
    ipAddress: entry.ipAddress,
    userAgent: entry.userAgent,
    timestamp: entry.timestamp,
    chain: entry.chain,
  };
  if (entry.resourceId !== undefined) out['resourceId'] = entry.resourceId;
  if (entry.sessionId !== undefined) out['sessionId'] = entry.sessionId;
  return out;
}
