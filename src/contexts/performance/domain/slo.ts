// SLO aggregate.
//
// Holds the spec for a single Service-Level Objective: a target, a
// rolling window, and one or more indicators (PromQL queries). The
// `remainingBudget` (0..1) and `currentBurnRate` are mutated only by
// the `SLOComputer` via `recordObservation`; no other caller is
// permitted to edit them. Out-of-band edits are rejected by the
// invariant in `update`.
//
// Status transitions emit cross-context events:
//   - currentBurnRate crosses > 1 → `performance.slo.breached`
//   - currentBurnRate falls back ≤ 1 from > 1 → `performance.slo.recovered`

import {
  newId,
  type Clock,
  type DomainEvent,
  type Instant,
  type SLOId,
} from '../../../shared/kernel';
import { compose } from '../../../shared/kernel';
import { ValidationError } from '../../../shared/errors';
import type { Indicator, SLOTarget, Window } from './value-objects';

const EVENT_CONTEXT = 'performance';
const AGGREGATE_TYPE = 'slo';

export interface SLOPersistence {
  id: string;
  name: string;
  target: SLOTarget;
  window: Window;
  indicators: Indicator[];
  currentBurnRate: number;
  remainingBudget: number;
  breached: boolean;
  updatedAt: string;
  createdAt: string;
}

export interface SLOCreateSpec {
  name: string;
  target: SLOTarget;
  window: Window;
  indicators: Indicator[];
}

export interface SLOUpdateSpec {
  name?: string;
  target?: SLOTarget;
  window?: Window;
  indicators?: Indicator[];
}

export class SLO {
  private _id: SLOId;
  private _name: string;
  private _target: SLOTarget;
  private _window: Window;
  private _indicators: Indicator[];
  private _currentBurnRate: number;
  private _remainingBudget: number;
  private _breached: boolean;
  private _updatedAt: Instant;
  private _createdAt: Instant;
  private readonly _pendingEvents: DomainEvent<unknown>[] = [];

  private constructor(args: {
    id: SLOId;
    name: string;
    target: SLOTarget;
    window: Window;
    indicators: Indicator[];
    currentBurnRate: number;
    remainingBudget: number;
    breached: boolean;
    updatedAt: Instant;
    createdAt: Instant;
  }) {
    this._id = args.id;
    this._name = args.name;
    this._target = args.target;
    this._window = args.window;
    this._indicators = args.indicators;
    this._currentBurnRate = args.currentBurnRate;
    this._remainingBudget = args.remainingBudget;
    this._breached = args.breached;
    this._updatedAt = args.updatedAt;
    this._createdAt = args.createdAt;
  }

  static create(spec: SLOCreateSpec, clock: Clock): SLO {
    if (!spec.name || spec.name.trim().length === 0) {
      throw new ValidationError('SLO name is required');
    }
    if (!spec.indicators || spec.indicators.length === 0) {
      throw new ValidationError('SLO must have at least one indicator');
    }
    if (!spec.window || spec.window.rollingDays <= 0) {
      throw new ValidationError('SLO window.rollingDays must be > 0');
    }
    if (
      spec.target.kind === 'availability' &&
      (spec.target.value < 0 || spec.target.value > 1)
    ) {
      throw new ValidationError('availability target must be in [0,1]', {
        value: spec.target.value,
      });
    }
    if (
      (spec.target.kind === 'latency_ms' ||
        spec.target.kind === 'error_rate') &&
      spec.target.value < 0
    ) {
      throw new ValidationError(`${spec.target.kind} target must be >= 0`, {
        value: spec.target.value,
      });
    }
    const now = clock.nowInstant();
    return new SLO({
      id: newId<SLOId>(),
      name: spec.name.trim(),
      target: spec.target,
      window: spec.window,
      indicators: spec.indicators,
      currentBurnRate: 0,
      remainingBudget: 1,
      breached: false,
      updatedAt: now,
      createdAt: now,
    });
  }

