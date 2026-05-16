// Report aggregate root (DDD-10).
//
// A report is the immutable record of a single render. Each row points
// at exactly one artifact URI in object storage; regenerating produces
// a new aggregate, never a mutation in place.
//
// Lifecycle:
//   - `Report.queued(spec, clock)` — created when the service accepts
//     the generate request (no artifact yet).
//   - `Report.generated(spec, clock)` — created when the renderer has
//     produced an artifact and stored it. Emits `report.generated`.
//   - `markFailed(reason, clock)` — sets terminal failure status; no
//     artifact is recorded. Used by the service when the renderer
//     raises.
//
// `artifactUri` is the only mutable field (set once, by `succeed`) —
// callers cannot re-target an existing aggregate, so the DDD-10
// invariant "artifact is immutable" holds.

import {
  compose,
  newId,
  type Clock,
  type DomainEvent,
  type Instant,
  type ReportId,
} from '../../../shared/kernel';
import { ValidationError } from '../../../shared/errors';
import type { ActorRef, Format, ReportKind, Scope } from './value-objects';

const EVENT_CONTEXT = 'dashboard';
const AGGREGATE_TYPE = 'report';

const SUPPORTED_KINDS: ReadonlySet<ReportKind> = new Set([
  'executive_summary',
  'posture',
  'compliance',
  'incident',
]);

const SUPPORTED_FORMATS: ReadonlySet<Format> = new Set([
  'pdf',
  'html',
  'json',
  'csv',
]);

export type ReportStatus = 'queued' | 'generated' | 'failed';

export interface ReportPersistence {
  id: string;
  kind: ReportKind;
  scope: Scope;
  format: Format;
  status: ReportStatus;
  generatedAt: string | null;
  generatedBy: ActorRef;
  artifactUri: string | null;
  artifactKey: string | null;
  artifactSize: number | null;
  failureReason: string | null;
}

export interface ReportQueueSpec {
  kind: ReportKind;
  scope: Scope;
  format: Format;
  generatedBy: ActorRef;
}

export interface ReportSucceedSpec {
  artifactUri: string;
  artifactKey: string;
  artifactSize: number;
}

function assertKind(kind: ReportKind): void {
  if (!SUPPORTED_KINDS.has(kind)) {
    throw new ValidationError('unsupported report kind', { kind });
  }
}

function assertFormat(format: Format): void {
  if (!SUPPORTED_FORMATS.has(format)) {
    throw new ValidationError('unsupported report format', { format });
  }
}

export class Report {
  private _id: ReportId;
  private _kind: ReportKind;
  private _scope: Scope;
  private _format: Format;
  private _status: ReportStatus;
  private _generatedAt: Instant | null;
  private _generatedBy: ActorRef;
  private _artifactUri: string | null;
  private _artifactKey: string | null;
  private _artifactSize: number | null;
  private _failureReason: string | null;
  private readonly _pendingEvents: DomainEvent<unknown>[] = [];

  private constructor(args: {
    id: ReportId;
    kind: ReportKind;
    scope: Scope;
    format: Format;
    status: ReportStatus;
    generatedAt: Instant | null;
    generatedBy: ActorRef;
    artifactUri: string | null;
    artifactKey: string | null;
    artifactSize: number | null;
    failureReason: string | null;
  }) {
    this._id = args.id;
    this._kind = args.kind;
    this._scope = args.scope;
    this._format = args.format;
    this._status = args.status;
    this._generatedAt = args.generatedAt;
    this._generatedBy = args.generatedBy;
    this._artifactUri = args.artifactUri;
    this._artifactKey = args.artifactKey;
    this._artifactSize = args.artifactSize;
    this._failureReason = args.failureReason;
  }

  /** Initial-state factory: aggregate exists, artifact does not yet. */
  static queued(spec: ReportQueueSpec, _clock: Clock): Report {
    assertKind(spec.kind);
    assertFormat(spec.format);
    if (!spec.generatedBy || typeof spec.generatedBy.userId !== 'string') {
      throw new ValidationError('report generatedBy.userId is required');
    }
    return new Report({
      id: newId<ReportId>(),
      kind: spec.kind,
      scope: { ...spec.scope },
      format: spec.format,
      status: 'queued',
      generatedAt: null,
      generatedBy: { ...spec.generatedBy },
      artifactUri: null,
      artifactKey: null,
      artifactSize: null,
      failureReason: null,
    });
  }

