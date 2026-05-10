// BuiltinPolicyScanner benchmark.
//
// Generates 10k synthetic Pod records and evaluates the scanner 100
// times. We print p50/p95/mean to stdout; no assertions are made
// because performance varies by host.

import { BuiltinPolicyScanner } from '../../src/contexts/security/infrastructure/scanners/builtin-policy-scanner';
import { FixedClock } from '../../src/shared/kernel';

const ITERATIONS = 100;
const RECORD_COUNT = 10_000;

function buildRecords(n: number) {
  const records: Array<{
    apiVersion: string;
    kind: string;
    namespace?: string;
    name: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
    spec: unknown;
    status: unknown;
  }> = [];
  for (let i = 0; i < n; i++) {
    const privileged = i % 7 === 0;
    const hostNetwork = i % 11 === 0;
    const latest = i % 3 === 0;
    records.push({
      apiVersion: 'v1',
      kind: 'Pod',
      namespace: `ns-${i % 50}`,
      name: `p-${i}`,
      labels: { app: `a-${i % 100}` },
      annotations: {},
      spec: {
        hostNetwork,
        containers: [
          {
            name: 'c',
            image: latest ? 'nginx:latest' : `nginx:1.${i % 25}`,
            securityContext: privileged
              ? { privileged: true }
              : { runAsNonRoot: true },
            resources: {
              limits: latest ? undefined : { memory: '128Mi' },
            },
            readinessProbe: i % 5 === 0 ? undefined : {},
            env: [
              i % 4 === 0
                ? { name: 'API_KEY', value: 'sk_live_' + 'x'.repeat(20) }
                : { name: 'PORT', value: '8080' },
            ],
          },
        ],
      },
      status: {},
    });
  }
  return records;
}

describe('BuiltinPolicyScanner — bench (10k resources × 100 iterations)', () => {
  it('prints p50/p95/mean evaluation latency', async () => {
    const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
    const scanner = new BuiltinPolicyScanner(clock, { concurrency: 8 });
    const records = buildRecords(RECORD_COUNT);
    // Warm-up.
    await scanner.scan({ records });

    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = process.hrtime.bigint();
      await scanner.scan({ records });
      const t1 = process.hrtime.bigint();
      samples.push(Number(t1 - t0) / 1_000_000); // ms
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.5)] ?? 0;
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
    const mean = samples.reduce((s, v) => s + v, 0) / samples.length;

    console.log(
      `policy-engine bench: records=${RECORD_COUNT} iterations=${ITERATIONS} ` +
        `p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms mean=${mean.toFixed(2)}ms`
    );
    expect(samples.length).toBe(ITERATIONS);
  });
});
