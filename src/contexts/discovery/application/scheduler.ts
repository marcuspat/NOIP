// DiscoveryScheduler — periodic scan loop.
//
// Iterates every `enabled` cluster and fires a scan via
// `DiscoveryService.triggerScan`. Per DDD-06 the scheduler must:
//   - Be cancellable.
//   - Survive a single-cluster failure without aborting the others.
//   - Use the injected `Clock` for cadence so tests can advance time
//     deterministically (here only for jitter — the actual cadence is
//     a `setInterval` because we don't want to fight Node's timer
//     loop.)
//
// Concurrency: scans run sequentially per tick. A cluster whose scan
// is still running when the next tick fires is skipped (the in-flight
// promise's resolution will catch up next tick).

import type { Clock, ClusterId } from '../../../shared/kernel';
import type { DiscoveryService } from './discovery.service';
import type { SnapshotArchiver } from '../domain/snapshot-archiver';

export interface DiscoverySchedulerLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface DiscoverySchedulerDeps {
  discoveryService: DiscoveryService;
  clusters: () => Promise<{ id: ClusterId; enabled: boolean }[]>;
  clock: Clock;
  logger?: DiscoverySchedulerLogger;
  /** Optional — wired by the composition root when archive tiering is on. */
  archiver?: SnapshotArchiver;
}

/**
 * Configuration for the standalone archive loop. Cadence is separate
 * from the scan loop because archive sweeps are much cheaper than
 * scans and can run on a slower tick (hourly is the default in
 * production).
 */
export interface StartArchiveLoopOpts {
  intervalMs: number;
  archiveAfterDays?: number;
  retentionAfterArchiveDays?: number;
  /** Per-tick batch size hint forwarded to the archiver. */
  maxBatch?: number;
}

