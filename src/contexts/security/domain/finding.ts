// Finding aggregate.
//
// Records a single security policy violation against a specific
// resource within a single scan. Findings have a strict lifecycle
// (open → acknowledged | suppressed → resolved) and the aggregate
// rejects illegal transitions.
//
// `fingerprint` is computed at construction time from
// `(policyId, resource.kind, resource.name, resource.namespace)` and
// is stable across re-scans. The application service uses it to dedupe
// findings on the next scan instead of opening a brand-new id.

import {
  newId,
  type FindingId,
  type Instant,
  type PolicyId,
  type ScanId,
  type UserId,
} from '../../../shared/kernel';
import type { Clock, DomainEvent } from '../../../shared/kernel';
import { compose } from '../../../shared/kernel';
import { ValidationError } from '../../../shared/errors';
import {
  asFingerprint,
  asPolicyVersion,
  type Evidence,
  type FindingFingerprint,
  type FindingStatus,
  type PolicyVersion,
  type ResourceRef,
  type Scope,
  type Severity,
} from './value-objects';

const EVENT_CONTEXT = 'security';
const AGGREGATE_TYPE = 'finding';

export interface FindingPersistence {
  id: string;
  scanId: string;
  scope: { clusterId: string; namespace?: string; kind?: string };
  resource: ResourceRef;
  policyId: string;
  policyVersion: number;
  severity: Severity;
  description: string;
  recommendation?: string;
  evidence: Evidence;
  status: FindingStatus;
  fingerprint: string;
  detectedAt: string;
  lastSeenAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  acknowledgementNote: string | null;
  suppressedAt: string | null;
  suppressedBy: string | null;
  suppressedUntil: string | null;
  suppressionJustification: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface FindingOpenSpec {
  scanId: ScanId;
  scope: Scope;
  resource: ResourceRef;
  policyId: PolicyId;
  policyVersion: PolicyVersion;
  severity: Severity;
  description: string;
  recommendation?: string;
  evidence: Evidence;
}

/**
 * Compute the dedupe fingerprint for a `(policyId, resource)` pair.
 * Exported for the policy engine and tests.
 */
export function fingerprintFor(
  policyId: PolicyId,
  resource: ResourceRef
): FindingFingerprint {
  const ns = resource.namespace ?? '-';
  return asFingerprint(`${policyId}|${resource.kind}|${ns}|${resource.name}`);
}

export class Finding {
  private _id: FindingId;
  private _scanId: ScanId;
  private _scope: Scope;
  private _resource: ResourceRef;
  private _policyId: PolicyId;
  private _policyVersion: PolicyVersion;
  private _severity: Severity;
  private _description: string;
  private _recommendation: string | undefined;
  private _evidence: Evidence;
  private _status: FindingStatus;
  private _fingerprint: FindingFingerprint;
  private _detectedAt: Instant;
  private _lastSeenAt: Instant;
  private _acknowledgedAt: Instant | null;
  private _acknowledgedBy: UserId | null;
  private _acknowledgementNote: string | null;
  private _suppressedAt: Instant | null;
  private _suppressedBy: UserId | null;
  private _suppressedUntil: Instant | null;
  private _suppressionJustification: string | null;
  private _resolvedAt: Instant | null;
  private _resolvedBy: UserId | null;
  private readonly _pendingEvents: DomainEvent<unknown>[] = [];

  private constructor(args: {
    id: FindingId;
    scanId: ScanId;
    scope: Scope;
    resource: ResourceRef;
    policyId: PolicyId;
    policyVersion: PolicyVersion;
    severity: Severity;
    description: string;
    recommendation: string | undefined;
    evidence: Evidence;
    status: FindingStatus;
    fingerprint: FindingFingerprint;
    detectedAt: Instant;
    lastSeenAt: Instant;
    acknowledgedAt: Instant | null;
    acknowledgedBy: UserId | null;
    acknowledgementNote: string | null;
    suppressedAt: Instant | null;
    suppressedBy: UserId | null;
    suppressedUntil: Instant | null;
    suppressionJustification: string | null;
    resolvedAt: Instant | null;
    resolvedBy: UserId | null;
  }) {
    this._id = args.id;
    this._scanId = args.scanId;
    this._scope = args.scope;
    this._resource = args.resource;
    this._policyId = args.policyId;
    this._policyVersion = args.policyVersion;
    this._severity = args.severity;
    this._description = args.description;
    this._recommendation = args.recommendation;
    this._evidence = args.evidence;
    this._status = args.status;
    this._fingerprint = args.fingerprint;
    this._detectedAt = args.detectedAt;
    this._lastSeenAt = args.lastSeenAt;
    this._acknowledgedAt = args.acknowledgedAt;
    this._acknowledgedBy = args.acknowledgedBy;
    this._acknowledgementNote = args.acknowledgementNote;
    this._suppressedAt = args.suppressedAt;
    this._suppressedBy = args.suppressedBy;
    this._suppressedUntil = args.suppressedUntil;
    this._suppressionJustification = args.suppressionJustification;
    this._resolvedAt = args.resolvedAt;
    this._resolvedBy = args.resolvedBy;
  }

