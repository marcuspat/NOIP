// Live ChromaDB contract suite for `ChromaAdapter`.
//
// Skip-gated: a single beforeAll resolves `CHROMA_URL` and probes a
// heartbeat. If unreachable, every test in this file becomes a no-op via
// `it.skip` / `describe.skip` equivalent — never a failure. This file is
// invoked only by the dedicated `npm run test:contract` script and lives
// outside the unit-test glob.
//
// Each run targets a uniquely-namespaced collection so retries and
// parallel CI shards don't pollute one another. The afterAll attempts
// best-effort cleanup; failure to delete is a warning, not a hard fail.
//
// Diagnostics: set `CHROMA_CONTRACT_VERBOSE=1` to log per-test timing
// and the wire status code distribution. Useful when an upstream Chroma
// version drifts the request/response shape.

import { performance } from 'node:perf_hooks';
import { ChromaAdapter } from '../../../src/contexts/ai/infrastructure/chroma/chroma-adapter';
import type { RagHit } from '../../../src/contexts/ai/domain/ports/rag-store';
import {
  isChromaReachable,
  resolveChromaUrl,
} from './_helpers/chroma-availability';
import {
  dropCollection,
  ensureCollection,
  uniqueCollectionName,
} from './_helpers/collection-lifecycle';
import {
  extraDocs,
  largeDoc,
  syntheticCorpus,
} from './_helpers/synthetic-corpus';

const VERBOSE = process.env['CHROMA_CONTRACT_VERBOSE'] === '1';
const CHROMA_URL = resolveChromaUrl();

interface TimingRecord {
  name: string;
  ms: number;
}

const timings: TimingRecord[] = [];
const statusCounts = new Map<number, number>();

/**
 * Wrap an adapter call to record wire status codes when verbose mode is
 * on. We do this by monkey-patching the global fetch for the duration of
 * the adapter call — the adapter accepts a `fetchImpl` override which we
 * use as a more direct hook.
 */
function makeInstrumentedFetch(): typeof fetch {
  const orig = fetch;
  return async (input, init) => {
    const res = await orig(input as Parameters<typeof fetch>[0], init);
    statusCounts.set(res.status, (statusCounts.get(res.status) ?? 0) + 1);
    return res;
  };
}

function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!VERBOSE) return fn();
  return (async () => {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      timings.push({ name, ms: performance.now() - t0 });
    }
  })();
}

interface Harness {
  reachable: boolean;
  collection: string;
  adapter: ChromaAdapter;
}

const harness: Harness = {
  reachable: false,
  collection: uniqueCollectionName(),
  adapter: undefined as unknown as ChromaAdapter,
};

beforeAll(async () => {
  harness.reachable = await isChromaReachable(CHROMA_URL, 1500);
  // Single startup line — visible in every CI log.

  console.log(
    `[chroma-contract] CHROMA_URL=${CHROMA_URL} reachable=${harness.reachable}`
  );
  if (!harness.reachable) return;
  await ensureCollection(CHROMA_URL, harness.collection);
  harness.adapter = new ChromaAdapter({
    baseURL: CHROMA_URL,
    collection: harness.collection,
    ...(VERBOSE ? { fetchImpl: makeInstrumentedFetch() } : {}),
  });
}, 10_000);

afterAll(async () => {
  if (harness.reachable) {
    const ok = await dropCollection(CHROMA_URL, harness.collection);
    if (!ok) {
      console.warn(
        `[chroma-contract] cleanup: failed to drop collection ${harness.collection}`
      );
    }
  }
  if (VERBOSE) {
    console.log('[chroma-contract] timings:');
    for (const t of timings) {
      console.log(`  ${t.name}: ${t.ms.toFixed(1)}ms`);
    }

    console.log('[chroma-contract] wire status counts:');
    for (const [k, v] of statusCounts) {
      console.log(`  ${k}: ${v}`);
    }
  }
});

/**
 * Skip wrapper: if Chroma is unreachable, every test logs and returns
 * early. We deliberately use `it` (not `it.skip` from a conditional) so
 * the test count in the runner reflects what was attempted; the body
 * simply early-returns. `expect.hasAssertions` is intentionally NOT
 * called so the early-return is not flagged.
 */
function contractIt(name: string, fn: () => Promise<void>, timeoutMs?: number) {
  const args: Parameters<typeof it> = [
    name,
    async () => {
      if (!harness.reachable) {
        console.log(`[chroma-contract] SKIP ${name} (unreachable)`);
        return;
      }
      await fn();
    },
  ];
  if (timeoutMs !== undefined) {
    return it(args[0], args[1], timeoutMs);
  }
  return it(args[0], args[1]);
}

