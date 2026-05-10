// PromptComposer benchmark.
//
// Composes 1000 templated messages with retrieved RAG context, repeated
// 100 iterations. Prints p50/p95/mean ms.

import { PromptComposer } from '../../src/contexts/ai/domain/prompt-composer';
import type { RagHit } from '../../src/contexts/ai/domain/ports/rag-store';

const ITERATIONS = 100;
const COMPOSITIONS = 1000;

function makeHits(): RagHit[] {
  return [
    {
      id: 'sha256:hit-1',
      content: 'historical: privileged container in cluster-west',
      metadata: { type: 'incident' },
      score: 0.91,
    },
    {
      id: 'sha256:hit-2',
      content: 'historical: missing network policy in production',
      metadata: { type: 'incident' },
      score: 0.85,
    },
    {
      id: 'sha256:hit-3',
      content: 'historical: rbac wide-open in dev',
      metadata: { type: 'incident' },
      score: 0.7,
    },
  ];
}

describe('PromptComposer — bench (1000 compositions × 100 iterations)', () => {
  it('prints p50/p95/mean composition latency', () => {
    const composer = new PromptComposer();
    const hits = makeHits();
    // Warm-up.
    for (let i = 0; i < COMPOSITIONS; i++) {
      composer.compose({
        templateName: 'security_focused',
        scopePayload: { i },
        retrieved: hits,
      });
    }

    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = process.hrtime.bigint();
      for (let j = 0; j < COMPOSITIONS; j++) {
        composer.compose({
          templateName: 'security_focused',
          scopePayload: { i, j },
          retrieved: hits,
        });
      }
      const t1 = process.hrtime.bigint();
      samples.push(Number(t1 - t0) / 1_000_000);
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.5)] ?? 0;
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
    const mean = samples.reduce((s, v) => s + v, 0) / samples.length;

    console.log(
      `prompt-composer bench: compositions=${COMPOSITIONS} iterations=${ITERATIONS} ` +
        `p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms mean=${mean.toFixed(2)}ms`
    );
    expect(samples.length).toBe(ITERATIONS);
  });
});
