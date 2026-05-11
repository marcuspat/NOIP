// Bench: synthesise 1k snapshots of 1k records each and archive each
// to the local-fs adapter. Reports total time, mean, p50, p95.
// Doesn't assert — output goes to the test runner's logs. Phase 5
// wires this into the real performance dashboard.
//
// Run with:
//   npx jest tests/performance/snapshot-archive.bench.test.ts --runInBand

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  FixedClock,
  InMemoryEventBus,
  type ClusterId,
  type SnapshotId,
} from '../../src/shared/kernel';
import { SnapshotArchiver } from '../../src/contexts/discovery/domain/snapshot-archiver';
import { LocalFsSnapshotArchiveAdapter } from '../../src/contexts/discovery/infrastructure/archive/local-fs-archive-adapter';
import { InMemorySnapshotRepository } from '../unit/discovery/archive/fakes';
import type { KubernetesResourceRecord } from '../../src/contexts/discovery/domain/value-objects';

const SNAPSHOT_COUNT = Number(process.env['BENCH_SNAPSHOTS'] ?? 1_000);
const RECORDS_PER_SNAPSHOT = Number(process.env['BENCH_RECORDS'] ?? 1_000);

function synthRecords(n: number, prefix: string): KubernetesResourceRecord[] {
  const out: KubernetesResourceRecord[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      apiVersion: 'v1',
      kind: i % 3 === 0 ? 'Pod' : i % 3 === 1 ? 'Service' : 'ConfigMap',
      name: `${prefix}-${i}`,
      namespace: `ns-${i % 32}`,
      labels: { app: `noip-${i % 8}`, tier: i % 2 === 0 ? 'api' : 'worker' },
      annotations: {},
      spec: {
        replicas: i % 5,
        image: `noip/${i % 4}:1.0`,
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

const clusterId = '00000000-0000-7000-8000-000000000aaa' as ClusterId;

function snapId(n: number): SnapshotId {
  return `00000000-0000-7000-8000-${String(n).padStart(12, '0')}` as SnapshotId;
}

describe('snapshot-archive bench', () => {
  it(`archives ${SNAPSHOT_COUNT} snapshots x ${RECORDS_PER_SNAPSHOT} records each`, async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'noip-archive-bench-')
    );
    try {
      const repo = new InMemorySnapshotRepository();
      for (let i = 0; i < SNAPSHOT_COUNT; i++) {
        repo.seed({
          id: snapId(i),
          clusterId,
          takenAt: new Date('2025-01-01T00:00:00.000Z'),
          records: synthRecords(RECORDS_PER_SNAPSHOT, `s${i}`),
        });
      }
      const store = new LocalFsSnapshotArchiveAdapter({ root });
      const bus = new InMemoryEventBus({ warn: () => {}, error: () => {} });
      const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
      const archiver = new SnapshotArchiver({
        repository: repo,
        store,
        bus,
        clock,
        config: { batchSize: SNAPSHOT_COUNT, concurrency: 4 },
      });

      const samples: number[] = [];
      const overallStart = performance.now();
      for (let i = 0; i < SNAPSHOT_COUNT; i++) {
        const t0 = performance.now();
        await archiver.archiveOne(snapId(i));
        samples.push(performance.now() - t0);
      }
      const overallMs = performance.now() - overallStart;
      const sum = samples.reduce((a, b) => a + b, 0);
      const mean = sum / samples.length;
      const p50 = percentile(samples, 50);
      const p95 = percentile(samples, 95);

      console.log(
        `snapshot-archive bench: snapshots=${SNAPSHOT_COUNT} recordsPerSnap=${RECORDS_PER_SNAPSHOT} totalMs=${overallMs.toFixed(0)} mean=${mean.toFixed(2)}ms p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms`
      );
      expect(samples.length).toBe(SNAPSHOT_COUNT);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 600_000);
});
