// ClusterScan aggregate.
//
// Tracks the lifecycle of a single discovery run against one cluster.
// The state machine is monotonic: pending → running → terminal. Once
// terminal (`succeeded | failed | partial`) every field is frozen.
//
// One scan owns at most one `ResourceSnapshot` (only when terminal
// status is `succeeded` or `partial`). The snapshot is a separate
// aggregate referenced by `snapshotId`.

import {
  newId,
  type ClusterId,
  type ScanId,
  type SnapshotId,
  type Instant,
} from '../../../shared/kernel';
import type { DomainEvent, Clock } from '../../../shared/kernel';
import { compose } from '../../../shared/kernel';
import { ValidationError } from '../../../shared/errors';
import {
  emptyCounters,
  type Counters,
  type ScanError,
  type ScanStatus,
} from './value-objects';

const EVENT_CONTEXT = 'discovery';
const AGGREGATE_TYPE = 'cluster_scan';

export interface ClusterScanPersistence {
  id: string;
  clusterId: string;
  startedAt: string;
  completedAt: string | null;
  status: ScanStatus;
  error: ScanError | null;
  counts: Counters;
  snapshotId: string | null;
}

export class ClusterScan {
  private _id: ScanId;
  private _clusterId: ClusterId;
  private _startedAt: Instant;
  private _completedAt: Instant | null;
  private _status: ScanStatus;
  private _error: ScanError | null;
  private _counts: Counters;
  private _snapshotId: SnapshotId | null;
  private readonly _pendingEvents: DomainEvent<unknown>[] = [];

  private constructor(args: {
    id: ScanId;
    clusterId: ClusterId;
    startedAt: Instant;
    completedAt: Instant | null;
    status: ScanStatus;
    error: ScanError | null;
    counts: Counters;
    snapshotId: SnapshotId | null;
  }) {
    this._id = args.id;
    this._clusterId = args.clusterId;
    this._startedAt = args.startedAt;
    this._completedAt = args.completedAt;
    this._status = args.status;
    this._error = args.error;
    this._counts = args.counts;
    this._snapshotId = args.snapshotId;
  }

  // ---------------------------------------------------------------------------
  // Factory: open a new scan in `pending`. Emits no event yet — the
  // `discovery.cluster.scan_started` event fires on `start()` so the SOC
  // doesn't see scans that never actually leave the queue.
  // ---------------------------------------------------------------------------
  static open(clusterId: ClusterId, clock: Clock): ClusterScan {
    return new ClusterScan({
      id: newId<ScanId>(),
      clusterId,
      startedAt: clock.nowInstant(),
      completedAt: null,
      status: 'pending',
      error: null,
      counts: emptyCounters(),
      snapshotId: null,
    });
  }

  start(clock: Clock): void {
    if (this._status !== 'pending') {
      throw new ValidationError('scan can only start from pending', {
        scanId: this._id,
        status: this._status,
      });
    }
    this._status = 'running';
    this._startedAt = clock.nowInstant();
    this._pendingEvents.push(
      compose(
        {
          type: 'discovery.cluster.scan_started',
          context: EVENT_CONTEXT,
          aggregateType: AGGREGATE_TYPE,
          aggregateId: this._id,
          actor: { type: 'system' },
          payload: { clusterId: this._clusterId, scanId: this._id },
        },
        clock
      )
    );
  }

  /**
   * Mark the scan as fully successful. Persists `snapshotId`, the
   * counts derived from the snapshot, and emits `…scanned`.
   */
  succeed(snapshotId: SnapshotId, counts: Counters, clock: Clock): void {
    this.assertRunning();
    this._status = 'succeeded';
    this._completedAt = clock.nowInstant();
    this._snapshotId = snapshotId;
    this._counts = counts;
    this._pendingEvents.push(
      compose(
        {
          type: 'discovery.cluster.scanned',
          context: EVENT_CONTEXT,
          aggregateType: AGGREGATE_TYPE,
          aggregateId: this._id,
          actor: { type: 'system' },
          payload: {
            clusterId: this._clusterId,
            scanId: this._id,
            snapshotId,
            counts,
          },
        },
        clock
      )
    );
  }

