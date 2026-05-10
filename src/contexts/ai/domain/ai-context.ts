// AIContext aggregate (RAG corpus projection).
//
// One projection row per ingested RAG document. The ChromaDB-backed
// corpus is the authoritative source; this aggregate is the Mongo
// projection used for cross-reference and admin views (DDD-08).
//
// Invariants:
//   - id = sha256(content). Re-ingesting identical content is a no-op.
//   - Embeddings are tagged with the model id that produced them.

import { createHash } from 'node:crypto';
import {
  type Clock,
  type ContextId,
  type DomainEvent,
  type Instant,
} from '../../../shared/kernel';
import { compose } from '../../../shared/kernel';
import { ValidationError } from '../../../shared/errors';
import type { AIContextType, Embedding } from './value-objects';

const EVENT_CONTEXT = 'ai';
const AGGREGATE_TYPE = 'ai_context';

export interface AIContextPersistence {
  id: string;
  type: AIContextType;
  content: string;
  source: string;
  ingestedAt: string;
  retiredAt: string | null;
  confidence: number;
  embedding: Embedding | null;
  metadata: Record<string, unknown>;
}

export interface AIContextIngestSpec {
  type: AIContextType;
  content: string;
  source: string;
  confidence?: number;
  embedding?: Embedding;
  metadata?: Record<string, unknown>;
}

/**
 * Compute the canonical RAG content id (sha256 over content).
 *
 * Exported so the application service can dedupe on ingestion without
 * touching the aggregate.
 */
export function contextIdFor(content: string): ContextId {
  return ('sha256:' +
    createHash('sha256').update(content).digest('hex')) as ContextId;
}

export class AIContext {
  private _id: ContextId;
  private _type: AIContextType;
  private _content: string;
  private _source: string;
  private _ingestedAt: Instant;
  private _retiredAt: Instant | null;
  private _confidence: number;
  private _embedding: Embedding | null;
  private _metadata: Record<string, unknown>;
  private readonly _pendingEvents: DomainEvent<unknown>[] = [];

  private constructor(args: {
    id: ContextId;
    type: AIContextType;
    content: string;
    source: string;
    ingestedAt: Instant;
    retiredAt: Instant | null;
    confidence: number;
    embedding: Embedding | null;
    metadata: Record<string, unknown>;
  }) {
    this._id = args.id;
    this._type = args.type;
    this._content = args.content;
    this._source = args.source;
    this._ingestedAt = args.ingestedAt;
    this._retiredAt = args.retiredAt;
    this._confidence = args.confidence;
    this._embedding = args.embedding;
    this._metadata = args.metadata;
  }

  static ingest(spec: AIContextIngestSpec, clock: Clock): AIContext {
    if (!spec.content || spec.content.trim().length === 0) {
      throw new ValidationError('content is required');
    }
    const id = contextIdFor(spec.content);
    const c = new AIContext({
      id,
      type: spec.type,
      content: spec.content,
      source: spec.source,
      ingestedAt: clock.nowInstant(),
      retiredAt: null,
      confidence: clamp01(spec.confidence ?? 0.8),
      embedding: spec.embedding ?? null,
      metadata: { ...(spec.metadata ?? {}) },
    });
    c._pendingEvents.push(
      compose(
        {
          type: 'ai.context.ingested',
          context: EVENT_CONTEXT,
          aggregateType: AGGREGATE_TYPE,
          aggregateId: id,
          actor: { type: 'system' },
          payload: { contextId: id, type: spec.type, source: spec.source },
        },
        clock
      )
    );
    return c;
  }

  retire(reason: string, clock: Clock): void {
    if (this._retiredAt !== null) return;
    this._retiredAt = clock.nowInstant();
    this._pendingEvents.push(
      compose(
        {
          type: 'ai.context.retired',
          context: EVENT_CONTEXT,
          aggregateType: AGGREGATE_TYPE,
          aggregateId: this._id,
          actor: { type: 'system' },
          payload: { contextId: this._id, reason },
        },
        clock
      )
    );
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------
  get id(): ContextId {
    return this._id;
  }
  get type(): AIContextType {
    return this._type;
  }
  get content(): string {
    return this._content;
  }
  get source(): string {
    return this._source;
  }
  get ingestedAt(): Instant {
    return this._ingestedAt;
  }
  get retiredAt(): Instant | null {
    return this._retiredAt;
  }
  get confidence(): number {
    return this._confidence;
  }
  get embedding(): Embedding | null {
    return this._embedding;
  }
  get metadata(): Record<string, unknown> {
    return { ...this._metadata };
  }
  get isRetired(): boolean {
    return this._retiredAt !== null;
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
  static fromPersistence(doc: AIContextPersistence): AIContext {
    return new AIContext({
      id: doc.id as ContextId,
      type: doc.type,
      content: doc.content,
      source: doc.source,
      ingestedAt: doc.ingestedAt as Instant,
      retiredAt: doc.retiredAt === null ? null : (doc.retiredAt as Instant),
      confidence: doc.confidence,
      embedding: doc.embedding === null ? null : { ...doc.embedding },
      metadata: { ...doc.metadata },
    });
  }

  toPersistence(): AIContextPersistence {
    return {
      id: this._id,
      type: this._type,
      content: this._content,
      source: this._source,
      ingestedAt: this._ingestedAt,
      retiredAt: this._retiredAt,
      confidence: this._confidence,
      embedding: this._embedding === null ? null : { ...this._embedding },
      metadata: { ...this._metadata },
    };
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
