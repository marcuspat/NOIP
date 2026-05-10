// DriftReport aggregate.
//
// Records the diff between two consecutive snapshots for a single
// cluster. Created only when there is at least one resource change —
// otherwise no report is persisted (DDD-06 invariant).

import {
  newId,
  type ClusterId,
  type DriftId,
  type SnapshotId,
  type Instant,
} from '../../../shared/kernel';
import type { DomainEvent, Clock } from '../../../shared/kernel';
import { compose } from '../../../shared/kernel';
import { ValidationError } from '../../../shared/errors';
import {
  maxSeverity,
  type ResourceChange,
  type Severity,
} from './value-objects';

const EVENT_CONTEXT = 'discovery';
const AGGREGATE_TYPE = 'drift_report';

export interface DriftReportPersistence {
  id: string;
  clusterId: string;
  previous: string;
  current: string;
  changes: ResourceChange[];
  highestSeverity: Severity;
  detectedAt: string;
}

export class DriftReport {
  private readonly _id: DriftId;
  private readonly _clusterId: ClusterId;
  private readonly _previous: SnapshotId;
  private readonly _current: SnapshotId;
  private readonly _changes: ReadonlyArray<ResourceChange>;
  private readonly _highestSeverity: Severity;
  private readonly _detectedAt: Instant;
  private readonly _pendingEvents: DomainEvent<unknown>[] = [];

  private constructor(args: {
    id: DriftId;
    clusterId: ClusterId;
    previous: SnapshotId;
    current: SnapshotId;
    changes: ReadonlyArray<ResourceChange>;
    highestSeverity: Severity;
    detectedAt: Instant;
  }) {
    this._id = args.id;
    this._clusterId = args.clusterId;
    this._previous = args.previous;
    this._current = args.current;
    this._changes = args.changes;
    this._highestSeverity = args.highestSeverity;
    this._detectedAt = args.detectedAt;
  }

  /**
   * Constructs a drift report and emits `discovery.drift.detected`.
   * Refuses an empty change list — the caller must check first and
   * skip persistence.
   */
  static create(args: {
    clusterId: ClusterId;
    previous: SnapshotId;
    current: SnapshotId;
    changes: ResourceChange[];
    clock: Clock;
  }): DriftReport {
    if (args.changes.length === 0) {
      throw new ValidationError('drift report must have at least one change');
    }
    if (args.previous === args.current) {
      throw new ValidationError(
        'drift report must reference two distinct snapshots'
      );
    }

    let highest: Severity = args.changes[0]!.severity;
    for (const c of args.changes) {
      highest = maxSeverity(highest, c.severity);
    }

    const id = newId<DriftId>();
    const r = new DriftReport({
      id,
      clusterId: args.clusterId,
      previous: args.previous,
      current: args.current,
      changes: Object.freeze(args.changes.slice()),
      highestSeverity: highest,
      detectedAt: args.clock.nowInstant(),
    });

    r._pendingEvents.push(
      compose(
        {
          type: 'discovery.drift.detected',
          context: EVENT_CONTEXT,
          aggregateType: AGGREGATE_TYPE,
          aggregateId: id,
          actor: { type: 'system' },
          payload: {
            clusterId: args.clusterId,
            driftId: id,
            highestSeverity: highest,
            changeCount: args.changes.length,
            previous: args.previous,
            current: args.current,
          },
        },
        args.clock
      )
    );
    return r;
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------
  get id(): DriftId {
    return this._id;
  }
  get clusterId(): ClusterId {
    return this._clusterId;
  }
  get previous(): SnapshotId {
    return this._previous;
  }
  get current(): SnapshotId {
    return this._current;
  }
  get changes(): ReadonlyArray<ResourceChange> {
    return this._changes;
  }
  get highestSeverity(): Severity {
    return this._highestSeverity;
  }
  get detectedAt(): Instant {
    return this._detectedAt;
  }

  drainEvents(): DomainEvent<unknown>[] {
    return this._pendingEvents.splice(0, this._pendingEvents.length);
  }

  // ---------------------------------------------------------------------------
  // Persistence helpers
  // ---------------------------------------------------------------------------
  static fromPersistence(doc: DriftReportPersistence): DriftReport {
    return new DriftReport({
      id: doc.id as DriftId,
      clusterId: doc.clusterId as ClusterId,
      previous: doc.previous as SnapshotId,
      current: doc.current as SnapshotId,
      changes: Object.freeze(doc.changes.slice()),
      highestSeverity: doc.highestSeverity,
      detectedAt: doc.detectedAt as Instant,
    });
  }

  toPersistence(): DriftReportPersistence {
    return {
      id: this._id,
      clusterId: this._clusterId,
      previous: this._previous,
      current: this._current,
      changes: this._changes.slice(),
      highestSeverity: this._highestSeverity,
      detectedAt: this._detectedAt,
    };
  }
}
