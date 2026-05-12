// Unit tests for the synthetic-corpus generator. These run inside the
// default `npm test` invocation so the harness itself doesn't drift.

import {
  corpusId,
  extraDocs,
  largeDoc,
  syntheticCorpus,
  topicCounts,
} from '../../contract/ai/_helpers/synthetic-corpus';

describe('synthetic corpus', () => {
  it('produces 30 documents balanced across three topics', () => {
    const docs = syntheticCorpus();
    expect(docs.length).toBe(30);
    const counts = topicCounts(docs);
    expect(counts['k8s-security']).toBe(10);
    expect(counts['compliance']).toBe(10);
    expect(counts['performance']).toBe(10);
  });

  it('assigns each document a stable, content-derived id', () => {
    const docs = syntheticCorpus();
    for (const d of docs) {
      expect(d.id).toMatch(/^[0-9a-f]{16}$/);
      expect(corpusId(d.content)).toBe(d.id);
    }
  });

  it('documents are within the 200..500 char window required by the spec', () => {
    const docs = syntheticCorpus();
    for (const d of docs) {
      expect(d.content.length).toBeGreaterThanOrEqual(200);
      expect(d.content.length).toBeLessThanOrEqual(500);
    }
  });

  it('all metadata includes topic, severity, and a non-empty tags array', () => {
    const docs = syntheticCorpus();
    for (const d of docs) {
      expect(['k8s-security', 'compliance', 'performance']).toContain(
        d.metadata.topic
      );
      expect(['low', 'medium', 'high', 'critical']).toContain(
        d.metadata.severity
      );
      expect(Array.isArray(d.metadata.tags)).toBe(true);
      expect(d.metadata.tags.length).toBeGreaterThan(0);
    }
  });

  it('all ids are unique', () => {
    const docs = syntheticCorpus();
    const ids = new Set(docs.map(d => d.id));
    expect(ids.size).toBe(docs.length);
  });

  it('returns a stable reference across calls', () => {
    const a = syntheticCorpus();
    const b = syntheticCorpus();
    expect(a).toBe(b);
  });

  it('extraDocs() produces the requested count with unique ids', () => {
    const extras = extraDocs(5, 'worker-1');
    expect(extras.length).toBe(5);
    const ids = new Set(extras.map(d => d.id));
    expect(ids.size).toBe(5);
  });

  it('extraDocs() ids do not collide with the canonical corpus', () => {
    const canonical = new Set(syntheticCorpus().map(d => d.id));
    const extras = extraDocs(20, 'worker-test');
    for (const e of extras) expect(canonical.has(e.id)).toBe(false);
  });

  it('extraDocs() ids depend on salt — different salt yields different ids', () => {
    const a = extraDocs(3, 'salt-a');
    const b = extraDocs(3, 'salt-b');
    for (let i = 0; i < a.length; i++) {
      expect(a[i]?.id).not.toBe(b[i]?.id);
    }
  });

  it('largeDoc() returns approximately the requested byte size', () => {
    const d = largeDoc(50_000, 'PROBE');
    expect(d.content.length).toBe(50_000);
    expect(d.content).toContain('MARKER=PROBE');
    expect(d.id).toMatch(/^[0-9a-f]{16}$/);
  });
});