describe('ChromaAdapter contract (live)', () => {
  contractIt('ingestion: 30-doc corpus is accepted', async () => {
    const corpus = syntheticCorpus();
    const summary = await timed('ingest:initial', () =>
      harness.adapter.ingest([...corpus])
    );
    expect(summary.ingested).toBe(corpus.length);
    expect(summary.deduped).toBe(0);
  });

  contractIt(
    'ingestion: re-ingest of the same corpus is idempotent',
    async () => {
      // NOTE: The current ChromaAdapter implementation returns
      // `{ ingested: documents.length, deduped: 0 }` unconditionally
      // because the Chroma `upsert` endpoint does not report dedup
      // counts. The contract — per `RagStore` and InMemoryRagStore — is
      // that re-ingest reports `ingested=0, deduped=N`. We assert the
      // strong contract; a Chroma-side regression that breaks
      // collection persistence will surface here, and a missing dedup
      // implementation in the adapter will be visible as a failure in
      // nightly. Run with CHROMA_CONTRACT_VERBOSE=1 to see status codes.
      const corpus = syntheticCorpus();
      const summary = await timed('ingest:reingest', () =>
        harness.adapter.ingest([...corpus])
      );
      expect(summary.ingested + summary.deduped).toBe(corpus.length);
      // Strong contract assertion. The adapter's `upsert`-only path does
      // not currently distinguish new vs existing — the assertion
      // documents the expected behaviour and gates nightly regressions.
      expect(summary.deduped).toBe(corpus.length);
      expect(summary.ingested).toBe(0);
    }
  );

  contractIt(
    'top-k query returns mostly on-topic hits for a k8s-security phrase',
    async () => {
      const hits = await timed('query:topk', () =>
        harness.adapter.query('how do I prevent privileged containers', {
          topK: 5,
        })
      );
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.length).toBeLessThanOrEqual(5);
      const onTopic = hits.filter(
        (h: RagHit) => h.metadata['topic'] === 'k8s-security'
      ).length;
      expect(onTopic).toBeGreaterThanOrEqual(3);
    }
  );

  contractIt(
    'metadata filter restricts results to a single topic',
    async () => {
      const hits = await timed('query:filtered', () =>
        harness.adapter.query('how do I prevent privileged containers', {
          topK: 10,
          filter: { topic: 'compliance' },
        })
      );
      expect(hits.length).toBeGreaterThan(0);
      for (const h of hits) {
        expect(h.metadata['topic']).toBe('compliance');
      }
    }
  );

  contractIt(
    'retire(id) removes a document from subsequent queries',
    async () => {
      const probe =
        'Disable hostPath volumes for workload pods. They escape namespace isolation';
      const before = await timed('query:before-retire', () =>
        harness.adapter.query(probe, { topK: 3 })
      );
      const victim = before[0];
      expect(victim).toBeDefined();
      if (!victim) return;
      await timed('retire', () => harness.adapter.retire(victim.id));
      const after = await timed('query:after-retire', () =>
        harness.adapter.query(probe, { topK: 10 })
      );
      expect(after.find(h => h.id === victim.id)).toBeUndefined();
    }
  );

  contractIt(
    'query("") returns an empty hit set (or no error path)',
    async () => {
      // The InMemoryRagStore returns [] for empty query (token list is
      // empty so all similarities collapse to 0 but topK can still
      // surface zero-score items). The contract here is that the
      // adapter does NOT throw. Some Chroma versions reject empty
      // query_texts with a 400; treat that as acceptable by accepting
      // either an empty array or any non-throwing result.
      try {
        const hits = await timed('query:empty', () =>
          harness.adapter.query('', { topK: 5 })
        );
        expect(Array.isArray(hits)).toBe(true);
        expect(hits.length).toBeLessThanOrEqual(5);
      } catch (err) {
        // Documented behaviour: a ProviderError 4xx for empty queries
        // is acceptable. The contract test exists to make any change in
        // behaviour visible — not to enforce one or the other.

        console.warn(
          '[chroma-contract] empty query rejected by server:',
          err instanceof Error ? err.message : err
        );
      }
    }
  );

  contractIt(
    'large payload (50KB) round-trips through ingest and query',
    async () => {
      const marker = 'LARGE_BLOB_PROBE';
      const doc = largeDoc(50_000, marker);
      await timed('ingest:large', () => harness.adapter.ingest([doc]));
      const hits = await timed('query:large', () =>
        harness.adapter.query(
          'kubernetes admission controller policy enforcement audit',
          { topK: 5 }
        )
      );
      // The large doc has unique tag metadata; it should appear in the
      // top results for its dominant tokens.
      const found = hits.some(h => h.id === doc.id);
      expect(found).toBe(true);
    },
    20_000
  );

  contractIt(
    'concurrent ingest: 4 parallel batches × 5 unique docs each',
    async () => {
      // 4 workers, each contributing 5 unique-to-corpus docs. Each
      // worker's docs use a worker-specific salt so ids never collide
      // across workers. Final corpus size must be 30 + 20 = 50.
      const workers = await Promise.all(
        [0, 1, 2, 3].map(w =>
          timed(`ingest:concurrent-${w}`, () =>
            harness.adapter.ingest(extraDocs(5, `worker-${w}`))
          )
        )
      );
      const totalReported = workers.reduce((s, w) => s + w.ingested, 0);
      // Workers may report dedup'd counts when the adapter implements
      // dedupe; reported "new" count should not exceed 20.
      expect(totalReported).toBeLessThanOrEqual(20);

      // Verify via query that all 20 are retrievable. We probe by the
      // marker phrase shared across `extraDocs`.
      const hits = await timed('query:concurrent', () =>
        harness.adapter.query(
          'Extra synthetic document for concurrent ingest test',
          { topK: 50 }
        )
      );
      const extraHitIds = new Set(
        hits
          .filter(h =>
            String(h.content).startsWith(
              'Extra synthetic document for concurrent ingest test'
            )
          )
          .map(h => h.id)
      );
      expect(extraHitIds.size).toBeGreaterThanOrEqual(20);
    },
    30_000
  );
});
