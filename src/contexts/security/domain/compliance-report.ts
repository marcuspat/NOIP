// ComplianceReport aggregate.
//
// Derived from scans + policies as of `generatedAt`. Once `signed`
// the report is immutable; later regenerations create new reports.

import {
  newId,
  type ReportId,
  type Instant,
  type UserId,
} from '../../../shared/kernel';
import type { Clock, DomainEvent } from '../../../shared/kernel';
import { compose } from '../../../shared/kernel';
import { ValidationError } from '../../../shared/errors';
import type {
  ComplianceFramework,
  ComplianceReportStatus,
  ControlAssessment,
  CoverageScore,
  Scope,
  SignedBy,
} from './value-objects';

const EVENT_CONTEXT = 'compliance';
const AGGREGATE_TYPE = 'compliance_report';

export interface ComplianceReportPersistence {
  id: string;
  framework: ComplianceFramework;
  scope: { clusterId: string; namespace?: string; kind?: string };
  generatedAt: string;
  controls: ControlAssessment[];
  overall: CoverageScore;
  status: ComplianceReportStatus;
  signedBy: { userId: string; signedAt: string } | null;
  expiresAt: string | null;
}

export class ComplianceReport {
  private _id: ReportId;
  private _framework: ComplianceFramework;
  private _scope: Scope;
  private _generatedAt: Instant;
  private _controls: ControlAssessment[];
  private _overall: CoverageScore;
  private _status: ComplianceReportStatus;
  private _signedBy: SignedBy | null;
  private _expiresAt: Instant | null;
  private readonly _pendingEvents: DomainEvent<unknown>[] = [];

  private constructor(args: {
    id: ReportId;
    framework: ComplianceFramework;
    scope: Scope;
    generatedAt: Instant;
    controls: ControlAssessment[];
    overall: CoverageScore;
    status: ComplianceReportStatus;
    signedBy: SignedBy | null;
    expiresAt: Instant | null;
  }) {
    this._id = args.id;
    this._framework = args.framework;
    this._scope = args.scope;
    this._generatedAt = args.generatedAt;
    this._controls = args.controls;
    this._overall = args.overall;
    this._status = args.status;
    this._signedBy = args.signedBy;
    this._expiresAt = args.expiresAt;
  }

  static generate(
    args: {
      framework: ComplianceFramework;
      scope: Scope;
      controls: ControlAssessment[];
      overall: CoverageScore;
      expiresAt?: Instant;
    },
    clock: Clock
  ): ComplianceReport {
    const id = newId<ReportId>();
    const r = new ComplianceReport({
      id,
      framework: args.framework,
      scope: args.scope,
      generatedAt: clock.nowInstant(),
      controls: args.controls,
      overall: args.overall,
      status: 'draft',
      signedBy: null,
      expiresAt: args.expiresAt ?? null,
    });
    r._pendingEvents.push(
      compose(
        {
          type: 'compliance.report.generated',
          context: EVENT_CONTEXT,
          aggregateType: AGGREGATE_TYPE,
          aggregateId: id,
          actor: { type: 'system' },
          payload: {
            reportId: id,
            framework: args.framework,
            scope: args.scope,
            overall: args.overall,
          },
        },
        clock
      )
    );
    return r;
  }

  sign(by: UserId, clock: Clock): void {
    if (this._status === 'signed') {
      throw new ValidationError('report already signed', {
        reportId: this._id,
      });
    }
    if (this._status === 'expired') {
      throw new ValidationError('cannot sign an expired report', {
        reportId: this._id,
      });
    }
    this._status = 'signed';
    this._signedBy = { userId: by, signedAt: clock.nowInstant() };
    this._pendingEvents.push(
      compose(
        {
          type: 'compliance.report.signed',
          context: EVENT_CONTEXT,
          aggregateType: AGGREGATE_TYPE,
          aggregateId: this._id,
          actor: { type: 'user', id: by },
          payload: { reportId: this._id, by },
        },
        clock
      )
    );
  }

  expire(clock: Clock): void {
    if (this._status === 'expired') return;
    this._status = 'expired';
    this._pendingEvents.push(
      compose(
        {
          type: 'compliance.report.expired',
          context: EVENT_CONTEXT,
          aggregateType: AGGREGATE_TYPE,
          aggregateId: this._id,
          actor: { type: 'system' },
          payload: { reportId: this._id },
        },
        clock
      )
    );
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------
  get id(): ReportId {
    return this._id;
  }
  get framework(): ComplianceFramework {
    return this._framework;
  }
  get scope(): Scope {
    return this._scope;
  }
  get generatedAt(): Instant {
    return this._generatedAt;
  }
  get controls(): ReadonlyArray<ControlAssessment> {
    return this._controls;
  }
  get overall(): CoverageScore {
    return this._overall;
  }
  get status(): ComplianceReportStatus {
    return this._status;
  }
  get signedBy(): SignedBy | null {
    return this._signedBy;
  }
  get expiresAt(): Instant | null {
    return this._expiresAt;
  }
  isImmutable(): boolean {
    return this._status === 'signed';
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
  static fromPersistence(doc: ComplianceReportPersistence): ComplianceReport {
    const scope: Scope = {
      clusterId: doc.scope.clusterId as Scope['clusterId'],
    };
    if (doc.scope.namespace !== undefined)
      scope.namespace = doc.scope.namespace;
    if (doc.scope.kind !== undefined) scope.kind = doc.scope.kind;
    return new ComplianceReport({
      id: doc.id as ReportId,
      framework: doc.framework,
      scope,
      generatedAt: doc.generatedAt as Instant,
      controls: doc.controls,
      overall: doc.overall,
      status: doc.status,
      signedBy:
        doc.signedBy === null
          ? null
          : {
              userId: doc.signedBy.userId as UserId,
              signedAt: doc.signedBy.signedAt as Instant,
            },
      expiresAt: doc.expiresAt === null ? null : (doc.expiresAt as Instant),
    });
  }

  toPersistence(): ComplianceReportPersistence {
    const scope: ComplianceReportPersistence['scope'] = {
      clusterId: this._scope.clusterId,
    };
    if (this._scope.namespace !== undefined)
      scope.namespace = this._scope.namespace;
    if (this._scope.kind !== undefined) scope.kind = this._scope.kind;
    return {
      id: this._id,
      framework: this._framework,
      scope,
      generatedAt: this._generatedAt,
      controls: this._controls,
      overall: this._overall,
      status: this._status,
      signedBy:
        this._signedBy === null
          ? null
          : {
              userId: this._signedBy.userId,
              signedAt: this._signedBy.signedAt,
            },
      expiresAt: this._expiresAt,
    };
  }
}
