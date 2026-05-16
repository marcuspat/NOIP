// Unit tests for KubernetesAdapter — pagination, retries, error
// translation. Driven by an in-process fake `RawKubernetesClient`.

import {
  KubernetesAdapter,
  type RawKubernetesClient,
  type RawListPage,
  type KindRef,
  translateRecord,
} from '../../../src/contexts/discovery/infrastructure/kubernetes/kubernetes-adapter';
import { FixedClock, type ClusterId } from '../../../src/shared/kernel';
import { BackpressureError, ProviderError } from '../../../src/shared/errors';
import { kubernetesRequestsTotal } from '../../../src/observability/metrics';

const clusterId = '00000000-0000-7000-8000-000000000123' as ClusterId;

function makeFake(seed: {
  byKind: Record<string, RawListPage[]>;
}): RawKubernetesClient {
  const byKind = new Map(Object.entries(seed.byKind));
  return {
    listKinds: async () => [],
    listKindPage: async ({ kind, continueToken }) => {
      const pages = byKind.get(kind.kind) ?? [];
      // Pick the page whose continueToken matches the request, or
      // page 0 if no token was sent.
      const idx = continueToken
        ? Math.max(
            0,
            pages.findIndex(p => p.continueToken === continueToken) + 1
          )
        : 0;
      return pages[idx] ?? { items: [] };
    },
    getClusterInfo: async () => ({
      name: 'test',
      endpoint: 'https://api.test',
      version: 'v1.28',
    }),
    listNamespaces: async () => ['default'],
    listNodeInfo: async () => [],
  };
}

describe('KubernetesAdapter', () => {
  const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));

  it('paginates via continue tokens', async () => {
    const fake = makeFake({
      byKind: {
        Pod: [
          {
            items: [
              {
                apiVersion: 'v1',
                kind: 'Pod',
                metadata: { name: 'p1', namespace: 'default' },
              },
            ],
            continueToken: 'page2',
          },
          {
            items: [
              {
                apiVersion: 'v1',
                kind: 'Pod',
                metadata: { name: 'p2', namespace: 'default' },
              },
            ],
          },
        ],
      },
    });
    const adapter = new KubernetesAdapter({
      raw: fake,
      clock,
      defaultKinds: [{ apiVersion: 'v1', kind: 'Pod', namespaced: true }],
      retryDeps: { sleep: async () => undefined },
    });
    const out = [];
    for await (const r of adapter.listResources({ clusterId })) {
      out.push(r);
    }
    expect(out).toHaveLength(2);
    expect(out.map(r => r.name).sort()).toEqual(['p1', 'p2']);
  });

  it('retries 3 times on retryable errors then surfaces BackpressureError', async () => {
    let calls = 0;
    const fake: RawKubernetesClient = {
      ...makeFake({ byKind: {} }),
      listKindPage: async () => {
        calls++;
        const err = new Error('rate limited') as Error & { statusCode: number };
        err.statusCode = 429;
        throw err;
      },
    };
    const adapter = new KubernetesAdapter({
      raw: fake,
      clock,
      defaultKinds: [{ apiVersion: 'v1', kind: 'Pod', namespaced: true }],
      retryDeps: { sleep: async () => undefined, random: () => 0 },
    });
    let caught: unknown;
    try {
      for await (const _r of adapter.listResources({ clusterId })) {
        // shouldn't reach
      }
    } catch (err) {
      caught = err;
    }
    expect(calls).toBe(3);
    expect(caught).toBeInstanceOf(BackpressureError);
  });

  it('translates non-retryable errors directly to ProviderError', async () => {
    const fake: RawKubernetesClient = {
      ...makeFake({ byKind: {} }),
      listKindPage: async () => {
        const err = new Error('forbidden') as Error & { statusCode: number };
        err.statusCode = 403;
        throw err;
      },
    };
    const adapter = new KubernetesAdapter({
      raw: fake,
      clock,
      defaultKinds: [{ apiVersion: 'v1', kind: 'Pod', namespaced: true }],
      retryDeps: { sleep: async () => undefined },
    });
    let caught: unknown;
    try {
      for await (const _r of adapter.listResources({ clusterId })) {
        // unreachable
      }
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderError);
  });

  it('translates kube objects to domain records (drops volatile annotations)', () => {
    const kind: KindRef = { apiVersion: 'v1', kind: 'Pod', namespaced: true };
    const out = translateRecord(
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: {
          name: 'p',
          namespace: 'default',
          labels: { app: 'noip' },
          annotations: {
            keep: 'me',
            'kubectl.kubernetes.io/last-applied-configuration': '...',
            'deployment.kubernetes.io/revision': '7',
          },
          resourceVersion: '12345',
          uid: 'abc',
        },
        spec: { x: 1 },
        status: { phase: 'Running' },
      },
      kind
    );
    expect(out).not.toBeNull();
    expect(out!.name).toBe('p');
    expect(out!.namespace).toBe('default');
    expect(out!.annotations).toEqual({ keep: 'me' });
    // resourceVersion and uid are not part of the domain shape.
    expect(out as unknown as { resourceVersion?: unknown }).not.toHaveProperty(
      'resourceVersion'
    );
  });

  it('drops nameless records', () => {
    const kind: KindRef = { apiVersion: 'v1', kind: 'Pod', namespaced: true };
    const out = translateRecord({ metadata: {} }, kind);
    expect(out).toBeNull();
  });

  it('respects scope.kinds whitelist', async () => {
    let podCalls = 0;
    let svcCalls = 0;
    const fake: RawKubernetesClient = {
      ...makeFake({ byKind: {} }),
      listKindPage: async ({ kind }) => {
        if (kind.kind === 'Pod') podCalls++;
        if (kind.kind === 'Service') svcCalls++;
        return { items: [] };
      },
    };
    const adapter = new KubernetesAdapter({
      raw: fake,
      clock,
      defaultKinds: [
        { apiVersion: 'v1', kind: 'Pod', namespaced: true },
        { apiVersion: 'v1', kind: 'Service', namespaced: true },
      ],
      retryDeps: { sleep: async () => undefined },
    });
    for await (const _r of adapter.listResources({
      clusterId,
      kinds: ['Pod'],
    })) {
      // unreachable
    }
    expect(podCalls).toBe(1);
    expect(svcCalls).toBe(0);
  });

  it('fires noip_kubernetes_requests_total{verb=list,status=success} on a successful list', async () => {
    const before = readCounterValue(kubernetesRequestsTotal, {
      verb: 'list',
      status: 'success',
    });
    const adapter = new KubernetesAdapter({
      raw: makeFake({ byKind: {} }),
      clock,
      defaultKinds: [{ apiVersion: 'v1', kind: 'Pod', namespaced: true }],
      retryDeps: { sleep: async () => undefined },
    });
    for await (const _r of adapter.listResources({ clusterId })) {
      // empty
    }
    const after = readCounterValue(kubernetesRequestsTotal, {
      verb: 'list',
      status: 'success',
    });
    expect(after - before).toBe(1);
  });
});

function readCounterValue(
  metric: unknown,
  labels: Record<string, string>
): number {
  const hashMap = (
    metric as {
      hashMap: Record<
        string,
        { labels: Record<string, string>; value: number }
      >;
    }
  ).hashMap;
  for (const entry of Object.values(hashMap)) {
    let match = true;
    for (const [k, v] of Object.entries(labels)) {
      if (entry.labels[k] !== v) {
        match = false;
        break;
      }
    }
    if (match) return entry.value;
  }
  return 0;
}
