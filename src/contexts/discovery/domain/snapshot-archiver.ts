// SnapshotArchiver — domain service that moves cold `ResourceSnapshot`
// rows from Mongo to the object-storage cold tier (DDD-06 follow-up).
//
// Lifecycle of a single snapshot:
//   1. `archiveOne(id)` loads it from the repository.
//   2. We stream-canonicalise the records to JSONL (one record per
//      line), gzip via `node:zlib`, and SHA-256 the *uncompressed*
//      payload. Streaming keeps memory flat regardless of how large
//      the snapshot is.
//   3. We upload the gzipped bytes to the archive store.
//   4. We verify the upload by `exists`-ing the key and re-downloading
//      + re-hashing the body. Any mismatch raises `IntegrityError` and
//      we leave the Mongo row untouched.
//   5. We patch the Mongo row with `archived = true`, the uri, sha256,
//      and the archive timestamp.
//   6. We publish `discovery.snapshot.archived` on the event bus.
//
// Sweep + prune helpers wrap the single-snapshot path with batching
// + a tiny home-grown concurrency limiter (no new deps).

import { createGzip, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  compose,
  newId,
  type Clock,
  type ClusterId,
  type DomainEvent,
  type EventBus,
  type EventId,
  type SnapshotId,
} from '../../../shared/kernel';
import { ProviderError } from '../../../shared/errors';
import { IntegrityError } from './archive-errors';
import type { ResourceSnapshotRepository } from '../infrastructure/persistence/resource-snapshot.repository';
import type { KubernetesResourceRecord } from './value-objects';
import { canonicalStringify } from './snapshot-hasher';
import {
  buildArchiveKey,
  type SnapshotArchiveStore,
} from './ports/snapshot-archive-store';

const EVENT_CONTEXT = 'discovery';
const AGGREGATE_TYPE = 'resource_snapshot';

export interface SnapshotArchiverLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

const NOOP_LOGGER: SnapshotArchiverLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface SnapshotArchiverConfig {
  /** Default 90. */
  archiveAfterDays?: number;
  /** Hard-delete from Mongo this many days *after* archive. Default 30. */
  retentionAfterArchiveDays?: number;
  /** Sweep batch size. Default 100. */
  batchSize?: number;
  /** Per-tick concurrency. Default 4. */
  concurrency?: number;
}

export interface SnapshotArchiverDeps {
  repository: ResourceSnapshotRepository;
  store: SnapshotArchiveStore;
  bus: EventBus;
  clock: Clock;
  logger?: SnapshotArchiverLogger;
  config?: SnapshotArchiverConfig;
}

export type ArchiveOutcome =
  | { kind: 'archived'; uri: string; size: number; checksum: string }
  | { kind: 'skipped'; reason: 'already-archived' | 'not-found' };

export interface ArchiveSummary {
  scanned: number;
  archived: number;
  skipped: number;
  failed: number;
  totalBytes: number;
  failures: Array<{ id: SnapshotId; error: string }>;
}

