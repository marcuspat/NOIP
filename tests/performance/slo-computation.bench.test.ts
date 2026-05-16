// Micro-bench for `SLOComputer.runOnce`. Computes burn-rate + remaining
// budget for 1000 SLOs against an in-memory Prometheus stub. The bench
// validates that the batched indicator-query path stays under a
// reasonable ceiling on commodity CI hardware.
//
// Run with:
//   npx jest tests/performance/slo-computation.bench.test.ts --runInBand

import { performance } from 'perf_hooks';
import { SLO } from '../../src/contexts/performance/domain/slo';
import { SLOComputer } from '../../src/contexts/performance/application/slo-computer';
import { InMemoryPromStub } from '../../src/contexts/performance/infrastructure/prometheus/in-memory-prom-stub';
import { InMemorySLORepository } from '../../src/contexts/performance/infrastructure/persistence/slo.repository';
import { FixedClock, InMemoryEventBus } from '../../src/shared/kernel';

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length)
  );
  return sorted[idx]!;
}

describe('slo-computation bench', () => {
  it('computes burn rate for 1000 SLOs over a stubbed Prometheus', async () => {
    const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
    const repo = new InMemorySLORepository();
    const prom = new InMemoryPromStub();
    const bus = new InMemoryEventBus({ warn: () => {}, error: () => {} });

    // Seed 1000 SLOs each with three indicators. The PromQL strings
    // are unique per SLO so the SLOComputer's batched fan-out hits
    // distinct stub entries.
    const SLO_COUNT = 1000;
    const slos: SLO[] = [];
    for (let i = 0; i < SLO_COUNT; i++) {
      const slo = SLO.create(
        {
          name: `slo-${i}`,
          target: { kind: 'availability', value: 0.999 },
          window: { rollingDays: 28 },
          indicators: [
            { query: `q_${i}_a` },
            { query: `q_${i}_b` },
            { query: `q_${i}_c` },
          ],
        },
        clock
      );
      // Mix: every third SLO is in breach; the rest are healthy. This
      // exercises the breach + recovered event paths on alternating
      // sweeps.
      const healthy = i % 3 !== 0;
      prom.set(`q_${i}_a`, healthy ? 1 : 0.5);
      prom.set(`q_${i}_b`, healthy ? 1 : 0.4);
      prom.set(`q_${i}_c`, healthy ? 1 : 0.6);
      slos.push(slo);
    }
    await repo.saveMany(slos);

    const computer = new SLOComputer({ prom, slos: repo, bus, clock });

    // Warm-up — let the JIT settle.
    for (let i = 0; i < 3; i++) {
      await computer.runOnce();
    }

    const ITERATIONS = 20;
    const samples: number[] = [];
    let totalQueries = 0;
    let totalUpdated = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      const r = await computer.runOnce();
      samples.push(performance.now() - t0);
      totalQueries += r.queriesIssued;
      totalUpdated += r.slosUpdated;
    }
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);

    console.log(
      `slo-computation bench: slos=${SLO_COUNT} indicators=3 iters=${ITERATIONS} ` +
        `mean=${mean.toFixed(2)}ms p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms ` +
        `queries/iter=${(totalQueries / ITERATIONS).toFixed(0)} ` +
        `updated/iter=${(totalUpdated / ITERATIONS).toFixed(0)}`
    );

    expect(samples.length).toBe(ITERATIONS);
    expect(totalQueries / ITERATIONS).toBe(SLO_COUNT * 3);
    expect(totalUpdated / ITERATIONS).toBe(SLO_COUNT);
  }, 60_000);
});
