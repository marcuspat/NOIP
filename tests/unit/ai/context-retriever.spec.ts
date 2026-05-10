// ContextRetriever — top-k + metadata filter passthrough.

import { ContextRetriever } from '../../../src/contexts/ai/domain/context-retriever';
import { InMemoryRagStore } from '../../../src/contexts/ai/infrastructure/chroma/in-memory-rag-store';

describe('ContextRetriever', () => {
  it('returns top-k from the underlying store', async () => {
    const store = new InMemoryRagStore();
    await store.ingest([
      { content: 'privileged container risk' },
      { content: 'network policy missing' },
      { content: 'rbac wide open' },
      { content: 'unrelated kubernetes meta-text' },
    ]);
    const retriever = new ContextRetriever(store);
    const hits = await retriever.retrieve({
      query: 'privileged container',
      policy: { topK: 2 },
    });
    expect(hits.length).toBe(2);
    expect(hits[0]?.content).toBe('privileged container risk');
  });

  it('passes metadata filter through to the store', async () => {
    const store = new InMemoryRagStore();
    await store.ingest([
      { content: 'a', metadata: { type: 'incident' } },
      { content: 'b', metadata: { type: 'compliance' } },
    ]);
    const retriever = new ContextRetriever(store);
    const hits = await retriever.retrieve({
      query: 'a',
      policy: { topK: 5, filter: { type: 'incident' } },
    });
    expect(hits.every(h => h.metadata['type'] === 'incident')).toBe(true);
  });
});
