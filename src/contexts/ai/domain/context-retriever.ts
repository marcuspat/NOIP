// ContextRetriever — top-k retrieval from the configured RagStore.
//
// Resolves the per-template `retrievalPolicy` against the RagStore.
// Returns ranked hits; the application service records the IDs on the
// resulting Analysis.

import type { RagHit, RagStore } from './ports/rag-store';
import type { RetrievalPolicy } from './value-objects';

export interface ContextRetrievalRequest {
  /** Query text; the redacted scope payload typically. */
  query: string;
  policy: RetrievalPolicy;
}

export class ContextRetriever {
  constructor(private readonly store: RagStore) {}

  async retrieve(req: ContextRetrievalRequest): Promise<RagHit[]> {
    const topK = Math.max(1, Math.min(50, req.policy.topK));
    const opts: { topK: number; filter?: Record<string, unknown> } = { topK };
    if (req.policy.filter !== undefined) {
      opts.filter = req.policy.filter;
    }
    return this.store.query(req.query, opts);
  }
}
