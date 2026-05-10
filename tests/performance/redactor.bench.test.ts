// Redactor benchmark.
//
// Generates 10k synthesised inputs (a mix of secrets/PII/uuids/inert
// text) and runs the Redactor across them 100 times. Prints p50/p95/
// mean end-to-end ms per iteration; no assertions are made because
// performance varies by host.

import { Redactor } from '../../src/contexts/ai/domain/redactor';

const ITERATIONS = 100;
const ROWS = 10_000;

function buildRows(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 5 === 0) {
      out.push(`api_key=sk-${'a'.repeat(24)}`);
    } else if (i % 5 === 1) {
      out.push(`token=eyJhbGciOiJIUzI1NiJ9.payload.signature`);
    } else if (i % 5 === 2) {
      out.push(`email user${i}@example.com from ip 10.0.${i % 255}.${i % 255}`);
    } else if (i % 5 === 3) {
      out.push(`session 550e8400-e29b-41d4-a716-446655440000`);
    } else {
      out.push(`benign manifest line ${i}: replicas=3 namespace=default`);
    }
  }
  return out;
}

describe('Redactor — bench (10k rows × 100 iterations)', () => {
  it('prints p50/p95/mean redact latency', () => {
    const r = new Redactor();
    const rows = buildRows(ROWS);
    // Warm-up.
    r.redactAll(rows);

    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = process.hrtime.bigint();
      r.redactAll(rows);
      const t1 = process.hrtime.bigint();
      samples.push(Number(t1 - t0) / 1_000_000);
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.5)] ?? 0;
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
    const mean = samples.reduce((s, v) => s + v, 0) / samples.length;

    console.log(
      `redactor bench: rows=${ROWS} iterations=${ITERATIONS} ` +
        `p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms mean=${mean.toFixed(2)}ms`
    );
    expect(samples.length).toBe(ITERATIONS);
  });
});