  /** Open a new finding. Emits `security.finding.opened`. */
  static open(spec: FindingOpenSpec, clock: Clock): Finding {
    if (!spec.description || spec.description.trim().length === 0) {
      throw new ValidationError('finding description is required');
    }
    const id = newId<FindingId>();
    const now = clock.nowInstant();
    const f = new Finding({
      id,
      scanId: spec.scanId,
      scope: spec.scope,
      resource: spec.resource,
      policyId: spec.policyId,
      policyVersion: spec.policyVersion,
      severity: spec.severity,
      description: spec.description,
      recommendation: spec.recommendation,
      evidence: spec.evidence,
      status: 'open',
      fingerprint: fingerprintFor(spec.policyId, spec.resource),
      detectedAt: now,
      lastSeenAt: now,
      acknowledgedAt: null,
      acknowledgedBy: null,
      acknowledgementNote: null,
      suppressedAt: null,
      suppressedBy: null,
      suppressedUntil: null,
      suppressionJustification: null,
      resolvedAt: null,
      resolvedBy: null,
    });
    f._pendingEvents.push(
      compose(
        {
          type: 'security.finding.opened',
          context: EVENT_CONTEXT,
          aggregateType: AGGREGATE_TYPE,
          aggregateId: id,
          actor: { type: 'system' },
          payload: {
            findingId: id,
            scanId: spec.scanId,
            severity: spec.severity,
            resource: spec.resource,
            policyId: spec.policyId,
          },
        },
        clock
      )
    );
    return f;
  }

  /**
   * Bump `lastSeenAt`. Used when a re-scan re-detects an existing
   * finding (matched by fingerprint). Refused on resolved findings.
   */
  touch(scanId: ScanId, clock: Clock): void {
    if (this._status === 'resolved') {
      throw new ValidationError('cannot touch a resolved finding', {
        findingId: this._id,
      });
    }
    this._scanId = scanId;
    this._lastSeenAt = clock.nowInstant();
  }

  acknowledge(by: UserId, note: string | undefined, clock: Clock): void {
    if (this._status !== 'open') {
      throw new ValidationError('finding can only be acknowledged from open', {
        findingId: this._id,
        status: this._status,
      });
    }
    this._status = 'acknowledged';
    this._acknowledgedAt = clock.nowInstant();
    this._acknowledgedBy = by;
    this._acknowledgementNote = note ?? null;
    this._pendingEvents.push(
      compose(
        {
          type: 'security.finding.acknowledged',
          context: EVENT_CONTEXT,
          aggregateType: AGGREGATE_TYPE,
          aggregateId: this._id,
          actor: { type: 'user', id: by },
          payload: {
            findingId: this._id,
            by,
            ...(note !== undefined ? { note } : {}),
          },
        },
        clock
      )
    );
  }

  /**
   * Suppress a finding. Both an `until` instant and a non-empty
   * justification are required (DDD-07 invariant — suppressions must
   * be auditable).
   */
  suppress(
    by: UserId,
    until: Instant,
    justification: string,
    clock: Clock
  ): void {
    if (this._status === 'resolved') {
      throw new ValidationError('cannot suppress a resolved finding', {
        findingId: this._id,
      });
    }
    if (!until) {
      throw new ValidationError('suppression must have an expiry', {
        findingId: this._id,
      });
    }
    if (!justification || justification.trim().length === 0) {
      throw new ValidationError(
        'suppression must have a non-empty justification',
        { findingId: this._id }
      );
    }
    if ((until as unknown as string) <= clock.nowInstant()) {
      throw new ValidationError('suppression expiry must be in the future', {
        findingId: this._id,
      });
    }
    this._status = 'suppressed';
    this._suppressedAt = clock.nowInstant();
    this._suppressedBy = by;
    this._suppressedUntil = until;
    this._suppressionJustification = justification.trim();
    this._pendingEvents.push(
      compose(
        {
          type: 'security.finding.suppressed',
          context: EVENT_CONTEXT,
          aggregateType: AGGREGATE_TYPE,
          aggregateId: this._id,
          actor: { type: 'user', id: by },
          payload: {
            findingId: this._id,
            by,
            until,
            justification: this._suppressionJustification,
          },
        },
        clock
      )
    );
  }

