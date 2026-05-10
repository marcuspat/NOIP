// Unit tests for ResourceSnapshot — immutability and counters.

import {
  ResourceSnapshot,
  deriveCounters,
} from '../../../src/contexts/discovery/domain/resource-snapshot';
import {
  FixedClock,
  type ClusterId,
  type ScanId,
} from '../../../src/shared/kernel';
import type { KubernetesResourceRecord } from '../../../src/contexts/discovery/domain/value-objects';

const clusterId = '00000000-0000-7000-8000-000000000aaa' as ClusterId;
const scanId = '00000000-0000-7000-8000-000000000bbb' as ScanId;

function rec(
  apiVersion: string,
  kind: string,
  name: string,
  namespace?: string
): KubernetesResourceRecord {
  return {
    apiVersion,
    kind,
    name,
    labels: {},
    annotations: {},
    spec: null,
    status: null,
    ...(namespace !== undefined ? { namespace } : {}),
  };
}

describe('ResourceSnapshot', () => {
  const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));

  it('counters reflect kind distribution', () => {
    const counters = deriveCounters([
      rec('v1', 'Node', 'n1'),
      rec('v1', 'Node', 'n2'),
      rec('v1', 'Namespace', 'ns'),
      rec('v1', 'Pod', 'p', 'ns'),
      rec('v1', 'Service', 's', 'ns'),
      rec('apps/v1', 'Deployment', 'd', 'ns'),
    ]);
    expect(counters.total).toBe(6);
    expect(counters.nodeCount).toBe(2);
    expect(counters.namespaceCount).toBe(1);
    expect(counters.podCount).toBe(1);
    expect(counters.serviceCount).toBe(1);
    expect(counters.deploymentCount).toBe(1);
  });

  it('create() builds an immutable snapshot with stable hash', () => {
    const records = [rec('v1', 'Pod', 'a', 'ns'), rec('v1', 'Pod', 'b', 'ns')];
    const snap = ResourceSnapshot.create(clusterId, scanId, records, clock);
    expect(snap.id).toBeTruthy();
    expect(snap.takenAt).toBe(clock.nowInstant());
    expect(snap.hash).toMatch(/^[0-9a-f]{64}$/);
    // Mutating the input should NOT change the snapshot.
    records.push(rec('v1', 'Pod', 'c', 'ns'));
    expect(snap.records).toHaveLength(2);
    // Snapshot itself is frozen.
    expect(Object.isFrozen(snap)).toBe(true);
  });

  it('persistence round-trip', () => {
    const records = [rec('v1', 'Pod', 'a', 'ns')];
    const snap = ResourceSnapshot.create(clusterId, scanId, records, clock);
    const reloaded = ResourceSnapshot.fromPersistence(snap.toPersistence());
    expect(reloaded.id).toBe(snap.id);
    expect(reloaded.hash).toBe(snap.hash);
    expect(reloaded.records).toHaveLength(1);
  });

  it('findResource returns the matching record or null', () => {
    const records = [
      rec('v1', 'Pod', 'a', 'ns'),
      rec('v1', 'Service', 'b', 'ns'),
    ];
    const snap = ResourceSnapshot.create(clusterId, scanId, records, clock);
    expect(
      snap.findResource({
        apiVersion: 'v1',
        kind: 'Pod',
        name: 'a',
        namespace: 'ns',
      })
    ).not.toBeNull();
    expect(
      snap.findResource({ apiVersion: 'v1', kind: 'Pod', name: 'missing' })
    ).toBeNull();
  });
});
