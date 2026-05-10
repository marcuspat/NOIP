// InMemoryRagStore — ingest dedupe, top-k by score, metadata filter.

import { InMemoryRagStore } from '../../../src/contexts/ai/infrastructure/chroma/in-memory-rag-store';

describe('InMemoryRagStore', () => {
  it('dedupes by content id on ingest', async () => {
    const store = new InMemoryRagStore();
    const a = await store.ingest([{ content: 'same' }]);
    const b = await store.ingest([{ content: 'same' }]);
    expect(a.ingested).toBe(1);
    expect(b.ingested).toBe(0);
    expect(b.deduped).toBe(1);
    expect(store.size()).toBe(1);
  });

  it('returns top-k results ordered by similarity', async () => {
    const store = new InMemoryRagStore();
    await store.ingest([
      { content: 'kubernetes pods networking ingress' },
      { content: 'completely different topic about pricing' },
      { content: 'kubernetes pods scheduling nodes' },
    ]);
    const hits = await store.query('kubernetes pods', { topK: 2 });
    expect(hits.length).toBe(2);
    expect(hits[0]?.score ?? 0).toBeGreaterThanOrEqual(hits[1]?.score ?? 0);
    expect(hits.every(h => h.content.includes('kubernetes'))).toBe(true);
  });

  it('honours metadata filter', async () => {
    const store = new InMemoryRagStore();
    await store.ingest([
      { content: 'a', metadata: { type: 'incident' } },
      { content: 'a', metadata: { type: 'compliance' } }, // different id (different metadata isn't part of id but content is)
      { content: 'b', metadata: { type: 'incident' } },
    ]);
    const hits = await store.query('a', {
      topK: 5,
      filter: { type: 'incident' },
    });
    expect(hits.every(h => h.metadata['type'] === 'incident')).toBe(true);
  });

  it('retire() drops a document by id', async () => {
    const store = new InMemoryRagStore();
    await store.ingest([{ content: 'doc' }]);
    expect(store.size()).toBe(1);
    const hits = await store.query('doc', { topK: 1 });
    expect(hits[0]).toBeDefined();
    await store.retire(hits[0]!.id);
    expect(store.size()).toBe(0);
  });
});