  /**
   * Some kinds were retrieved but at least one list call ultimately
   * failed. The snapshot is still persisted (with whatever we got)
   * but the SOC needs to know coverage was incomplete.
   */
  partial(
    snapshotId: SnapshotId,
    counts: Counters,
    error: ScanError,
    clock: Clock
  ): void {
    this.assertRunning();
    this._status = 'partial';
    this._completedAt = clock.nowInstant();
    this._snapshotId = snapshotId;
    this._counts = counts;
    this._error = error;
    this._pendingEvents.push(
      compose(
        {
          type: 'discovery.cluster.scanned',
          context: EVENT_CONTEXT,
          aggregateType: AGGREGATE_TYPE,
          aggregateId: this._id,
          actor: { type: 'system' },
          payload: {
            clusterId: this._clusterId,
            scanId: this._id,
            snapshotId,
            counts,
            partial: true,
            error,
          },
        },
        clock
      )
    );
  }

  fail(error: ScanError, clock: Clock): void {
    if (this._status !== 'pending' && this._status !== 'running') {
      throw new ValidationError('scan already terminal', {
        scanId: this._id,
        status: this._status,
      });
    }
    this._status = 'failed';
    this._completedAt = clock.nowInstant();
    this._error = error;
    this._pendingEvents.push(
      compose(
        {
          type: 'discovery.cluster.scan_failed',
          context: EVENT_CONTEXT,
          aggregateType: AGGREGATE_TYPE,
          aggregateId: this._id,
          actor: { type: 'system' },
          payload: {
            clusterId: this._clusterId,
            scanId: this._id,
            error,
          },
        },
        clock
      )
    );
  }

  private assertRunning(): void {
    if (this._status !== 'running') {
      throw new ValidationError('scan must be running to terminate', {
        scanId: this._id,
        status: this._status,
      });
    }
    if (this._completedAt !== null) {
      throw new ValidationError('scan already completed', {
        scanId: this._id,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------
  get id(): ScanId {
    return this._id;
  }
  get clusterId(): ClusterId {
    return this._clusterId;
  }
  get startedAt(): Instant {
    return this._startedAt;
  }
  get completedAt(): Instant | null {
    return this._completedAt;
  }
  get status(): ScanStatus {
    return this._status;
  }
  get error(): ScanError | null {
    return this._error;
  }
  get counts(): Counters {
    return this._counts;
  }
  get snapshotId(): SnapshotId | null {
    return this._snapshotId;
  }
  isTerminal(): boolean {
    return (
      this._status === 'succeeded' ||
      this._status === 'failed' ||
      this._status === 'partial'
    );
  }

  drainEvents(): DomainEvent<unknown>[] {
    return this._pendingEvents.splice(0, this._pendingEvents.length);
  }
  peekEvents(): ReadonlyArray<DomainEvent<unknown>> {
    return this._pendingEvents;
  }

  // ---------------------------------------------------------------------------
  // Persistence helpers
  // ---------------------------------------------------------------------------
  static fromPersistence(doc: ClusterScanPersistence): ClusterScan {
    return new ClusterScan({
      id: doc.id as ScanId,
      clusterId: doc.clusterId as ClusterId,
      startedAt: doc.startedAt as Instant,
      completedAt:
        doc.completedAt === null ? null : (doc.completedAt as Instant),
      status: doc.status,
      error: doc.error,
      counts: doc.counts,
      snapshotId:
        doc.snapshotId === null ? null : (doc.snapshotId as SnapshotId),
    });
  }

  toPersistence(): ClusterScanPersistence {
    return {
      id: this._id,
      clusterId: this._clusterId,
      startedAt: this._startedAt,
      completedAt: this._completedAt,
      status: this._status,
      error: this._error,
      counts: this._counts,
      snapshotId: this._snapshotId,
    };
  }
}
