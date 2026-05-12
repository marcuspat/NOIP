// Bench: ingest 1k synthetic docs into a real ChromaDB instance and
// then run 100 random queries with topK=10. Reports p50/p95/total for
// each phase.
//
// Gated by the same availability probe as the contract suite. If
// CHROMA_URL is unreachable the test becomes a no-op (single SKIP
// line, exit 0) — never fails. This file runs only under the
// performance bench glob, not in the default `npm test` invocation.
//
// Run with:
//   CHROMA_URL=http://localhost:8000 \
//   npx jest tests/performance/chroma-ingest.bench.test.ts --runInBand --testTimeout=120000

import { performance } from 'node:perf_hooks';
import { ChromaAdapter } from '../../src/contexts/ai/infrastructure/chroma/chroma-adapter';
import {
  isChromaReachable,
  resolveChromaUrl,
} from '../contract/ai/_helpers/chroma-availability';
import {
  dropCollection,
  ensureCollection,
  uniqueCollectionName,
} from '../contract/ai/_helpers/collection-lifecycle';
import { extraDocs } from '../contract/ai/_helpers/synthetic-corpus';

const INGEST_COUNT = Number(process.env['BENCH_INGEST_COUNT'] ?? 1_000);
const QUERY_COUNT = Number(process.env['BENCH_QUERY_COUNT'] ?? 100);
const INGEST_BATCH = Number(process.env['BENCH_INGEST_BATCH'] ?? 50);

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length)
  );
  return sorted[idx] ?? 0;
}

function fmt(n: number): string {
  return `${n.toFixed(1)}ms`;
}

const PROBE_PHRASES = [
  'kubernetes admission controller policy',
  'rbac binding audit review',
  'compliance soc2 control mapping',
  'p99 latency throttling investigation',
  'etcd disk performance saturation',
  'network policy default deny ingress',
  'image pull secret rotation',
  'horizontal pod autoscaler signal stability',
  'gdpr encryption at rest',
  'concurrent ingest synthetic load',
];

describe('Chroma ingest/query bench', () => {
  let url: string;
  let reachable = false;
  let collection = '';
  let adapter: ChromaAdapter | null = null;

  beforeAll(async () => {
    url = resolveChromaUrl();
    reachable = await isChromaReachable(url, 1500);

    console.log(
      `[chroma-bench] CHROMA_URL=${url} reachable=${reachable} ingest=${INGEST_COUNT} queries=${QUERY_COUNT}`
    );
    if (!reachable) return;
    collection = uniqueCollectionName('noip_bench');
    await ensureCollection(url, collection);
    adapter = new ChromaAdapter({ baseURL: url, collection });
  }, 15_000);

  afterAll(async () => {
    if (reachable && collection) {
      await dropCollection(url, collection);
    }
  });

  it('reports p50/p95 for ingest and query phases', async () => {
    if (!reachable || !adapter) {
      console.log('[chroma-bench] SKIP (unreachable)');
      return;
    }
    const docs = extraDocs(INGEST_COUNT, 'bench');
    const ingestSamples: number[] = [];
    const totalIngestStart = performance.now();
    for (let i = 0; i < docs.length; i += INGEST_BATCH) {
      const batch = docs.slice(i, i + INGEST_BATCH);
      const t0 = performance.now();
      await adapter.ingest(batch);
      ingestSamples.push(performance.now() - t0);
    }
    const totalIngest = performance.now() - totalIngestStart;

    const querySamples: number[] = [];
    for (let i = 0; i < QUERY_COUNT; i++) {
      const phrase = PROBE_PHRASES[i % PROBE_PHRASES.length] ?? 'kubernetes';
      const t0 = performance.now();
      await adapter.query(phrase, { topK: 10 });
      querySamples.push(performance.now() - t0);
    }

    console.log(
      [
        '[chroma-bench] results:',
        `  ingest: total=${fmt(totalIngest)} ` +
          `p50=${fmt(percentile(ingestSamples, 50))} ` +
          `p95=${fmt(percentile(ingestSamples, 95))} ` +
          `batches=${ingestSamples.length} batch_size=${INGEST_BATCH}`,
        `  query: p50=${fmt(percentile(querySamples, 50))} ` +
          `p95=${fmt(percentile(querySamples, 95))} ` +
          `count=${querySamples.length}`,
      ].join('\n')
    );
    // No assertions — this is a reporting bench. Phase 5 wires the
    // numbers into the performance dashboard.
    expect(ingestSamples.length).toBeGreaterThan(0);
    expect(querySamples.length).toBe(QUERY_COUNT);
  }, 300_000);
});
