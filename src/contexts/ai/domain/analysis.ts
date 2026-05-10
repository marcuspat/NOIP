// Analysis aggregate.
//
// One run of the AI analysis pipeline against a `Scope`. Records the
// strategy used (model id, prompt template hash, retrieval policy) and
// the IDs of every retrieved RAG context — so the analysis is fully
// reproducible (DDD-08 invariant).
//
// Lifecycle:
//   start() -> running (emits ai.analysis.requested)
//   complete(result) -> succeeded (emits ai.analysis.completed)
//   fail(error) -> failed (emits ai.analysis.failed)
//
// Once `completedAt` is set the aggregate is immutable.

import {
  newId,
  type AnalysisId,
  type Clock,
  type DomainEvent,
  type Instant,
} from '../../../shared/kernel';
import { compose } from '../../../shared/kernel';
import { ValidationError } from '../../../shared/errors';
import type {
  ActorRef,
  AIContextRef,
  AnalysisType,
  Insight,
  Money,
  Prediction,
  Recommendation,
  RedactionReport,
  Scope,
  Strategy,
  TokenUsage,
} from './value-objects';
import {
  emptyRedactionReport,
  emptyTokenUsage,
  zeroMoney,
} from './value-objects';

const EVENT_CONTEXT = 'ai';
const AGGREGATE_TYPE = 'analysis';

export type AnalysisStatus = 'requested' | 'running' | 'succeeded' | 'failed';

export interface AnalysisError {
  code:
    | 'PROVIDER_ERROR'
    | 'BACKPRESSURE'
    | 'RATE_LIMIT'
    | 'TIMEOUT'
    | 'VALIDATION_ERROR'
    | 'INTERNAL_ERROR';
  message: string;
}

export interface AnalysisStartSpec {
  type: AnalysisType;
  scope: Scope;
  strategy: Strategy;
  requestedBy: ActorRef;
}

export interface AnalysisCompleteSpec {
  retrieved: AIContextRef[];
  insights: Insight[];
  recommendations: Recommendation[];
  predictions: Prediction[];
  confidence: number;
  tokens: TokenUsage;
  costEstimate: Money;
  redaction: RedactionReport;
}

export interface AnalysisPersistence {
  id: string;
  type: AnalysisType;
  scope: { clusterId: string; namespace?: string; kind?: string };
  strategy: Strategy;
  status: AnalysisStatus;
  retrieved: AIContextRef[];
  insights: Insight[];
  recommendations: Recommendation[];
  predictions: Prediction[];
  confidence: number;
  tokens: TokenUsage;
  costEstimate: Money;
  redaction: RedactionReport;
  processingTimeMs: number;
  requestedAt: string;
  completedAt: string | null;
  requestedBy: ActorRef;
  error: AnalysisError | null;
}

export class Analysis {
  private _id: AnalysisId;
  private _type: AnalysisType;
  private _scope: Scope;
  private _strategy: Strategy;
  private _status: AnalysisStatus;
  private _retrieved: AIContextRef[];
  private _insights: Insight[];
  private _recommendations: Recommendation[];
  private _predictions: Prediction[];
  private _confidence: number;
  private _tokens: TokenUsage;
  private _costEstimate: Money;
  private _redaction: RedactionReport;
  private _processingTimeMs: number;
  private _requestedAt: Instant;
  private _completedAt: Instant | null;
  private _requestedBy: ActorRef;
  private _error: AnalysisError | null;
  private readonly _pendingEvents: DomainEvent<unknown>[] = [];

