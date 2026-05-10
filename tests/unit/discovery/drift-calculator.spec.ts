// Unit tests for DriftCalculator — diff correctness + severity policy.

import { DriftCalculator } from '../../../src/contexts/discovery/domain/drift-calculator';
import { ResourceSnapshot } from '../../../src/contexts/discovery/domain/resource-snapshot';
import {
  FixedClock,
  type ClusterId,
  type ScanId,
} from '../../../src/shared/kernel';
import type { KubernetesResourceRecord } from '../../../src/contexts/discovery/domain/value-objects';

const clusterId = '00000000-0000-7000-8000-00000000abcd' as ClusterId;
const scanA = '00000000-0000-7000-8000-00000000aaaa' as ScanId;
const scanB = '00000000-0000-7000-8000-00000000bbbb' as ScanId;

const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));

function snapshot(records: KubernetesResourceRecord[], scanId: ScanId) {
  return ResourceSnapshot.create(clusterId, scanId, records, clock);
}

function pod(
  name: string,
  spec: Record<string, unknown> = {},
  labels: Record<string, string> = {}
): KubernetesResourceRecord {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    name,
    namespace: 'default',
    labels,
    annotations: {},
    spec,
    status: null,
  };
}

describe('DriftCalculator', () => {
  const calc = new DriftCalculator();

  it('returns null when hashes match', () => {
    const a = snapshot([pod('p')], scanA);
    const b = snapshot([pod('p')], scanB);
    expect(calc.compare(a, b, clock)).toBeNull();
  });

  it('detects a created resource', () => {
    const a = snapshot([pod('p')], scanA);
    const b = snapshot([pod('p'), pod('q')], scanB);
    const drift = calc.compare(a, b, clock);
    expect(drift).not.toBeNull();
    expect(drift!.changes).toHaveLength(1);
    expect(drift!.changes[0]!.kind).toBe('created');
    expect(drift!.changes[0]!.ref.name).toBe('q');
  });

  it('detects a deleted resource', () => {
    const a = snapshot([pod('p'), pod('q')], scanA);
    const b = snapshot([pod('p')], scanB);
    const drift = calc.compare(a, b, clock);
    expect(drift!.changes).toHaveLength(1);
    expect(drift!.changes[0]!.kind).toBe('deleted');
    expect(drift!.changes[0]!.ref.name).toBe('q');
  });

  it('emits a replace patch for primitive changes', () => {
    const a = snapshot([pod('p', { replicas: 3 })], scanA);
    const b = snapshot([pod('p', { replicas: 5 })], scanB);
    const drift = calc.compare(a, b, clock)!;
    expect(drift.changes).toHaveLength(1);
    const ch = drift.changes[0]!;
    expect(ch.kind).toBe('updated');
    expect(ch.patch).toEqual([
      { op: 'replace', path: '/spec/replicas', value: 5 },
    ]);
  });

  it('emits add patch for new keys and remove patch for deleted keys', () => {
    const a = snapshot([pod('p', {}, { app: 'noip' })], scanA);
    const b = snapshot([pod('p', {}, { app: 'noip', tier: 'api' })], scanB);
    const drift = calc.compare(a, b, clock)!;
    expect(drift.changes[0]!.patch).toEqual([
      { op: 'add', path: '/labels/tier', value: 'api' },
    ]);
  });

  it('classifies pod privileged-flag flip as high severity', () => {
    const a = snapshot(
      [
        pod('p', {
          containers: [{ securityContext: { privileged: false } }],
        }),
      ],
      scanA
    );
    const b = snapshot(
      [
        pod('p', {
          containers: [{ securityContext: { privileged: true } }],
        }),
      ],
      scanB
    );
    const drift = calc.compare(a, b, clock)!;
    expect(drift.highestSeverity).toBe('high');
    expect(drift.changes[0]!.severity).toBe('high');
    expect(drift.changes[0]!.rationale).toMatch(/privileged/i);
  });

  it('classifies deployment replicas change as low severity', () => {
    const dep = (replicas: number): KubernetesResourceRecord => ({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      name: 'd',
      namespace: 'ns',
      labels: {},
      annotations: {},
      spec: { replicas },
      status: null,
    });
    const a = snapshot([dep(3)], scanA);
    const b = snapshot([dep(5)], scanB);
    const drift = calc.compare(a, b, clock)!;
    expect(drift.highestSeverity).toBe('low');
  });

  it('classifies label-only changes as low severity', () => {
    const a = snapshot([pod('p', {}, { app: 'noip' })], scanA);
    const b = snapshot([pod('p', {}, { app: 'noip', tier: 'api' })], scanB);
    const drift = calc.compare(a, b, clock)!;
    expect(drift.highestSeverity).toBe('low');
  });

  it('aggregates highest severity across changes', () => {
    const a = snapshot(
      [
        pod('p', {
          containers: [{ securityContext: { privileged: false } }],
        }),
      ],
      scanA
    );
    const b = snapshot(
      [
        pod('p', {
          containers: [{ securityContext: { privileged: true } }],
        }),
        pod('q', {}, { extra: 'label' }),
      ],
      scanB
    );
    const drift = calc.compare(a, b, clock)!;
    // privileged flip is high; created pod q is medium by default.
    expect(drift.highestSeverity).toBe('high');
  });
});