const NOOP_LOGGER: DiscoverySchedulerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export class DiscoveryScheduler {
  private readonly discoveryService: DiscoveryService;
  private readonly clusters: () => Promise<
    { id: ClusterId; enabled: boolean }[]
  >;
  private readonly clock: Clock;
  private readonly logger: DiscoverySchedulerLogger;
  private readonly archiver: SnapshotArchiver | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private archiveTimer: ReturnType<typeof setInterval> | null = null;
  private archiveInflight = false;
  private inflight: Set<ClusterId> = new Set();
  private stopped = false;

  constructor(deps: DiscoverySchedulerDeps) {
    this.discoveryService = deps.discoveryService;
    this.clusters = deps.clusters;
    this.clock = deps.clock;
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.archiver = deps.archiver ?? null;
  }

  start(intervalMs: number): void {
    if (this.timer !== null) return; // Already started — no-op.
    this.stopped = false;
    this.logger.info('DiscoveryScheduler.start', { intervalMs });
    // Kick off an initial run after a short delay so we don't race
    // the rest of `initializeServices()`. Subsequent runs cadence
    // off the interval.
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    // Allow the process to exit even if the timer is active. Without
    // `unref` long-running tests would hang on the interval.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.archiveTimer !== null) {
      clearInterval(this.archiveTimer);
      this.archiveTimer = null;
    }
    this.logger.info('DiscoveryScheduler.stop');
  }

  /**
   * Start the cold-tier archive loop. Idempotent: a second call while
   * a loop is already running is a no-op. The loop is NOT started by
   * `start()`; the composition root must opt in.
   */
  startArchiveLoop(opts: StartArchiveLoopOpts): void {
    if (this.archiveTimer !== null) return;
    if (!this.archiver) {
      this.logger.warn(
        'DiscoveryScheduler.startArchiveLoop called without an archiver wired; ignoring'
      );
      return;
    }
    this.stopped = false;
    this.logger.info('DiscoveryScheduler.startArchiveLoop', {
      intervalMs: opts.intervalMs,
      archiveAfterDays: opts.archiveAfterDays,
      retentionAfterArchiveDays: opts.retentionAfterArchiveDays,
    });
    this.archiveTimer = setInterval(() => {
      void this.archiveTick(opts);
    }, opts.intervalMs);
    if (typeof this.archiveTimer.unref === 'function')
      this.archiveTimer.unref();
  }

  /**
   * Public for tests. Runs one archive sweep + prune. Re-entrant calls
   * are suppressed; the previous tick must complete first.
   */
  async archiveTick(opts: StartArchiveLoopOpts): Promise<{
    archived: number;
    pruned: number;
    failed: number;
  } | null> {
    if (this.stopped) return null;
    if (!this.archiver) return null;
    if (this.archiveInflight) {
      // Yield: the prior tick is still running. Don't double-up.
      return null;
    }
    this.archiveInflight = true;
    try {
      const archiver = this.archiver;
      const summary = await archiver.archiveOlderThan({
        ...(opts.archiveAfterDays !== undefined
          ? { olderThanDays: opts.archiveAfterDays }
          : {}),
        ...(opts.maxBatch !== undefined ? { maxBatch: opts.maxBatch } : {}),
      });
      // Yield between sweep + prune so we don't hog the event loop.
      await new Promise<void>(resolve => setImmediate(resolve));
      const prune = await archiver.pruneArchivedOlderThan({
        ...(opts.retentionAfterArchiveDays !== undefined
          ? { olderThanDays: opts.retentionAfterArchiveDays }
          : {}),
        ...(opts.maxBatch !== undefined ? { maxBatch: opts.maxBatch } : {}),
      });
      this.logger.info('DiscoveryScheduler.archiveTick complete', {
        archived: summary.archived,
        skipped: summary.skipped,
        failed: summary.failed,
        pruned: prune.deleted,
      });
      return {
        archived: summary.archived,
        pruned: prune.deleted,
        failed: summary.failed,
      };
    } catch (err) {
      this.logger.error('DiscoveryScheduler.archiveTick failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      return { archived: 0, pruned: 0, failed: 1 };
    } finally {
      this.archiveInflight = false;
    }
  }

  /**
   * Public for tests: run one pass without the interval. The caller
   * gets back the scan result per cluster so test assertions can
   * inspect them.
   */
  async tick(): Promise<
    Array<{ clusterId: ClusterId; ok: boolean; err?: unknown }>
  > {
    if (this.stopped) return [];
    const startedAt = this.clock.now().toISOString();
    let clusters: { id: ClusterId; enabled: boolean }[] = [];
    try {
      clusters = await this.clusters();
    } catch (err) {
      this.logger.error('DiscoveryScheduler.tick: failed to enumerate', {
        err: err instanceof Error ? err.message : String(err),
      });
      return [];
    }

    const results: Array<{
      clusterId: ClusterId;
      ok: boolean;
      err?: unknown;
    }> = [];

    for (const c of clusters) {
      if (!c.enabled) continue;
      if (this.inflight.has(c.id)) {
        // A previous tick is still scanning this cluster. Skip;
        // we'll pick it up next tick. This is the documented
        // back-pressure behaviour from DDD-06.
        results.push({ clusterId: c.id, ok: false, err: 'inflight' });
        continue;
      }
      this.inflight.add(c.id);
      try {
        await this.discoveryService.triggerScan(c.id);
        results.push({ clusterId: c.id, ok: true });
      } catch (err) {
        // Per DDD-06: a single-cluster failure must not abort other
        // clusters. We capture and continue.
        this.logger.error('DiscoveryScheduler: cluster scan failed', {
          clusterId: c.id,
          err: err instanceof Error ? err.message : String(err),
        });
        results.push({ clusterId: c.id, ok: false, err });
      } finally {
        this.inflight.delete(c.id);
      }
    }

    this.logger.info('DiscoveryScheduler.tick complete', {
      startedAt,
      total: clusters.length,
      ok: results.filter(r => r.ok).length,
    });
    return results;
  }
}