  private constructor(args: {
    id: AnalysisId;
    type: AnalysisType;
    scope: Scope;
    strategy: Strategy;
    status: AnalysisStatus;
    retrieved: AIContextRef[];
    insights: Insight[];
    recommendations: Recommendation[];
    predictions: Prediction[];
    confidence: number;
    tokens: TokenUsage;
    costEstimate: Money;
    redaction: RedactionReport;
    processingTimeMs: number;
    requestedAt: Instant;
    completedAt: Instant | null;
    requestedBy: ActorRef;
    error: AnalysisError | null;
  }) {
    this._id = args.id;
    this._type = args.type;
    this._scope = args.scope;
    this._strategy = args.strategy;
    this._status = args.status;
    this._retrieved = args.retrieved;
    this._insights = args.insights;
    this._recommendations = args.recommendations;
    this._predictions = args.predictions;
    this._confidence = args.confidence;
    this._tokens = args.tokens;
    this._costEstimate = args.costEstimate;
    this._redaction = args.redaction;
    this._processingTimeMs = args.processingTimeMs;
    this._requestedAt = args.requestedAt;
    this._completedAt = args.completedAt;
    this._requestedBy = args.requestedBy;
    this._error = args.error;
  }

  /** Open a new analysis. Emits `ai.analysis.requested`. */
  static start(spec: AnalysisStartSpec, clock: Clock): Analysis {
    const id = newId<AnalysisId>();
    const a = new Analysis({
      id,
      type: spec.type,
      scope: spec.scope,
      strategy: spec.strategy,
      status: 'requested',
      retrieved: [],
      insights: [],
      recommendations: [],
      predictions: [],
      confidence: 0,
      tokens: emptyTokenUsage(),
      costEstimate: zeroMoney(),
      redaction: emptyRedactionReport(),
      processingTimeMs: 0,
      requestedAt: clock.nowInstant(),
      completedAt: null,
      requestedBy: spec.requestedBy,
      error: null,
    });
    a._pendingEvents.push(
      compose(
        {
          type: 'ai.analysis.requested',
          context: EVENT_CONTEXT,
          aggregateType: AGGREGATE_TYPE,
          aggregateId: id,
          actor: { type: spec.requestedBy.type },
          payload: {
            analysisId: id,
            type: spec.type,
            scope: spec.scope,
            requestedBy: spec.requestedBy,
          },
        },
        clock
      )
    );
    return a;
  }

  /** Mark as in-flight (no event). */
  markRunning(): void {
    if (this._status === 'requested') {
      this._status = 'running';
    }
  }

  complete(spec: AnalysisCompleteSpec, clock: Clock): void {
    if (this._completedAt !== null) {
      throw new ValidationError('analysis already completed', {
        analysisId: this._id,
      });
    }
    if (spec.confidence < 0 || spec.confidence > 1) {
      throw new ValidationError('confidence must be in [0, 1]', {
        confidence: spec.confidence,
      });
    }
    if (spec.tokens.input + spec.tokens.output <= 0) {
      throw new ValidationError('tokens.input + tokens.output must be > 0', {
        tokens: spec.tokens,
      });
    }
    this._status = 'succeeded';
    this._retrieved = spec.retrieved;
    this._insights = spec.insights;
    this._recommendations = spec.recommendations;
    this._predictions = spec.predictions;
    this._confidence = spec.confidence;
    this._tokens = spec.tokens;
    this._costEstimate = spec.costEstimate;
    this._redaction = spec.redaction;
    const completedAt = clock.nowInstant();
    this._completedAt = completedAt;
    this._processingTimeMs = Math.max(
      0,
      Date.parse(completedAt) - Date.parse(this._requestedAt)
    );
    this._pendingEvents.push(
      compose(
        {
          type: 'ai.analysis.completed',
          context: EVENT_CONTEXT,
          aggregateType: AGGREGATE_TYPE,
          aggregateId: this._id,
          actor: { type: this._requestedBy.type },
          payload: {
            analysisId: this._id,
            type: this._type,
            scope: this._scope,
            confidence: this._confidence,
            processingTimeMs: this._processingTimeMs,
          },
        },
        clock
      )
    );
  }

