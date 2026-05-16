// WidgetDataResolver unit tests — verifies per-cycle memoisation,
// dispatch routing, and the NotImplementedError fallback.

import { WidgetDataResolver } from '../../../src/contexts/dashboard/application/widget-data-resolver';
import { Widget } from '../../../src/contexts/dashboard/domain/widget';
import type { WidgetSpec } from '../../../src/contexts/dashboard/domain/widget';
import { NotImplementedError } from '../../../src/contexts/dashboard/domain/errors';
import { FixedClock, type ClusterId } from '../../../src/shared/kernel';
import { ValidationError } from '../../../src/shared/errors';

const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));

function widget(
  spec: Partial<WidgetSpec> & Pick<WidgetSpec, 'datasource'>
): Widget {
  return Widget.create({
    type: 'metric',
    title: 't',
    config: {},
    position: { x: 0, y: 0, w: 1, h: 1 },
    ...spec,
  });
}

describe('WidgetDataResolver — dispatch', () => {
  it('routes discovery widgets through the discovery supplier', async () => {
    const calls: number[] = [];
    const resolver = new WidgetDataResolver({
      clock,
      suppliers: {
        discovery: {
          async getLatestSnapshot({ clusterId }) {
            calls.push(1);
            return {
              id: 'snap-1',
              hash: 'h',
              takenAt: clock.nowInstant(),
              records: [
                {
                  apiVersion: 'v1',
                  kind: 'Pod',
                  name: 'p',
                  namespace: 'd',
                },
              ],
            };
          },
        },
      },
    });
    const w = widget({
      datasource: {
        contextRef: 'discovery',
        query: 'latestSnapshot',
        parameters: { clusterId: 'c1' as ClusterId as unknown as string },
      },
    });
    const data = await resolver.resolve(w);
    expect(data.widgetType).toBe('metric');
    expect((data.payload as { snapshotId: string }).snapshotId).toBe('snap-1');
    expect(calls).toHaveLength(1);
  });

  it('routes security/score widgets through the security supplier', async () => {
    const resolver = new WidgetDataResolver({
      clock,
      suppliers: {
        security: {
          async getScore() {
            return {
              score: 80,
              counts: { total: 10, critical: 0, high: 1, medium: 4, low: 5 },
            };
          },
          async listFindings() {
            return [];
          },
        },
      },
    });
    const w = widget({
      datasource: {
        contextRef: 'security',
        query: 'score',
        parameters: { clusterId: 'c1' },
      },
    });
    const data = await resolver.resolve(w);
    expect((data.payload as { score: number }).score).toBe(80);
  });

  it('routes security/findings widgets and respects the limit parameter', async () => {
    const observed: { limit?: number }[] = [];
    const resolver = new WidgetDataResolver({
      clock,
      suppliers: {
        security: {
          async getScore() {
            throw new Error('not called');
          },
          async listFindings(_scope, filter) {
            observed.push(filter ?? {});
            return [
              {
                toPersistence(): Record<string, unknown> {
                  return { id: 'f1', severity: 'high' };
                },
              },
            ];
          },
        },
      },
    });
    const w = widget({
      datasource: {
        contextRef: 'security',
        query: 'findings',
        parameters: { clusterId: 'c1', limit: 25 },
      },
    });
    const data = await resolver.resolve(w);
    expect(observed[0]).toMatchObject({ limit: 25 });
    expect((data.payload as { count: number }).count).toBe(1);
  });

  it('memoises identical datasources within a single resolver cycle', async () => {
    let calls = 0;
    const resolver = new WidgetDataResolver({
      clock,
      suppliers: {
        security: {
          async getScore() {
            calls += 1;
            return {
              score: 50,
              counts: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
            };
          },
          async listFindings() {
            return [];
          },
        },
      },
    });
    const ds = {
      contextRef: 'security' as const,
      query: 'score',
      parameters: { clusterId: 'c1' },
    };
    const w1 = widget({ datasource: ds });
    const w2 = widget({ datasource: { ...ds } });
    await Promise.all([resolver.resolve(w1), resolver.resolve(w2)]);
    expect(calls).toBe(1);
    expect(resolver.cacheSize()).toBe(1);
  });

  it('memoisation key ignores parameter ordering', async () => {
    let calls = 0;
    const resolver = new WidgetDataResolver({
      clock,
      suppliers: {
        ai: {
          async getLatestInsights() {
            calls += 1;
            return [{ id: 'i', summary: 's' }];
          },
        },
      },
    });
    const a = widget({
      datasource: {
        contextRef: 'ai',
        query: 'insights',
        parameters: { clusterId: 'c1', type: 'cost' },
      },
    });
    const b = widget({
      datasource: {
        contextRef: 'ai',
        query: 'insights',
        parameters: { type: 'cost', clusterId: 'c1' },
      },
    });
    await resolver.resolve(a);
    await resolver.resolve(b);
    expect(calls).toBe(1);
  });

  it('throws NotImplementedError when the performance supplier is hit', async () => {
    const resolver = new WidgetDataResolver({ clock, suppliers: {} });
    const w = widget({
      datasource: {
        contextRef: 'performance',
        query: 'sloSummary',
        parameters: { clusterId: 'c1' },
      },
    });
    await expect(resolver.resolve(w)).rejects.toThrow(NotImplementedError);
  });

  it('throws NotImplementedError when supplier is not wired', async () => {
    const resolver = new WidgetDataResolver({ clock, suppliers: {} });
    const w = widget({
      datasource: {
        contextRef: 'security',
        query: 'score',
        parameters: { clusterId: 'c1' },
      },
    });
    await expect(resolver.resolve(w)).rejects.toThrow(NotImplementedError);
  });

  it('throws ValidationError on missing clusterId', async () => {
    const resolver = new WidgetDataResolver({
      clock,
      suppliers: {
        security: {
          async getScore() {
            throw new Error('not called');
          },
          async listFindings() {
            return [];
          },
        },
      },
    });
    const w = widget({
      datasource: { contextRef: 'security', query: 'score' },
    });
    await expect(resolver.resolve(w)).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError on an unsupported query', async () => {
    const resolver = new WidgetDataResolver({
      clock,
      suppliers: {
        security: {
          async getScore() {
            throw new Error('not called');
          },
          async listFindings() {
            return [];
          },
        },
      },
    });
    const w = widget({
      datasource: {
        contextRef: 'security',
        query: 'unknown',
        parameters: { clusterId: 'c1' },
      },
    });
    await expect(resolver.resolve(w)).rejects.toThrow(ValidationError);
  });

  it('compliance/frameworks returns the list', async () => {
    const resolver = new WidgetDataResolver({
      clock,
      suppliers: {
        compliance: {
          listFrameworks() {
            return ['cis', 'pci'];
          },
          async generateComplianceReport(fw: string) {
            return { framework: fw, overall: 90 };
          },
        },
      },
    });
    const w = widget({
      datasource: { contextRef: 'compliance', query: 'frameworks' },
    });
    const data = await resolver.resolve(w);
    expect((data.payload as { frameworks: string[] }).frameworks).toEqual([
      'cis',
      'pci',
    ]);
  });

  it('compliance/report requires both framework + clusterId', async () => {
    const resolver = new WidgetDataResolver({
      clock,
      suppliers: {
        compliance: {
          listFrameworks() {
            return ['cis'];
          },
          async generateComplianceReport(fw: string) {
            return { framework: fw, overall: 75 };
          },
        },
      },
    });
    const w1 = widget({
      datasource: { contextRef: 'compliance', query: 'report' },
    });
    await expect(resolver.resolve(w1)).rejects.toThrow(ValidationError);

    const w2 = widget({
      datasource: {
        contextRef: 'compliance',
        query: 'report',
        parameters: { clusterId: 'c1', framework: 'cis' },
      },
    });
    const data = await resolver.resolve(w2);
    expect((data.payload as { overall: number }).overall).toBe(75);
  });
});