  /**
   * Resolve a finding. Allowed from any non-resolved status. `evidence`
   * is optional supporting data captured at resolution time but does
   * not mutate the immutable `evidence` field.
   */
  resolve(by: UserId | null, clock: Clock): void {
    if (this._status === 'resolved') {
      // Idempotent: drop if already resolved.
      return;
    }
    this._status = 'resolved';
    this._resolvedAt = clock.nowInstant();
    this._resolvedBy = by;
    this._pendingEvents.push(
      compose(
        {
          type: 'security.finding.resolved',
          context: EVENT_CONTEXT,
          aggregateType: AGGREGATE_TYPE,
          aggregateId: this._id,
          actor: by ? { type: 'user', id: by } : { type: 'system' },
          payload: {
            findingId: this._id,
            resolvedAt: this._resolvedAt,
            ...(by !== null ? { by } : {}),
          },
        },
        clock
      )
    );
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------
  get id(): FindingId {
    return this._id;
  }
  get scanId(): ScanId {
    return this._scanId;
  }
  get scope(): Scope {
    return this._scope;
  }
  get resource(): ResourceRef {
    return this._resource;
  }
  get policyId(): PolicyId {
    return this._policyId;
  }
  get policyVersion(): PolicyVersion {
    return this._policyVersion;
  }
  get severity(): Severity {
    return this._severity;
  }
  get description(): string {
    return this._description;
  }
  get recommendation(): string | undefined {
    return this._recommendation;
  }
  get evidence(): Evidence {
    return this._evidence;
  }
  get status(): FindingStatus {
    return this._status;
  }
  get fingerprint(): FindingFingerprint {
    return this._fingerprint;
  }
  get detectedAt(): Instant {
    return this._detectedAt;
  }
  get lastSeenAt(): Instant {
    return this._lastSeenAt;
  }
  get resolvedAt(): Instant | null {
    return this._resolvedAt;
  }
  get acknowledgedBy(): UserId | null {
    return this._acknowledgedBy;
  }
  get suppressedUntil(): Instant | null {
    return this._suppressedUntil;
  }
  get suppressionJustification(): string | null {
    return this._suppressionJustification;
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
  static fromPersistence(doc: FindingPersistence): Finding {
    const scope: Scope = {
      clusterId: doc.scope.clusterId as Scope['clusterId'],
    };
    if (doc.scope.namespace !== undefined)
      scope.namespace = doc.scope.namespace;
    if (doc.scope.kind !== undefined) scope.kind = doc.scope.kind;
    return new Finding({
      id: doc.id as FindingId,
      scanId: doc.scanId as ScanId,
      scope,
      resource: doc.resource,
      policyId: doc.policyId as PolicyId,
      policyVersion: asPolicyVersion(doc.policyVersion),
      severity: doc.severity,
      description: doc.description,
      recommendation: doc.recommendation,
      evidence: doc.evidence,
      status: doc.status,
      fingerprint: asFingerprint(doc.fingerprint),
      detectedAt: doc.detectedAt as Instant,
      lastSeenAt: doc.lastSeenAt as Instant,
      acknowledgedAt:
        doc.acknowledgedAt === null ? null : (doc.acknowledgedAt as Instant),
      acknowledgedBy:
        doc.acknowledgedBy === null ? null : (doc.acknowledgedBy as UserId),
      acknowledgementNote: doc.acknowledgementNote,
      suppressedAt:
        doc.suppressedAt === null ? null : (doc.suppressedAt as Instant),
      suppressedBy:
        doc.suppressedBy === null ? null : (doc.suppressedBy as UserId),
      suppressedUntil:
        doc.suppressedUntil === null ? null : (doc.suppressedUntil as Instant),
      suppressionJustification: doc.suppressionJustification,
      resolvedAt: doc.resolvedAt === null ? null : (doc.resolvedAt as Instant),
      resolvedBy: doc.resolvedBy === null ? null : (doc.resolvedBy as UserId),
    });
  }

  toPersistence(): FindingPersistence {
    const out: FindingPersistence = {
      id: this._id,
      scanId: this._scanId,
      scope: { clusterId: this._scope.clusterId },
      resource: this._resource,
      policyId: this._policyId,
      policyVersion: this._policyVersion as number,
      severity: this._severity,
      description: this._description,
      evidence: this._evidence,
      status: this._status,
      fingerprint: this._fingerprint,
      detectedAt: this._detectedAt,
      lastSeenAt: this._lastSeenAt,
      acknowledgedAt: this._acknowledgedAt,
      acknowledgedBy: this._acknowledgedBy,
      acknowledgementNote: this._acknowledgementNote,
      suppressedAt: this._suppressedAt,
      suppressedBy: this._suppressedBy,
      suppressedUntil: this._suppressedUntil,
      suppressionJustification: this._suppressionJustification,
      resolvedAt: this._resolvedAt,
      resolvedBy: this._resolvedBy,
    };
    if (this._scope.namespace !== undefined) {
      out.scope.namespace = this._scope.namespace;
    }
    if (this._scope.kind !== undefined) {
      out.scope.kind = this._scope.kind;
    }
    if (this._recommendation !== undefined) {
      out.recommendation = this._recommendation;
    }
    return out;
  }
}
