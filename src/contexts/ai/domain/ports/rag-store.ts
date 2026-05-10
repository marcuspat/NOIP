// Domain-side port for the RAG (vector) store. The ChromaAdapter (or the
// InMemoryRagStore in tests / when no Chroma is configured) implements
// this surface.
//
// Per ADR-0013, retrieval happens against this neutral interface; the
// adapter is responsible for embedding generation, similarity ranking,
// and metadata filtering. Foreign types (Chroma's `Document`,
// `IncludeEnum` etc.) MUST NOT leak above the adapter.

import type { Embedding } from '../value-objects';

export interface RagDocumentInput {
  /**
   * Optional explicit id. When omitted, the adapter computes a stable
   * id by SHA-256 over the content (DDD-08 ingestion idempotence).
   */
  id?: string;
  content: string;
  metadata?: Record<string, unknown>;
  /** Optional pre-computed embedding; otherwise the adapter generates one. */
  embedding?: Embedding;
}

export interface RagIngestSummary {
  /** Number of documents accepted as new. */
  ingested: number;
  /** Number of documents matched by id and skipped. */
  deduped: number;
}

export interface RagHit {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  /** Higher = better match. Adapters normalise to [0, 1]. */
  score: number;
}

export interface RagQueryOptions {
  topK: number;
  filter?: Record<string, unknown>;
}

/**
 * Provider-neutral RAG store interface. Implementations:
 *   - infrastructure/chroma/in-memory-rag-store.ts (deterministic, used in tests)
 *   - infrastructure/chroma/chroma-adapter.ts (HTTP, prod)
 */
export interface RagStore {
  ingest(documents: RagDocumentInput[]): Promise<RagIngestSummary>;
  query(text: string, opts: RagQueryOptions): Promise<RagHit[]>;
  retire(id: string): Promise<void>;
}
