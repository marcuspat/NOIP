// ProbeResult aggregate.
//
// Immutable record of a single probe execution. Mongoose TTL on the
// `at` field (30 days) compacts the collection. Each result records
// the SLO it tested against (when the probe is bound to one) so the
// SLOComputer can attribute observations to budgets.
//
// Invariants (DDD-09):
//   - `latencyMs >= 0`.
//   - `success === false` requires a `failureReason`.
//   - Aggregate is frozen post-construction (no mutators).

import {
  newId,
  type Clock,
  type Instant,
  type ProbeId,
  type DomainEvent,
  type EventId,
  type SLOId,
} from '../../../shared/kernel';
import { compose } from '../../../shared/kernel';
import { ValidationError } from '../../../shared/errors';
import type { ProbeMeasurements } from './value-objects';

const EVENT_CONTEXT = 'performance';
const AGGREGATE_TYPE = 'probe_result';

export type ResultId = string & { readonly _t: 'ProbeResultId' };

export interface ProbeResultPersistence {
  id: string;
  probeId: string;
  at: string;
  latencyMs: number;
  success: boolean;
  failureReason: string | null;
  measurements: ProbeMeasurements;
  sloId: string | null;
  target: string;
}

export interface ProbeResultRecordSpec {
  probeId: ProbeId;
  target: string;
  latencyMs: number;
  success: boolean;
  failureReason?: string;
  measurements?: ProbeMeasurements;
  /** The SLO the probe was bound to at the time of execution. */
  sloId?: SLOId | null;
}

export class ProbeResult {
  private _id: ResultId;
  private _probeId: ProbeId;
  private _at: Instant;
  private _latencyMs: number;
  private _success: boolean;
  private _failureReason: string | null;
  private _measurements: ProbeMeasurements;
  private _sloId: SLOId | null;
  private _target: string;
  private readonly _pendingEvents: DomainEvent<unknown>[] = [];

  private constructor(args: {
    id: ResultId;
    probeId: ProbeId;
    at: Instant;
    latencyMs: number;
    success: boolean;
    failureReason: string | null;
    measurements: ProbeMeasurements;
    sloId: SLOId | null;
    target: string;
  }) {
    this._id = args.id;
    this._probeId = args.probeId;
    this._at = args.at;
    this._latencyMs = args.latencyMs;
    this._success = args.success;
    this._failureReason = args.failureReason;
    this._measurements = args.measurements;
    this._sloId = args.sloId;
    this._target = args.target;
  }

  /**
   * Record a probe execution. When `success === false` the aggregate
   * also emits `performance.probe.failed` so subscribers can alert in
   * real time without waiting for the SLO sweep.
   */
  static record(spec: ProbeResultRecordSpec, clock: Clock): ProbeResult {
    if (spec.latencyMs < 0) {
      throw new ValidationError('probe latencyMs must be >= 0', {
        latencyMs: spec.latencyMs,
      });
    }
    if (!spec.success) {
      const reason = (spec.failureReason ?? '').trim();
      if (reason.length === 0) {
        throw new ValidationError(
          'failed probe results require a failureReason'
        );
      }
    }
    const id = newId<ResultId>();
    const result = new ProbeResult({
      id,
      probeId: spec.probeId,
      at: clock.nowInstant(),
      latencyMs: spec.latencyMs,
      success: spec.success,
      failureReason: spec.success ? null : (spec.failureReason ?? null),
      measurements: spec.measurements ?? {},
      sloId: spec.sloId ?? null,
      target: spec.target,
    });

    if (!result._success) {
      result._pendingEvents.push(
        compose(
          {
            type: 'performance.probe.failed',
            context: EVENT_CONTEXT,
            aggregateType: AGGREGATE_TYPE,
            aggregateId: id,
            actor: { type: 'system' },
            payload: {
              probeId: spec.probeId,
              target: spec.target,
              failureReason: result._failureReason ?? 'unknown',
            },
          },
          clock
        )
      );
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------
  get id(): ResultId {
    return this._id;
  }
  get probeId(): ProbeId {
    return this._probeId;
  }
  get at(): Instant {
    return this._at;
  }
  get latencyMs(): number {
    return this._latencyMs;
  }
  get success(): boolean {
    return this._success;
  }
  get failureReason(): string | null {
    return this._failureReason;
  }
  get measurements(): ProbeMeasurements {
    return this._measurements;
  }
  get sloId(): SLOId | null {
    return this._sloId;
  }
  get target(): string {
    return this._target;
  }

  drainEvents(): DomainEvent<unknown>[] {
    return this._pendingEvents.splice(0, this._pendingEvents.length);
  }
  peekEvents(): ReadonlyArray<DomainEvent<unknown>> {
    return this._pendingEvents;
  }

  /** Test helper. */
  withDeterministicEventId(id: EventId): void {
    const last = this._pendingEvents[this._pendingEvents.length - 1];
    if (last) last.id = id;
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------
  static fromPersistence(doc: ProbeResultPersistence): ProbeResult {
    return new ProbeResult({
      id: doc.id as ResultId,
      probeId: doc.probeId as ProbeId,
      at: doc.at as Instant,
      latencyMs: doc.latencyMs,
      success: doc.success,
      failureReason: doc.failureReason,
      measurements: doc.measurements,
      sloId: doc.sloId === null ? null : (doc.sloId as SLOId),
      target: doc.target,
    });
  }

  toPersistence(): ProbeResultPersistence {
    return {
      id: this._id,
      probeId: this._probeId,
      at: this._at,
      latencyMs: this._latencyMs,
      success: this._success,
      failureReason: this._failureReason,
      measurements: this._measurements,
      sloId: this._sloId,
      target: this._target,
    };
  }
}
