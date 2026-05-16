// LoadTest aggregate.
//
// Records a single load-test run (k6/autocannon). Status moves from
// `pending` → `running` → `succeeded`/`failed`. Once completed the
// aggregate is immutable — re-running the same scenario requires a
// fresh aggregate. The `summary` is the canonical bench result; the
// `raw` blob is optional and bench-tool specific.

import {
  newId,
  type Clock,
  type DomainEvent,
  type Instant,
  type LoadTestId,
} from '../../../shared/kernel';
import { compose } from '../../../shared/kernel';
import { ValidationError } from '../../../shared/errors';
import {
  emptyLoadTestSummary,
  type LoadTestError,
  type LoadTestStatus,
  type LoadTestSummary,
  type Profile,
} from './value-objects';

const EVENT_CONTEXT = 'performance';
const AGGREGATE_TYPE = 'load_test';

export interface LoadTestPersistence {
  id: string;
  name: string;
  script: string;
  profile: Profile;
  status: LoadTestStatus;
  startedAt: string;
  completedAt: string | null;
  summary: LoadTestSummary;
  error: LoadTestError | null;
  engine: string;
  target: string;
}

export interface LoadTestSubmitSpec {
  name: string;
  script: string;
  profile: Profile;
  engine: string;
  target: string;
}

export class LoadTest {
  private _id: LoadTestId;
  private _name: string;
  private _script: string;
  private _profile: Profile;
  private _status: LoadTestStatus;
  private _startedAt: Instant;
  private _completedAt: Instant | null;
  private _summary: LoadTestSummary;
  private _error: LoadTestError | null;
  private _engine: string;
  private _target: string;
  private readonly _pendingEvents: DomainEvent<unknown>[] = [];

  private constructor(args: {
    id: LoadTestId;
    name: string;
    script: string;
    profile: Profile;
    status: LoadTestStatus;
    startedAt: Instant;
    completedAt: Instant | null;
    summary: LoadTestSummary;
    error: LoadTestError | null;
    engine: string;
    target: string;
  }) {
    this._id = args.id;
    this._name = args.name;
    this._script = args.script;
    this._profile = args.profile;
    this._status = args.status;
    this._startedAt = args.startedAt;
    this._completedAt = args.completedAt;
    this._summary = args.summary;
    this._error = args.error;
    this._engine = args.engine;
    this._target = args.target;
  }

  /** Open a load-test in `running` state with `startedAt = now`. */
  static submit(spec: LoadTestSubmitSpec, clock: Clock): LoadTest {
    if (!spec.name || spec.name.trim().length === 0) {
      throw new ValidationError('load test name is required');
    }
    if (!spec.profile || spec.profile.durationSec <= 0) {
      throw new ValidationError('load test profile.durationSec must be > 0');
    }
    if (spec.profile.rps < 0 || spec.profile.vus < 0) {
      throw new ValidationError('load test profile rps/vus must be >= 0');
    }
    return new LoadTest({
      id: newId<LoadTestId>(),
      name: spec.name.trim(),
      script: spec.script,
      profile: spec.profile,
      status: 'running',
      startedAt: clock.nowInstant(),
      completedAt: null,
      summary: emptyLoadTestSummary(),
      error: null,
      engine: spec.engine,
      target: spec.target,
    });
  }

  /**
   * Mark the load-test successful. Emits
   * `performance.load_test.completed`. Refuses if already completed.
   */
  complete(summary: LoadTestSummary, clock: Clock): void {
    if (this._completedAt !== null) {
      throw new ValidationError('load test already completed', {
        loadTestId: this._id,
      });
    }
    this._status = 'succeeded';
    this._summary = summary;
    this._completedAt = clock.nowInstant();
    this._pendingEvents.push(
      compose(
        {
          type: 'performance.load_test.completed',
          context: EVENT_CONTEXT,
          aggregateType: AGGREGATE_TYPE,
          aggregateId: this._id,
          actor: { type: 'system' },
          payload: {
            loadTestId: this._id,
            summary,
          },
        },
        clock
      )
    );
  }

  /** Mark the load-test failed. Refuses if already completed. */
  fail(error: LoadTestError, clock: Clock): void {
    if (this._completedAt !== null) {
      throw new ValidationError('load test already completed', {
        loadTestId: this._id,
      });
    }
    this._status = 'failed';
    this._error = error;
    this._completedAt = clock.nowInstant();
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------
  get id(): LoadTestId {
    return this._id;
  }
  get name(): string {
    return this._name;
  }
  get script(): string {
    return this._script;
  }
  get profile(): Profile {
    return this._profile;
  }
  get status(): LoadTestStatus {
    return this._status;
  }
  get startedAt(): Instant {
    return this._startedAt;
  }
  get completedAt(): Instant | null {
    return this._completedAt;
  }
  get summary(): LoadTestSummary {
    return this._summary;
  }
  get error(): LoadTestError | null {
    return this._error;
  }
  get engine(): string {
    return this._engine;
  }
  get target(): string {
    return this._target;
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
  static fromPersistence(doc: LoadTestPersistence): LoadTest {
    return new LoadTest({
      id: doc.id as LoadTestId,
      name: doc.name,
      script: doc.script,
      profile: doc.profile,
      status: doc.status,
      startedAt: doc.startedAt as Instant,
      completedAt:
        doc.completedAt === null ? null : (doc.completedAt as Instant),
      summary: doc.summary,
      error: doc.error,
      engine: doc.engine,
      target: doc.target,
    });
  }

  toPersistence(): LoadTestPersistence {
    return {
      id: this._id,
      name: this._name,
      script: this._script,
      profile: this._profile,
      status: this._status,
      startedAt: this._startedAt,
      completedAt: this._completedAt,
      summary: this._summary,
      error: this._error,
      engine: this._engine,
      target: this._target,
    };
  }
}
