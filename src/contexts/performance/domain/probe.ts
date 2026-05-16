// Probe aggregate.
//
// Holds the spec for a single synthetic probe (http/tcp/dns/grpc) that
// the runner executes on a schedule. Probes have no children — their
// results live in `ProbeResult` and reference `ProbeId`.
//
// Invariants (DDD-09):
//   - `name` non-empty.
//   - `target` non-empty.
//   - `schedule.intervalMs > 0`.

import {
  newId,
  type ProbeId,
  type Instant,
  type Clock,
  type DomainEvent,
} from '../../../shared/kernel';
import { ValidationError } from '../../../shared/errors';
import type { ProbeConfig, ProbeKind, Schedule } from './value-objects';

export interface ProbeCreateSpec {
  name: string;
  kind: ProbeKind;
  target: string;
  labels?: Record<string, string>;
  config?: ProbeConfig;
  schedule: Schedule;
  enabled?: boolean;
  /** Optional SLO this probe contributes to. */
  sloId?: string;
}

export interface ProbeUpdateSpec {
  name?: string;
  target?: string;
  labels?: Record<string, string>;
  config?: ProbeConfig;
  schedule?: Schedule;
  enabled?: boolean;
  sloId?: string | null;
}

export interface ProbePersistence {
  id: string;
  name: string;
  kind: ProbeKind;
  target: string;
  labels: Record<string, string>;
  config: ProbeConfig;
  schedule: Schedule;
  enabled: boolean;
  sloId: string | null;
  createdAt: string;
  updatedAt: string;
}

export class Probe {
  private _id: ProbeId;
  private _name: string;
  private _kind: ProbeKind;
  private _target: string;
  private _labels: Record<string, string>;
  private _config: ProbeConfig;
  private _schedule: Schedule;
  private _enabled: boolean;
  private _sloId: string | null;
  private _createdAt: Instant;
  private _updatedAt: Instant;
  private readonly _pendingEvents: DomainEvent<unknown>[] = [];

  private constructor(args: {
    id: ProbeId;
    name: string;
    kind: ProbeKind;
    target: string;
    labels: Record<string, string>;
    config: ProbeConfig;
    schedule: Schedule;
    enabled: boolean;
    sloId: string | null;
    createdAt: Instant;
    updatedAt: Instant;
  }) {
    this._id = args.id;
    this._name = args.name;
    this._kind = args.kind;
    this._target = args.target;
    this._labels = args.labels;
    this._config = args.config;
    this._schedule = args.schedule;
    this._enabled = args.enabled;
    this._sloId = args.sloId;
    this._createdAt = args.createdAt;
    this._updatedAt = args.updatedAt;
  }

  static create(spec: ProbeCreateSpec, clock: Clock): Probe {
    if (!spec.name || spec.name.trim().length === 0) {
      throw new ValidationError('probe name is required');
    }
    if (!spec.target || spec.target.trim().length === 0) {
      throw new ValidationError('probe target is required');
    }
    if (!spec.schedule || spec.schedule.intervalMs <= 0) {
      throw new ValidationError('probe schedule.intervalMs must be > 0', {
        intervalMs: spec.schedule?.intervalMs,
      });
    }
    const now = clock.nowInstant();
    return new Probe({
      id: newId<ProbeId>(),
      name: spec.name.trim(),
      kind: spec.kind,
      target: spec.target.trim(),
      labels: spec.labels ?? {},
      config: spec.config ?? {},
      schedule: spec.schedule,
      enabled: spec.enabled !== false,
      sloId: spec.sloId ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }

  update(spec: ProbeUpdateSpec, clock: Clock): void {
    if (spec.name !== undefined) {
      if (!spec.name || spec.name.trim().length === 0) {
        throw new ValidationError('probe name cannot be empty');
      }
      this._name = spec.name.trim();
    }
    if (spec.target !== undefined) {
      if (!spec.target || spec.target.trim().length === 0) {
        throw new ValidationError('probe target cannot be empty');
      }
      this._target = spec.target.trim();
    }
    if (spec.labels !== undefined) this._labels = spec.labels;
    if (spec.config !== undefined) this._config = spec.config;
    if (spec.schedule !== undefined) {
      if (spec.schedule.intervalMs <= 0) {
        throw new ValidationError('probe schedule.intervalMs must be > 0');
      }
      this._schedule = spec.schedule;
    }
    if (spec.enabled !== undefined) this._enabled = spec.enabled;
    if (spec.sloId !== undefined) this._sloId = spec.sloId;
    this._updatedAt = clock.nowInstant();
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------
  get id(): ProbeId {
    return this._id;
  }
  get name(): string {
    return this._name;
  }
  get kind(): ProbeKind {
    return this._kind;
  }
  get target(): string {
    return this._target;
  }
  get labels(): Record<string, string> {
    return this._labels;
  }
  get config(): ProbeConfig {
    return this._config;
  }
  get schedule(): Schedule {
    return this._schedule;
  }
  get enabled(): boolean {
    return this._enabled;
  }
  get sloId(): string | null {
    return this._sloId;
  }
  get createdAt(): Instant {
    return this._createdAt;
  }
  get updatedAt(): Instant {
    return this._updatedAt;
  }

  drainEvents(): DomainEvent<unknown>[] {
    return this._pendingEvents.splice(0, this._pendingEvents.length);
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------
  static fromPersistence(doc: ProbePersistence): Probe {
    return new Probe({
      id: doc.id as ProbeId,
      name: doc.name,
      kind: doc.kind,
      target: doc.target,
      labels: doc.labels,
      config: doc.config,
      schedule: doc.schedule,
      enabled: doc.enabled,
      sloId: doc.sloId,
      createdAt: doc.createdAt as Instant,
      updatedAt: doc.updatedAt as Instant,
    });
  }

  toPersistence(): ProbePersistence {
    return {
      id: this._id,
      name: this._name,
      kind: this._kind,
      target: this._target,
      labels: this._labels,
      config: this._config,
      schedule: this._schedule,
      enabled: this._enabled,
      sloId: this._sloId,
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
    };
  }
}