  static fromPersistence(doc: ReportPersistence): Report {
    return new Report({
      id: doc.id as ReportId,
      kind: doc.kind,
      scope: doc.scope,
      format: doc.format,
      status: doc.status,
      generatedAt:
        doc.generatedAt === null ? null : (doc.generatedAt as Instant),
      generatedBy: doc.generatedBy,
      artifactUri: doc.artifactUri,
      artifactKey: doc.artifactKey,
      artifactSize: doc.artifactSize,
      failureReason: doc.failureReason,
    });
  }

  get id(): ReportId {
    return this._id;
  }
  get kind(): ReportKind {
    return this._kind;
  }
  get scope(): Scope {
    return this._scope;
  }
  get format(): Format {
    return this._format;
  }
  get status(): ReportStatus {
    return this._status;
  }
  get generatedAt(): Instant | null {
    return this._generatedAt;
  }
  get generatedBy(): ActorRef {
    return this._generatedBy;
  }
  get artifactUri(): string | null {
    return this._artifactUri;
  }
  get artifactKey(): string | null {
    return this._artifactKey;
  }
  get artifactSize(): number | null {
    return this._artifactSize;
  }
  get failureReason(): string | null {
    return this._failureReason;
  }

  drainEvents(): DomainEvent<unknown>[] {
    return this._pendingEvents.splice(0, this._pendingEvents.length);
  }
  peekEvents(): ReadonlyArray<DomainEvent<unknown>> {
    return this._pendingEvents;
  }

  /**
   * Record a successful render. Sets `artifactUri` exactly once: any
   * subsequent call raises so the invariant "Report.artifactUri
   * immutable" cannot be broken by buggy callers.
   */
  markGenerated(spec: ReportSucceedSpec, clock: Clock): void {
    if (this._status === 'generated') {
      throw new ValidationError('report already generated', {
        reportId: this._id,
      });
    }
    if (this._status === 'failed') {
      throw new ValidationError('cannot succeed a failed report', {
        reportId: this._id,
      });
    }
    if (!spec.artifactUri || spec.artifactUri.length === 0) {
      throw new ValidationError('artifactUri is required');
    }
    if (!spec.artifactKey || spec.artifactKey.length === 0) {
      throw new ValidationError('artifactKey is required');
    }
    if (!Number.isFinite(spec.artifactSize) || spec.artifactSize < 0) {
      throw new ValidationError('artifactSize must be ≥ 0', {
        artifactSize: spec.artifactSize,
      });
    }
    this._status = 'generated';
    this._artifactUri = spec.artifactUri;
    this._artifactKey = spec.artifactKey;
    this._artifactSize = spec.artifactSize;
    this._generatedAt = clock.nowInstant();
    this._pendingEvents.push(
      compose(
        {
          type: 'report.generated',
          context: EVENT_CONTEXT,
          aggregateType: AGGREGATE_TYPE,
          aggregateId: this._id,
          actor: { type: 'user', id: this._generatedBy.userId },
          payload: {
            reportId: this._id,
            kind: this._kind,
            scope: this._scope,
            format: this._format,
          },
        },
        clock
      )
    );
  }

  markFailed(reason: string, clock: Clock): void {
    if (this._status !== 'queued') {
      throw new ValidationError('only queued reports can fail', {
        reportId: this._id,
        status: this._status,
      });
    }
    this._status = 'failed';
    this._failureReason = reason;
    this._generatedAt = clock.nowInstant();
  }

  toPersistence(): ReportPersistence {
    return {
      id: this._id,
      kind: this._kind,
      scope: this._scope,
      format: this._format,
      status: this._status,
      generatedAt: this._generatedAt,
      generatedBy: this._generatedBy,
      artifactUri: this._artifactUri,
      artifactKey: this._artifactKey,
      artifactSize: this._artifactSize,
      failureReason: this._failureReason,
    };
  }
}
