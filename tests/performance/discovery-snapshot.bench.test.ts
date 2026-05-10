// Micro-bench for `SnapshotHasher.hash`. Hashes 10k synthesized records
// 1k iterations and prints p50/p95/mean latency. Doesn't assert — Phase 5
// wires this into real metrics so we can compare across builds.
//
// Run with:
//   npx jest tests/performance/discovery-snapshot.bench.test.ts --runInBand

import { performance } from 'perf_hooks';
import { SnapshotHasher } from '../../src/contexts/discovery/domain/snapshot-hasher';
import type { KubernetesResourceRecord } from '../../src/contexts/discovery/domain/value-objects';

function synth(n: number): KubernetesResourceRecord[] {
  const out: KubernetesResourceRecord[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      apiVersion: 'v1',
      kind: i % 3 === 0 ? 'Pod' : i % 3 === 1 ? 'Service' : 'ConfigMap',
      name: `r-${i}`,
      namespace: `ns-${i % 32}`,
      labels: { app: `noip-${i % 8}`, tier: i % 2 === 0 ? 'api' : 'worker' },
      annotations: {},
      spec: {
        replicas: i % 5,
        image: `noip/${i % 4}:1.0`,
        env: [
          { name: 'A', value: 'a' },
          { name: 'B', value: String(i) },
        ],
      },
      status: { phase: i % 2 === 0 ? 'Running' : 'Pending' },
    });
  }
  return out;
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length)
  );
  return sorted[idx]!;
}

describe('discovery-snapshot bench', () => {
  it('hashes 10k records 1k times', () => {
    const records = synth(10_000);
    const hasher = new SnapshotHasher();
    const samples: number[] = [];
    // Warm-up — give the JIT a chance to settle.
    for (let i = 0; i < 5; i++) hasher.hash(records);
    for (let i = 0; i < 1000; i++) {
      const t0 = performance.now();
      hasher.hash(records);
      samples.push(performance.now() - t0);
    }
    const sum = samples.reduce((a, b) => a + b, 0);
    const mean = sum / samples.length;
    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);

    console.log(
      `discovery-snapshot bench: records=10000 iters=1000 mean=${mean.toFixed(2)}ms p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms`
    );
    // No assertion — bench output goes to the test runner's logs.
    expect(samples.length).toBe(1000);
  }, 120_000);
});
