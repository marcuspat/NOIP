// WidgetDataResolver benchmark.
//
// Evaluates 1k widget resolutions against a synthetic security
// supplier. Two scenarios:
//   1. Cold cache — every widget targets a unique datasource. This
//      measures dispatch + per-call overhead.
//   2. Warm cache — every widget shares the same datasource. This
//      measures the in-flight memoisation hit path.
//
// We print p50/p95/mean to stdout; no assertions because performance
// varies by host.

import { WidgetDataResolver } from '../../src/contexts/dashboard/application/widget-data-resolver';
import { Widget } from '../../src/contexts/dashboard/domain/widget';
import { FixedClock, type ClusterId } from '../../src/shared/kernel';

const WIDGET_COUNT = 1_000;
const ITERATIONS = 20;

function buildWidgets(opts: { shareDatasource: boolean }): Widget[] {
  const widgets: Widget[] = [];
  for (let i = 0; i < WIDGET_COUNT; i++) {
    const ds = opts.shareDatasource
      ? {
          contextRef: 'security' as const,
          query: 'score',
          parameters: { clusterId: 'shared-cluster' as ClusterId },
        }
      : {
          contextRef: 'security' as const,
          query: 'score',
          parameters: { clusterId: `cluster-${i}` as ClusterId },
        };
    widgets.push(
      Widget.create({
        type: 'metric',
        title: `w-${i}`,
        datasource: ds,
        position: { x: 0, y: 0, w: 1, h: 1 },
      })
    );
  }
  return widgets;
}

function buildResolver(): WidgetDataResolver {
  return new WidgetDataResolver({
    clock: new FixedClock(new Date('2026-05-10T00:00:00.000Z')),
    suppliers: {
      security: {
        async getScore() {
          // Light synthetic payload — the bench measures the
          // resolver, not the network.
          return {
            score: 80,
            counts: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
          };
        },
        async listFindings() {
          return [];
        },
      },
    },
  });
}

async function timeRun(widgets: Widget[]): Promise<number> {
  const resolver = buildResolver();
  const t0 = process.hrtime.bigint();
  for (const w of widgets) await resolver.resolve(w);
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1_000_000; // ms
}

function summary(samples: number[]): {
  p50: number;
  p95: number;
  mean: number;
} {
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length * 0.5)] ?? 0;
  const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  return { p50, p95, mean };
}

describe('WidgetDataResolver — bench (1k widget evaluations × 20 iterations)', () => {
  it('cold-cache scenario: unique datasource per widget', async () => {
    const widgets = buildWidgets({ shareDatasource: false });
    // Warm-up.
    await timeRun(widgets);
    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) samples.push(await timeRun(widgets));
    const s = summary(samples);
    console.log(
      `widget-resolver bench (cold): widgets=${WIDGET_COUNT} ` +
        `iterations=${ITERATIONS} p50=${s.p50.toFixed(2)}ms p95=${s.p95.toFixed(2)}ms mean=${s.mean.toFixed(2)}ms`
    );
    expect(samples.length).toBe(ITERATIONS);
  });

  it('warm-cache scenario: shared datasource across all widgets', async () => {
    const widgets = buildWidgets({ shareDatasource: true });
    // Warm-up.
    await timeRun(widgets);
    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) samples.push(await timeRun(widgets));
    const s = summary(samples);
    console.log(
      `widget-resolver bench (warm): widgets=${WIDGET_COUNT} ` +
        `iterations=${ITERATIONS} p50=${s.p50.toFixed(2)}ms p95=${s.p95.toFixed(2)}ms mean=${s.mean.toFixed(2)}ms`
    );
    expect(samples.length).toBe(ITERATIONS);
  });
});