  /**
   * Edit metadata only. `remainingBudget` and `currentBurnRate` are
   * read-only from this entry point (DDD-09 invariant).
   */
  update(spec: SLOUpdateSpec, clock: Clock): void {
    // Reject any attempt to inject budget fields via spread tricks.
    const probe = spec as unknown as Record<string, unknown>;
    if (
      probe['remainingBudget'] !== undefined ||
      probe['currentBurnRate'] !== undefined ||
      probe['breached'] !== undefined
    ) {
      throw new ValidationError(
        'SLO.remainingBudget/currentBurnRate may only be updated by SLOComputer'
      );
    }
    if (spec.name !== undefined) {
      if (!spec.name || spec.name.trim().length === 0) {
        throw new ValidationError('SLO name cannot be empty');
      }
      this._name = spec.name.trim();
    }
    if (spec.target !== undefined) this._target = spec.target;
    if (spec.window !== undefined) {
      if (spec.window.rollingDays <= 0) {
        throw new ValidationError('SLO window.rollingDays must be > 0');
      }
      this._window = spec.window;
    }
    if (spec.indicators !== undefined) {
      if (spec.indicators.length === 0) {
        throw new ValidationError('SLO must have at least one indicator');
      }
      this._indicators = spec.indicators;
    }
    this._updatedAt = clock.nowInstant();
  }

  /**
   * Apply a freshly-computed observation from the SLOComputer.
   * Mutates `currentBurnRate` + `remainingBudget` and emits
   * `performance.slo.breached` / `performance.slo.recovered` when the
   * breach status flips. This is the *only* state-mutating entry point
   * for the budget fields.
   */
  recordObservation(
    burnRate: number,
    remainingBudget: number,
    clock: Clock
  ): void {
    if (!Number.isFinite(burnRate) || burnRate < 0) {
      throw new ValidationError(
        'burnRate must be a finite, non-negative number'
      );
    }
    if (
      !Number.isFinite(remainingBudget) ||
      remainingBudget < 0 ||
      remainingBudget > 1
    ) {
      throw new ValidationError(
        'remainingBudget must be a finite number in [0,1]'
      );
    }
    const wasBreached = this._breached;
    const nowBreached = burnRate > 1;
    this._currentBurnRate = burnRate;
    this._remainingBudget = remainingBudget;
    this._breached = nowBreached;
    this._updatedAt = clock.nowInstant();

    if (nowBreached && !wasBreached) {
      this._pendingEvents.push(
        compose(
          {
            type: 'performance.slo.breached',
            context: EVENT_CONTEXT,
            aggregateType: AGGREGATE_TYPE,
            aggregateId: this._id,
            actor: { type: 'system' },
            payload: {
              sloId: this._id,
              burnRate,
              remainingBudget,
            },
          },
          clock
        )
      );
    } else if (!nowBreached && wasBreached) {
      this._pendingEvents.push(
        compose(
          {
            type: 'performance.slo.recovered',
            context: EVENT_CONTEXT,
            aggregateType: AGGREGATE_TYPE,
            aggregateId: this._id,
            actor: { type: 'system' },
            payload: { sloId: this._id },
          },
          clock
        )
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------
  get id(): SLOId {
    return this._id;
  }
  get name(): string {
    return this._name;
  }
  get target(): SLOTarget {
    return this._target;
  }
  get window(): Window {
    return this._window;
  }
  get indicators(): Indicator[] {
    return this._indicators;
  }
  get currentBurnRate(): number {
    return this._currentBurnRate;
  }
  get remainingBudget(): number {
    return this._remainingBudget;
  }
  get breached(): boolean {
    return this._breached;
  }
  get updatedAt(): Instant {
    return this._updatedAt;
  }
  get createdAt(): Instant {
    return this._createdAt;
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
  static fromPersistence(doc: SLOPersistence): SLO {
    return new SLO({
      id: doc.id as SLOId,
      name: doc.name,
      target: doc.target,
      window: doc.window,
      indicators: doc.indicators,
      currentBurnRate: doc.currentBurnRate,
      remainingBudget: doc.remainingBudget,
      breached: doc.breached,
      updatedAt: doc.updatedAt as Instant,
      createdAt: doc.createdAt as Instant,
    });
  }

  toPersistence(): SLOPersistence {
    return {
      id: this._id,
      name: this._name,
      target: this._target,
      window: this._window,
      indicators: this._indicators,
      currentBurnRate: this._currentBurnRate,
      remainingBudget: this._remainingBudget,
      breached: this._breached,
      updatedAt: this._updatedAt,
      createdAt: this._createdAt,
    };
  }
}
