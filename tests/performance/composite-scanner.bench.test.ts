// Bench: synthesise 100 scans, each fanning out 5 adapters with 200ms
// of stubbed latency apiece. Reports total time + per-scan p50/p95/mean.
// Doesn't assert — output goes to the test runner's logs.
//
// Run with:
//   npx jest tests/performance/composite-scanner.bench.test.ts --runInBand

import { performance } from 'node:perf_hooks';
import { CompositeScanner } from '../../src/contexts/security/infrastructure/scanners/composite-scanner';
import type {
  RawFinding,
  ScannerClient,
  ScannerInput,
} from '../../src/contexts/security/domain/ports/scanner-client';
import { builtinPolicyId } from '../../src/contexts/security/infrastructure/scanners/builtin-policy-scanner';

const SCAN_COUNT = Number(process.env['BENCH_SCANS'] ?? 100);
const ADAPTERS_PER_SCAN = 5;
const SIMULATED_LATENCY_MS = 200;

function makeFinding(idx: number): RawFinding {
  return {
    policyId: builtinPolicyId(`bench.${idx}`),
    resource: {
      apiVersion: 'v1',
      kind: 'Pod',
      namespace: 'demo',
      name: `pod-${idx}`,
    },
    severity: 'high',
    description: 'bench',
    evidence: {
      source: 'bench',
      summary: 'bench',
      capturedAt: '2025-01-01T00:00:00Z' as never,
    },
  };
}

class StubbedAdapter implements ScannerClient {
  constructor(
    public readonly id: string,
    private readonly latencyMs: number,
    private readonly findings: RawFinding[]
  ) {}
  async scan(): Promise<RawFinding[]> {
    await new Promise(r => setTimeout(r, this.latencyMs));
    return this.findings;
  }
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx]!;
}

describe('Bench: CompositeScanner fan-out', () => {
  jest.setTimeout(120_000);

  it(`runs ${SCAN_COUNT} scans across ${ADAPTERS_PER_SCAN} adapters`, async () => {
    const adapters: ScannerClient[] = Array.from(
      { length: ADAPTERS_PER_SCAN },
      (_, i) =>
        new StubbedAdapter(`adapter-${i}`, SIMULATED_LATENCY_MS, [
          makeFinding(i),
        ])
    );
    const composite = new CompositeScanner(
      adapters,
      { warn: () => undefined },
      {
        concurrency: 4,
      }
    );
    const input: ScannerInput = { records: [] };

    const perScan: number[] = [];
    const t0 = performance.now();
    for (let i = 0; i < SCAN_COUNT; i++) {
      const s = performance.now();
      const out = await composite.scan(input);
      perScan.push(performance.now() - s);
      expect(out).toHaveLength(ADAPTERS_PER_SCAN);
    }
    const total = performance.now() - t0;

    perScan.sort((a, b) => a - b);
    const sum = perScan.reduce((a, b) => a + b, 0);
    const mean = sum / perScan.length;
    const p50 = quantile(perScan, 0.5);
    const p95 = quantile(perScan, 0.95);

    console.log(
      `[bench] composite-scanner: scans=${SCAN_COUNT} adapters=${ADAPTERS_PER_SCAN} ` +
        `latencyMs=${SIMULATED_LATENCY_MS} total=${total.toFixed(0)}ms ` +
        `mean=${mean.toFixed(2)}ms p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms`
    );
  });
});
