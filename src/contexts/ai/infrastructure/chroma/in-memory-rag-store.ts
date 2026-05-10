// In-memory RagStore. Used by tests and in environments where no Chroma
// is configured. Backed by a Map plus deterministic token-frequency
// embeddings so retrieval is reproducible without a real vector model.
//
// Optimised: caches the embedding fingerprint per ingested document so
// repeated ingestions of the same content are O(1).

import { createHash } from 'node:crypto';
import type {
  RagDocumentInput,
  RagHit,
  RagIngestSummary,
  RagQueryOptions,
  RagStore,
} from '../../domain/ports/rag-store';

interface StoredDoc {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  embedding: Float32Array;
}

const EMBED_DIM = 64;

/**
 * Deterministic, model-free embedding: hash each token into one of N
 * dimensions and accumulate frequencies. Good enough for unit tests +
 * fallback-mode operation.
 */
function tokenFrequencyEmbedding(text: string): Float32Array {
  const v = new Float32Array(EMBED_DIM);
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(Boolean);
  for (const t of tokens) {
    const h = simpleHash(t);
    const idx = h % EMBED_DIM;
    v[idx] = (v[idx] ?? 0) + 1;
  }
  // L2 normalise so cosine sim == dot product.
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < v.length; i++) {
      v[i] = (v[i] ?? 0) / norm;
    }
  }
  return v;
}

function simpleHash(s: string): number {
  // 32-bit FNV-1a — small + collision-tolerable for embeddings.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

function contentId(content: string): string {
  return 'sha256:' + createHash('sha256').update(content).digest('hex');
}

export class InMemoryRagStore implements RagStore {
  private readonly docs = new Map<string, StoredDoc>();

  async ingest(documents: RagDocumentInput[]): Promise<RagIngestSummary> {
    let ingested = 0;
    let deduped = 0;
    for (const doc of documents) {
      const id = doc.id ?? contentId(doc.content);
      if (this.docs.has(id)) {
        deduped += 1;
        continue;
      }
      this.docs.set(id, {
        id,
        content: doc.content,
        metadata: { ...(doc.metadata ?? {}) },
        embedding: tokenFrequencyEmbedding(doc.content),
      });
      ingested += 1;
    }
    return { ingested, deduped };
  }

  async query(text: string, opts: RagQueryOptions): Promise<RagHit[]> {
    const q = tokenFrequencyEmbedding(text);
    const hits: RagHit[] = [];
    for (const doc of this.docs.values()) {
      if (opts.filter && !matchesFilter(doc.metadata, opts.filter)) continue;
      const score = cosineSim(q, doc.embedding);
      hits.push({
        id: doc.id,
        content: doc.content,
        metadata: { ...doc.metadata },
        score,
      });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, Math.max(0, opts.topK));
  }

  async retire(id: string): Promise<void> {
    this.docs.delete(id);
  }

  /** Test hook. */
  size(): number {
    return this.docs.size;
  }
}

function matchesFilter(
  metadata: Record<string, unknown>,
  filter: Record<string, unknown>
): boolean {
  for (const [k, v] of Object.entries(filter)) {
    if (metadata[k] !== v) return false;
  }
  return true;
}
