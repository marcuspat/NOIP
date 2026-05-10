// Unit tests for SnapshotHasher.

import {
  SnapshotHasher,
  canonicalStringify,
} from '../../../src/contexts/discovery/domain/snapshot-hasher';
import type { KubernetesResourceRecord } from '../../../src/contexts/discovery/domain/value-objects';

function rec(
  partial: Partial<KubernetesResourceRecord>
): KubernetesResourceRecord {
  return {
    apiVersion: partial.apiVersion ?? 'v1',
    kind: partial.kind ?? 'Pod',
    name: partial.name ?? 'p',
    labels: partial.labels ?? {},
    annotations: partial.annotations ?? {},
    spec: partial.spec ?? null,
    status: partial.status ?? null,
    ...(partial.namespace !== undefined
      ? { namespace: partial.namespace }
      : {}),
  };
}

describe('SnapshotHasher', () => {
  const hasher = new SnapshotHasher();

  it('produces the same hash for identical inputs', () => {
    const records: KubernetesResourceRecord[] = [
      rec({ name: 'a', kind: 'Pod', namespace: 'default' }),
      rec({ name: 'b', kind: 'Service', namespace: 'default' }),
    ];
    expect(hasher.hash(records)).toBe(hasher.hash(records));
  });

  it('is stable under record reorder', () => {
    const a = rec({ name: 'a', namespace: 'default' });
    const b = rec({ name: 'b', namespace: 'default' });
    expect(hasher.hash([a, b])).toBe(hasher.hash([b, a]));
  });

  it('is stable under field reorder (canonical JSON)', () => {
    const r1 = {
      apiVersion: 'v1',
      kind: 'Pod',
      name: 'p',
      namespace: 'default',
      labels: { app: 'noip', tier: 'api' },
      annotations: {},
      spec: { replicas: 3, image: 'noip/api:1' },
      status: null,
    } satisfies KubernetesResourceRecord;
    const r2 = {
      // Same data, different field order.
      status: null,
      spec: { image: 'noip/api:1', replicas: 3 },
      labels: { tier: 'api', app: 'noip' },
      annotations: {},
      kind: 'Pod',
      apiVersion: 'v1',
      name: 'p',
      namespace: 'default',
    } satisfies KubernetesResourceRecord;
    expect(hasher.hash([r1])).toBe(hasher.hash([r2]));
  });

  it('changes when content changes', () => {
    const a = [rec({ name: 'a', spec: { replicas: 3 } })];
    const b = [rec({ name: 'a', spec: { replicas: 4 } })];
    expect(hasher.hash(a)).not.toBe(hasher.hash(b));
  });

  it('streaming and simple paths agree', () => {
    const records: KubernetesResourceRecord[] = [
      rec({ name: 'a', namespace: 'x' }),
      rec({ name: 'b', namespace: 'x' }),
      rec({ name: 'c' }),
    ];
    const simple = hasher.hash(records, { streamingThreshold: 1_000_000 });
    const streamed = hasher.hash(records, { streamingThreshold: 1 });
    expect(simple).toBe(streamed);
  });

  it('canonicalStringify sorts keys', () => {
    expect(canonicalStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('canonicalStringify treats undefined and NaN as null', () => {
    expect(canonicalStringify(undefined)).toBe('null');
    expect(canonicalStringify(NaN)).toBe('null');
    expect(canonicalStringify(Infinity)).toBe('null');
  });

  it('produces a 64-char lowercase hex digest', () => {
    const h = hasher.hash([rec({ name: 'a' })]);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
