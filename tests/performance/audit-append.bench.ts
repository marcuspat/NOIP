// Micro-bench for HashChainAppender.append() against the in-memory stub.
// Not a unit test — it asserts nothing; it just prints a single-line
// summary so CI / local runs surface trends. Phase 5 wires this into
// real metrics.
//
// Run with:
//   npx jest tests/performance/audit-append.bench.ts --runInBand

import { performance } from 'perf_hooks';

import { FixedClock } from '../../src/shared/kernel';
import {
  HashChainAppender,
  type AuditEntryInput,
} from '../../src/services/audit/hash-chain-appender.service';
import { InMemoryAuditCollection, CapturingLogger } from '../unit/audit/_stubs';

function makeEntry(i: number): AuditEntryInput {
  return {
    actor: { userId: `u-${i % 16}` },
    action: 'iam.user.touch',
    resource: '/api/users',
    resourceId: `user-${i}`,
    details: { method: 'POST', statusCode: 200, idx: i },
    ipAddress: '127.0.0.1',
    userAgent: 'bench',
  };
}

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((p / 100) * sorted.length))
  );
  return sorted[idx]!;
}

describe('audit-append.bench', () => {
  it('measures p50/p95 of append() over 1k iterations', async () => {
    const N = 1000;
    const collection = new InMemoryAuditCollection();
    const logger = new CapturingLogger();
    const appender = new HashChainAppender({
      collection,
      clock: new FixedClock(new Date('2026-05-10T00:00:00Z')),
      logger,
    });

    const samples: number[] = [];
    // Warm-up — first few iterations include JIT overhead.
    for (let i = 0; i < 25; i++) {
      await appender.append(makeEntry(-1 - i));
    }

    const startWall = performance.now();
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      await appender.append(makeEntry(i));
      samples.push(performance.now() - t0);
    }
    const totalMs = performance.now() - startWall;

    const p50 = percentile(samples, 50).toFixed(3);
    const p95 = percentile(samples, 95).toFixed(3);
    const p99 = percentile(samples, 99).toFixed(3);
    const mean = (samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(
      3
    );

    // Single-line summary, parseable by humans and grep alike.

    console.log(
      `audit-append.bench iters=${N} total=${totalMs.toFixed(1)}ms ` +
        `mean=${mean}ms p50=${p50}ms p95=${p95}ms p99=${p99}ms`
    );

    // Sanity check (not a real assertion — just ensures the bench ran).
    expect(samples.length).toBe(N);
  });
});
