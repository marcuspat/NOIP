// LearningPattern aggregate.
//
// Records recurring insight signatures observed across analyses. The
// PatternLearner domain service is the *only* writer that creates new
// patterns; the FeedbackService reinforces / weakens them.
//
// Invariants (DDD-08):
//   - successRate is updated only on positive reinforcement (analyst
//     acknowledged the pattern as useful).
//   - Patterns are soft-deleted when confidence < threshold.

import {
  newId,
  type Clock,
  type DomainEvent,
  type Instant,
  type PatternId,
} from '../../../shared/kernel';
import { compose } from '../../../shared/kernel';
import { ValidationError } from '../../../shared/errors';
import type { Embedding } from './value-objects';

const EVENT_CONTEXT = 'ai';
const AGGREGATE_TYPE = 'learning_pattern';

/** Default confidence threshold below which a pattern is soft-deleted. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.3;

export interface LearningPatternPersistence {
  id: string;
  type: string;
  pattern: string;
  signature: string;
  confidence: number;
  successRate: number;
  embedding: Embedding | null;
  context: Record<string, unknown>;
  createdAt: string;
  lastUsed: string;
  usageCount: number;
  reinforcementCount: number;
  weakeningCount: number;
  deprecatedAt: string | null;
}

export interface LearningPatternCreateSpec {
  type: string;
  pattern: string;
  signature: string;
  confidence?: number;
  embedding?: Embedding;
  context?: Record<string, unknown>;
}

export class LearningPattern {
  private _id: PatternId;
  private _type: string;
  private _pattern: string;
  private _signature: string;
  private _confidence: number;
  private _successRate: number;
  private _embedding: Embedding | null;
  private _context: Record<string, unknown>;
  private _createdAt: Instant;
  private _lastUsed: Instant;
  private _usageCount: number;
  private _reinforcementCount: number;
  private _weakeningCount: number;
  private _deprecatedAt: Instant | null;
  private readonly _pendingEvents: DomainEvent<unknown>[] = [];

  private constructor(args: {
    id: PatternId;
    type: string;
    pattern: string;
    signature: string;
    confidence: number;
    successRate: number;
    embedding: Embedding | null;
    context: Record<string, unknown>;
    createdAt: Instant;
    lastUsed: Instant;
    usageCount: number;
    reinforcementCount: number;
    weakeningCount: number;
    deprecatedAt: Instant | null;
  }) {
    this._id = args.id;
    this._type = args.type;
    this._pattern = args.pattern;
    this._signature = args.signature;
    this._confidence = args.confidence;
    this._successRate = args.successRate;
    this._embedding = args.embedding;
    this._context = args.context;
    this._createdAt = args.createdAt;
    this._lastUsed = args.lastUsed;
    this._usageCount = args.usageCount;
    this._reinforcementCount = args.reinforcementCount;
    this._weakeningCount = args.weakeningCount;
    this._deprecatedAt = args.deprecatedAt;
  }

  static create(
    spec: LearningPatternCreateSpec,
    clock: Clock
  ): LearningPattern {
    if (!spec.pattern || spec.pattern.trim().length === 0) {
      throw new ValidationError('pattern is required');
    }
    if (!spec.signature || spec.signature.trim().length === 0) {
      throw new ValidationError('signature is required');
    }
    const initialConfidence = clamp01(spec.confidence ?? 0.6);
    const id = newId<PatternId>();
    const now = clock.nowInstant();
    const p = new LearningPattern({
      id,
      type: spec.type,
      pattern: spec.pattern,
      signature: spec.signature,
      confidence: initialConfidence,
      successRate: 0,
      embedding: spec.embedding ?? null,
      context: { ...(spec.context ?? {}) },
      createdAt: now,
      lastUsed: now,
      usageCount: 0,
      reinforcementCount: 0,
      weakeningCount: 0,
      deprecatedAt: null,
    });
    p._pendingEvents.push(
      compose(
        {
          type: 'ai.pattern.learned',
          context: EVENT_CONTEXT,
          aggregateType: AGGREGATE_TYPE,
          aggregateId: id,
          actor: { type: 'system' },
          payload: {
            patternId: id,
            type: spec.type,
            confidence: initialConfidence,
          },
        },
        clock
      )
    );
    return p;
  }

  /** Increment recurrence; mild confidence boost. */
  observe(clock: Clock): void {
    if (this._deprecatedAt !== null) return;
    this._usageCount += 1;
    this._lastUsed = clock.nowInstant();
    this._confidence = clamp01(this._confidence + 0.02);
  }

  /**
   * Positive feedback. Updates successRate (DDD-08 invariant: ONLY
   * reinforcement updates successRate) and bumps confidence.
   */
  reinforce(clock: Clock): void {
    if (this._deprecatedAt !== null) return;
    this._reinforcementCount += 1;
    const total = this._reinforcementCount + this._weakeningCount;
    this._successRate =
      total === 0 ? 0 : clamp01(this._reinforcementCount / total);
    this._confidence = clamp01(this._confidence + 0.05);
    this._lastUsed = clock.nowInstant();
  }

  /**
   * Negative feedback. Drops confidence; does NOT touch successRate
   * (per invariant). May trigger soft-delete.
   */
  weaken(clock: Clock, threshold = DEFAULT_CONFIDENCE_THRESHOLD): void {
    if (this._deprecatedAt !== null) return;
    this._weakeningCount += 1;
    this._confidence = clamp01(this._confidence - 0.1);
    this._lastUsed = clock.nowInstant();
    if (this._confidence < threshold) {
      this.deprecate('low_confidence', clock);
    }
  }

  /** Soft-delete the pattern. Idempotent. Emits `ai.pattern.deprecated`. */
  deprecate(reason: string, clock: Clock): void {
    if (this._deprecatedAt !== null) return;
    this._deprecatedAt = clock.nowInstant();
    this._pendingEvents.push(
      compose(
        {
          type: 'ai.pattern.deprecated',
          context: EVENT_CONTEXT,
          aggregateType: AGGREGATE_TYPE,
          aggregateId: this._id,
          actor: { type: 'system' },
          payload: { patternId: this._id, reason },
        },
        clock
      )
    );
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------
  get id(): PatternId {
    return this._id;
  }
  get type(): string {
    return this._type;
  }
  get pattern(): string {
    return this._pattern;
  }
  get signature(): string {
    return this._signature;
  }
  get confidence(): number {
    return this._confidence;
  }
  get successRate(): number {
    return this._successRate;
  }
  get usageCount(): number {
    return this._usageCount;
  }
  get reinforcementCount(): number {
    return this._reinforcementCount;
  }
  get weakeningCount(): number {
    return this._weakeningCount;
  }
  get deprecatedAt(): Instant | null {
    return this._deprecatedAt;
  }
  get isDeprecated(): boolean {
    return this._deprecatedAt !== null;
  }
  get embedding(): Embedding | null {
    return this._embedding;
  }
  get context(): Record<string, unknown> {
    return { ...this._context };
  }
  get createdAt(): Instant {
    return this._createdAt;
  }
  get lastUsed(): Instant {
    return this._lastUsed;
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
  static fromPersistence(doc: LearningPatternPersistence): LearningPattern {
    return new LearningPattern({
      id: doc.id as PatternId,
      type: doc.type,
      pattern: doc.pattern,
      signature: doc.signature,
      confidence: doc.confidence,
      successRate: doc.successRate,
      embedding: doc.embedding === null ? null : { ...doc.embedding },
      context: { ...doc.context },
      createdAt: doc.createdAt as Instant,
      lastUsed: doc.lastUsed as Instant,
      usageCount: doc.usageCount,
      reinforcementCount: doc.reinforcementCount,
      weakeningCount: doc.weakeningCount,
      deprecatedAt:
        doc.deprecatedAt === null ? null : (doc.deprecatedAt as Instant),
    });
  }

  toPersistence(): LearningPatternPersistence {
    return {
      id: this._id,
      type: this._type,
      pattern: this._pattern,
      signature: this._signature,
      confidence: this._confidence,
      successRate: this._successRate,
      embedding: this._embedding === null ? null : { ...this._embedding },
      context: { ...this._context },
      createdAt: this._createdAt,
      lastUsed: this._lastUsed,
      usageCount: this._usageCount,
      reinforcementCount: this._reinforcementCount,
      weakeningCount: this._weakeningCount,
      deprecatedAt: this._deprecatedAt,
    };
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