  fail(error: AnalysisError, clock: Clock): void {
    if (this._completedAt !== null) {
      throw new ValidationError('analysis already completed', {
        analysisId: this._id,
      });
    }
    this._status = 'failed';
    this._error = error;
    const completedAt = clock.nowInstant();
    this._completedAt = completedAt;
    this._processingTimeMs = Math.max(
      0,
      Date.parse(completedAt) - Date.parse(this._requestedAt)
    );
    this._pendingEvents.push(
      compose(
        {
          type: 'ai.analysis.failed',
          context: EVENT_CONTEXT,
          aggregateType: AGGREGATE_TYPE,
          aggregateId: this._id,
          actor: { type: this._requestedBy.type },
          payload: { analysisId: this._id, error },
        },
        clock
      )
    );
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------
  get id(): AnalysisId {
    return this._id;
  }
  get type(): AnalysisType {
    return this._type;
  }
  get scope(): Scope {
    return this._scope;
  }
  get strategy(): Strategy {
    return this._strategy;
  }
  get status(): AnalysisStatus {
    return this._status;
  }
  get retrieved(): readonly AIContextRef[] {
    return this._retrieved;
  }
  get insights(): readonly Insight[] {
    return this._insights;
  }
  get recommendations(): readonly Recommendation[] {
    return this._recommendations;
  }
  get predictions(): readonly Prediction[] {
    return this._predictions;
  }
  get confidence(): number {
    return this._confidence;
  }
  get tokens(): TokenUsage {
    return this._tokens;
  }
  get costEstimate(): Money {
    return this._costEstimate;
  }
  get redaction(): RedactionReport {
    return this._redaction;
  }
  get processingTimeMs(): number {
    return this._processingTimeMs;
  }
  get requestedAt(): Instant {
    return this._requestedAt;
  }
  get completedAt(): Instant | null {
    return this._completedAt;
  }
  get requestedBy(): ActorRef {
    return this._requestedBy;
  }
  get error(): AnalysisError | null {
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
  static fromPersistence(doc: AnalysisPersistence): Analysis {
    const scope: Scope = {
      clusterId: doc.scope.clusterId as Scope['clusterId'],
    };
    if (doc.scope.namespace !== undefined)
      scope.namespace = doc.scope.namespace;
    if (doc.scope.kind !== undefined) scope.kind = doc.scope.kind;
    return new Analysis({
      id: doc.id as AnalysisId,
      type: doc.type,
      scope,
      strategy: doc.strategy,
      status: doc.status,
      retrieved: [...doc.retrieved],
      insights: [...doc.insights],
      recommendations: [...doc.recommendations],
      predictions: [...doc.predictions],
      confidence: doc.confidence,
      tokens: { ...doc.tokens },
      costEstimate: { ...doc.costEstimate },
      redaction: { ...doc.redaction },
      processingTimeMs: doc.processingTimeMs,
      requestedAt: doc.requestedAt as Instant,
      completedAt:
        doc.completedAt === null ? null : (doc.completedAt as Instant),
      requestedBy: { ...doc.requestedBy },
      error: doc.error === null ? null : { ...doc.error },
    });
  }

  toPersistence(): AnalysisPersistence {
    const scope: AnalysisPersistence['scope'] = {
      clusterId: this._scope.clusterId,
    };
    if (this._scope.namespace !== undefined)
      scope.namespace = this._scope.namespace;
    if (this._scope.kind !== undefined) scope.kind = this._scope.kind;
    return {
      id: this._id,
      type: this._type,
      scope,
      strategy: this._strategy,
      status: this._status,
      retrieved: [...this._retrieved],
      insights: [...this._insights],
      recommendations: [...this._recommendations],
      predictions: [...this._predictions],
      confidence: this._confidence,
      tokens: { ...this._tokens },
      costEstimate: { ...this._costEstimate },
      redaction: { ...this._redaction },
      processingTimeMs: this._processingTimeMs,
      requestedAt: this._requestedAt,
      completedAt: this._completedAt,
      requestedBy: { ...this._requestedBy },
      error: this._error === null ? null : { ...this._error },
    };
  }
}
