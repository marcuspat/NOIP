// SecurityScan aggregate.
//
// Represents a single run of policies against one immutable
// `ResourceSnapshot`. The scan owns its counts; findings live in their
// own collection and reference the scan id. Once `completedAt` is set
// the scan is immutable (DDD-07 invariant).

import { newId, type ScanId, type Instant } from '../../../shared/kernel';
import type { Clock, DomainEvent } from '../../../shared/kernel';
import { compose } from '../../../shared/kernel';
import { ValidationError } from '../../../shared/errors';
import {
  asPolicyVersion,
  emptyScanCounts,
  type PolicyVersion,
  type ScannerProfile,
  type ScanStatus,
  type Scope,
  type SecurityScanCounts,
  type SecurityScanError,
  type SnapshotRef,
} from './value-objects';

const EVENT_CONTEXT = 'security';
const AGGREGATE_TYPE = 'security_scan';

export interface SecurityScanPersistence {
  id: string;
  scope: { clusterId: string; namespace?: string; kind?: string };
  snapshot: SnapshotRef;
  policyVersion: number;
  profile: ScannerProfile;
  status: ScanStatus;
  startedAt: string;
  completedAt: string | null;
  counts: SecurityScanCounts;
  score: number | null;
  error: SecurityScanError | null;
}

export class SecurityScan {
  private _id: ScanId;
  private _scope: Scope;
  private _snapshot: SnapshotRef;
  private _policyVersion: PolicyVersion;
  private _profile: ScannerProfile;
  private _status: ScanStatus;
  private _startedAt: Instant;
  private _completedAt: Instant | null;
  private _counts: SecurityScanCounts;
  private _score: number | null;
  private _error: SecurityScanError | null;
  private readonly _pendingEvents: DomainEvent<unknown>[] = [];

  private constructor(args: {
    id: ScanId;
    scope: Scope;
    snapshot: SnapshotRef;
    policyVersion: PolicyVersion;
    profile: ScannerProfile;
    status: ScanStatus;
    startedAt: Instant;
    completedAt: Instant | null;
    counts: SecurityScanCounts;
    score: number | null;
    error: SecurityScanError | null;
  }) {
    this._id = args.id;
    this._scope = args.scope;
    this._snapshot = args.snapshot;
    this._policyVersion = args.policyVersion;
    this._profile = args.profile;
    this._status = args.status;
    this._startedAt = args.startedAt;
    this._completedAt = args.completedAt;
    this._counts = args.counts;
    this._score = args.score;
    this._error = args.error;
  }

  /** Open and emit `security.scan.started`. */
  static start(
    args: {
      scope: Scope;
      snapshot: SnapshotRef;
      policyVersion: PolicyVersion;
      profile: ScannerProfile;
    },
    clock: Clock
  ): SecurityScan {
    const id = newId<ScanId>();
    const scan = new SecurityScan({
      id,
      scope: args.scope,
      snapshot: args.snapshot,
      policyVersion: args.policyVersion,
      profile: args.profile,
      status: 'running',
      startedAt: clock.nowInstant(),
      completedAt: null,
      counts: emptyScanCounts(),
      score: null,
      error: null,
    });
    scan._pendingEvents.push(
      compose(
        {
          type: 'security.scan.started',
          context: EVENT_CONTEXT,
          aggregateType: AGGREGATE_TYPE,
          aggregateId: id,
          actor: { type: 'system' },
          payload: { scanId: id, scope: args.scope },
        },
        clock
      )
    );
    return scan;
  }

  complete(counts: SecurityScanCounts, score: number, clock: Clock): void {
    if (this._completedAt !== null) {
      throw new ValidationError('scan already completed', { scanId: this._id });
    }
    this._status = 'succeeded';
    this._counts = counts;
    this._score = Math.max(0, Math.min(100, Math.round(score)));
    this._completedAt = clock.nowInstant();
    this._pendingEvents.push(
      compose(
        {
          type: 'security.scan.completed',
          context: EVENT_CONTEXT,
          aggregateType: AGGREGATE_TYPE,
          aggregateId: this._id,
          actor: { type: 'system' },
          payload: {
            scanId: this._id,
            scope: this._scope,
            counts,
            score: this._score,
          },
        },
        clock
      )
    );
  }

  fail(error: SecurityScanError, clock: Clock): void {
    if (this._completedAt !== null) {
      throw new ValidationError('scan already completed', { scanId: this._id });
    }
    this._status = 'failed';
    this._error = error;
    this._completedAt = clock.nowInstant();
    this._pendingEvents.push(
      compose(
        {
          type: 'security.scan.failed',
          context: EVENT_CONTEXT,
          aggregateType: AGGREGATE_TYPE,
          aggregateId: this._id,
          actor: { type: 'system' },
          payload: { scanId: this._id, scope: this._scope, error },
        },
        clock
      )
    );
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------
  get id(): ScanId {
    return this._id;
  }
  get scope(): Scope {
    return this._scope;
  }
  get snapshot(): SnapshotRef {
    return this._snapshot;
  }
  get policyVersion(): PolicyVersion {
    return this._policyVersion;
  }
  get profile(): ScannerProfile {
    return this._profile;
  }
  get status(): ScanStatus {
    return this._status;
  }
  get startedAt(): Instant {
    return this._startedAt;
  }
  get completedAt(): Instant | null {
    return this._completedAt;
  }
  get counts(): SecurityScanCounts {
    return this._counts;
  }
  get score(): number | null {
    return this._score;
  }
  get error(): SecurityScanError | null {
    return this._error;
  }
  isCompleted(): boolean {
    return this._completedAt !== null;
  }

  drainEvents(): DomainEvent<unknown>[] {
    return this._pendingEvents.splice(0, this._pendingEvents.length);
  }
  peekEvents(): ReadonlyArray<DomainEvent<unknown>> {
    return this._pendingEvents;
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------
  static fromPersistence(doc: SecurityScanPersistence): SecurityScan {
    const scope: Scope = {
      clusterId: doc.scope.clusterId as Scope['clusterId'],
    };
    if (doc.scope.namespace !== undefined)
      scope.namespace = doc.scope.namespace;
    if (doc.scope.kind !== undefined) scope.kind = doc.scope.kind;
    return new SecurityScan({
      id: doc.id as ScanId,
      scope,
      snapshot: doc.snapshot,
      policyVersion: asPolicyVersion(doc.policyVersion),
      profile: doc.profile,
      status: doc.status,
      startedAt: doc.startedAt as Instant,
      completedAt:
        doc.completedAt === null ? null : (doc.completedAt as Instant),
      counts: doc.counts,
      score: doc.score,
      error: doc.error,
    });
  }

  toPersistence(): SecurityScanPersistence {
    const scope: SecurityScanPersistence['scope'] = {
      clusterId: this._scope.clusterId,
    };
    if (this._scope.namespace !== undefined)
      scope.namespace = this._scope.namespace;
    if (this._scope.kind !== undefined) scope.kind = this._scope.kind;
    return {
      id: this._id,
      scope,
      snapshot: this._snapshot,
      policyVersion: this._policyVersion as number,
      profile: this._profile,
      status: this._status,
      startedAt: this._startedAt,
      completedAt: this._completedAt,
      counts: this._counts,
      score: this._score,
      error: this._error,
    };
  }
}
