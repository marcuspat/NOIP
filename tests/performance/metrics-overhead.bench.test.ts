// Bench for the prom-client overhead — ADR-0023.
//
// Goal: confirm `counter.labels({...}).inc()` is "free" in the
// hot path. Run 1M increments against a labelled counter, measure
// elapsed wall-clock, and emit a per-op µs figure.
//
// The hard assertion is loose (< 5 µs/op on CI hardware) to avoid
// false positives on contended runners; the human-readable print
// is the load-bearing diagnostic.

import {
  counter,
  resetRegistryForTests,
} from '../../src/observability/registry';

const ITERATIONS = 1_000_000;
// Loose so noisy CI hardware doesn't flap. The real signal is the
// printed µs/op figure; expect < 1 µs/op on a modern laptop.
const MAX_MICROS_PER_OP = 5;

describe('prom-client overhead bench', () => {
  beforeEach(() => {
    resetRegistryForTests();
  });

  it(`counter.inc() costs < ${MAX_MICROS_PER_OP} µs/op over ${ITERATIONS.toLocaleString()} iterations`, () => {
    const c = counter('noip_bench_counter', 'bench counter', ['result']);
    const labelled = c.labels({ result: 'ok' });

    const startNs = process.hrtime.bigint();
    for (let i = 0; i < ITERATIONS; i++) {
      labelled.inc();
    }
    const endNs = process.hrtime.bigint();

    const elapsedNs = Number(endNs - startNs);
    const microsPerOp = elapsedNs / ITERATIONS / 1000;

    console.log(
      `[bench] noip_bench_counter.inc(): ${microsPerOp.toFixed(3)} µs/op over ${ITERATIONS.toLocaleString()} iters`
    );

    expect(microsPerOp).toBeLessThan(MAX_MICROS_PER_OP);
  });

  it(`counter.labels({...}).inc() (with label lookup each call) stays < ${MAX_MICROS_PER_OP * 2} µs/op`, () => {
    const c = counter('noip_bench_labels_counter', 'bench labels counter', [
      'result',
      'method',
    ]);

    const startNs = process.hrtime.bigint();
    for (let i = 0; i < ITERATIONS; i++) {
      c.labels({ result: 'ok', method: 'GET' }).inc();
    }
    const endNs = process.hrtime.bigint();

    const elapsedNs = Number(endNs - startNs);
    const microsPerOp = elapsedNs / ITERATIONS / 1000;

    console.log(
      `[bench] noip_bench_labels_counter.labels({...}).inc(): ${microsPerOp.toFixed(3)} µs/op over ${ITERATIONS.toLocaleString()} iters`
    );

    expect(microsPerOp).toBeLessThan(MAX_MICROS_PER_OP * 2);
  });
});