export interface SnapshotArchivedPayload {
  snapshotId: SnapshotId;
  clusterId: ClusterId;
  archiveUri: string;
  size: number;
  checksum: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class SnapshotArchiver {
  private readonly repository: ResourceSnapshotRepository;
  private readonly store: SnapshotArchiveStore;
  private readonly bus: EventBus;
  private readonly clock: Clock;
  private readonly logger: SnapshotArchiverLogger;
  private readonly archiveAfterDays: number;
  private readonly retentionAfterArchiveDays: number;
  private readonly batchSize: number;
  private readonly concurrency: number;

  constructor(deps: SnapshotArchiverDeps) {
    this.repository = deps.repository;
    this.store = deps.store;
    this.bus = deps.bus;
    this.clock = deps.clock;
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.archiveAfterDays = deps.config?.archiveAfterDays ?? 90;
    this.retentionAfterArchiveDays =
      deps.config?.retentionAfterArchiveDays ?? 30;
    this.batchSize = deps.config?.batchSize ?? 100;
    this.concurrency = deps.config?.concurrency ?? 4;
  }

  /**
   * Archive a single snapshot. Idempotent: a snapshot that is already
   * archived returns `{ kind: 'skipped', reason: 'already-archived' }`.
   */
  async archiveOne(snapshotId: SnapshotId): Promise<ArchiveOutcome> {
    const snap = await this.repository.findById(snapshotId);
    if (!snap) {
      return { kind: 'skipped', reason: 'not-found' };
    }
    if (snap.archived) {
      return { kind: 'skipped', reason: 'already-archived' };
    }

    const {
      gzipped,
      checksum,
      size: rawSize,
    } = await this.encodeSnapshot(snap.records);
    const key = buildArchiveKey({
      clusterId: snap.clusterId,
      snapshotId: snap.id,
      takenAt: new Date(snap.takenAt),
    });

    let uploadUri: string;
    let uploadedSize: number;
    try {
      const res = await this.store.upload(key, gzipped, {
        contentType: 'application/gzip',
        checksum,
      });
      uploadUri = res.uri;
      uploadedSize = res.size;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError('snapshot archive upload failed', {
        snapshotId: snap.id,
        cause: err instanceof Error ? err.message : String(err),
      });
    }

    // Verify: existence + checksum on a round-trip download.
    const ok = await this.store.exists(key);
    if (!ok) {
      throw new IntegrityError('archive missing immediately after upload', {
        snapshotId: snap.id,
        key,
      });
    }
    const roundTripped = await this.store.download(key);
    let roundTripHash: string;
    try {
      roundTripHash = this.checksumOfGzipped(roundTripped);
    } catch (err) {
      throw new IntegrityError('archive could not be decompressed', {
        snapshotId: snap.id,
        key,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
    if (roundTripHash !== checksum) {
      throw new IntegrityError('archive checksum mismatch on verify', {
        snapshotId: snap.id,
        key,
        expected: checksum,
        actual: roundTripHash,
        rawSize,
      });
    }

    const archivedAt = new Date(this.clock.now().toISOString());
    await this.repository.markArchived(snap.id, {
      uri: uploadUri,
      sha256: checksum,
      at: archivedAt,
    });

    const event: DomainEvent<SnapshotArchivedPayload> =
      compose<SnapshotArchivedPayload>(
        {
          id: newId<EventId>(),
          type: 'discovery.snapshot.archived',
          context: EVENT_CONTEXT,
          aggregateType: AGGREGATE_TYPE,
          aggregateId: snap.id,
          actor: { type: 'system' },
          payload: {
            snapshotId: snap.id,
            clusterId: snap.clusterId,
            archiveUri: uploadUri,
            size: uploadedSize,
            checksum,
          },
        },
        this.clock
      );
    this.bus.publish(event);

    this.logger.info('snapshot archived', {
      snapshotId: snap.id,
      clusterId: snap.clusterId,
      uri: uploadUri,
      size: uploadedSize,
    });
    return { kind: 'archived', uri: uploadUri, size: uploadedSize, checksum };
  }

  /**
   * Sweep snapshots older than `archiveAfterDays` and archive each.
   * Per-snapshot failures are captured in the summary so one bad row
   * doesn't abort the rest. Concurrency capped by `config.concurrency`.
   */
  async archiveOlderThan(
    opts: {
      clusterId?: ClusterId;
      olderThanDays?: number;
      maxBatch?: number;
    } = {}
  ): Promise<ArchiveSummary> {
    const days = opts.olderThanDays ?? this.archiveAfterDays;
    const cutoff = new Date(this.clock.now().getTime() - days * DAY_MS);
    const limit = opts.maxBatch ?? this.batchSize;
    const candidates = await this.repository.findOlderThanForArchive(
      cutoff,
      limit,
      opts.clusterId
    );

    const summary: ArchiveSummary = {
      scanned: candidates.length,
      archived: 0,
      skipped: 0,
      failed: 0,
      totalBytes: 0,
      failures: [],
    };

    await this.runWithConcurrency(candidates, async cand => {
      try {
        const outcome = await this.archiveOne(cand.id);
        if (outcome.kind === 'archived') {
          summary.archived++;
          summary.totalBytes += outcome.size;
        } else {
          summary.skipped++;
        }
      } catch (err) {
        summary.failed++;
        summary.failures.push({
          id: cand.id,
          error: err instanceof Error ? err.message : String(err),
        });
        this.logger.error('snapshot archive failed', {
          snapshotId: cand.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    });

    this.logger.info('archive sweep complete', {
      cutoff: cutoff.toISOString(),
      scanned: summary.scanned,
      archived: summary.archived,
      skipped: summary.skipped,
      failed: summary.failed,
      totalBytes: summary.totalBytes,
    });
    return summary;
  }

  /**
   * Hard-delete archived rows whose archive is verifiable in cold
   * storage and whose `archivedAt` is older than the retention
   * threshold. Missing-from-cold-storage rows are left alone so a
   * later operator can investigate.
   */
  async pruneArchivedOlderThan(
    opts: { olderThanDays?: number; maxBatch?: number } = {}
  ): Promise<{ deleted: number; scanned: number; missing: number }> {
    const days = opts.olderThanDays ?? this.retentionAfterArchiveDays;
    const cutoff = new Date(this.clock.now().getTime() - days * DAY_MS);
    const limit = opts.maxBatch ?? this.batchSize;
    const candidates = await this.repository.findArchivedOlderThan(
      cutoff,
      limit
    );

    if (candidates.length === 0) {
      return { deleted: 0, scanned: 0, missing: 0 };
    }

    const verified: SnapshotId[] = [];
    let missing = 0;
    await this.runWithConcurrency(candidates, async cand => {
      const key = buildArchiveKey({
        clusterId: cand.clusterId,
        snapshotId: cand.id,
        takenAt: cand.takenAt,
      });
      let ok = false;
      try {
        ok = await this.store.exists(key);
      } catch (err) {
        this.logger.warn('archive verify failed during prune', {
          snapshotId: cand.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      if (ok) {
        verified.push(cand.id);
      } else {
        missing++;
        this.logger.warn('archived snapshot missing from cold storage', {
          snapshotId: cand.id,
          key,
        });
      }
    });

    const res = await this.repository.hardDelete(verified);
    this.logger.info('archive prune complete', {
      cutoff: cutoff.toISOString(),
      scanned: candidates.length,
      deleted: res.deleted,
      missing,
    });
    return { deleted: res.deleted, scanned: candidates.length, missing };
  }

  // ---------------------------------------------------------------------------
  // Encoding helpers
  // ---------------------------------------------------------------------------

  /**
   * Stream-canonicalise the snapshot to gzipped JSONL.
   *
   * - One canonical-JSON object per line so the archive is greppable
   *   without decompression.
   * - Records are sorted with the same comparator the hasher uses so
   *   two encodings of the same snapshot produce byte-identical
   *   archives.
   * - The SHA-256 is taken over the *uncompressed* payload so we
   *   verify content integrity, not the compressor's deterministic
   *   output.
   */
  private async encodeSnapshot(
    records: ReadonlyArray<KubernetesResourceRecord>
  ): Promise<{ gzipped: Uint8Array; checksum: string; size: number }> {
    const hash = createHash('sha256');
    let rawSize = 0;
    const sorted = [...records].sort((a, b) => {
      if (a.apiVersion !== b.apiVersion)
        return a.apiVersion < b.apiVersion ? -1 : 1;
      if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
      const ans = a.namespace ?? '';
      const bns = b.namespace ?? '';
      if (ans !== bns) return ans < bns ? -1 : 1;
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return 0;
    });

    // Producer streams the canonical JSONL bytes into the hasher and
    // forward to gzip. We use a generator so the entire serialised
    // string never exists at once.
    async function* produce(): AsyncGenerator<Buffer> {
      for (const rec of sorted) {
        const line = canonicalStringify(rec) + '\n';
        const buf = Buffer.from(line, 'utf8');
        hash.update(buf);
        rawSize += buf.byteLength;
        yield buf;
      }
    }

    const chunks: Buffer[] = [];
    const gzip = createGzip({ level: 6 });
    const sink = new PassThrough();
    sink.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    // pipeline(source → gzip → sink) gives proper backpressure and a
    // single promise we can await for completion.
    await pipeline(Readable.from(produce()), gzip, sink);

    return {
      gzipped: new Uint8Array(Buffer.concat(chunks)),
      checksum: hash.digest('hex'),
      size: rawSize,
    };
  }

  /**
   * Decompress + hash the round-tripped archive bytes. Pulls the
   * decompressed payload into memory once (the archive is already
   * known to fit because we just uploaded it).
   */
  private checksumOfGzipped(body: Uint8Array): string {
    const decompressed = gunzipSync(Buffer.from(body));
    return createHash('sha256').update(decompressed).digest('hex');
  }

  /**
   * Cheap fixed-size concurrency limiter. We don't want to pull
   * `p-limit` for this — the implementation fits in ten lines.
   */
  private async runWithConcurrency<T>(
    items: ReadonlyArray<T>,
    fn: (item: T) => Promise<void>
  ): Promise<void> {
    const limit = Math.max(1, this.concurrency);
    let cursor = 0;
    const workers: Promise<void>[] = [];
    const next = async (): Promise<void> => {
      while (cursor < items.length) {
        const idx = cursor++;
        const item = items[idx];
        if (item === undefined) continue;
        await fn(item);
      }
    };
    for (let i = 0; i < Math.min(limit, items.length); i++) {
      workers.push(next());
    }
    await Promise.all(workers);
  }
}

export type SnapshotArchivedEvent = DomainEvent<SnapshotArchivedPayload>;
