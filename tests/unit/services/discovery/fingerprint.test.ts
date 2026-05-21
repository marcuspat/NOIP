import {
  canonicalizeResource,
  fingerprintResource,
  computeDrift,
} from '../../../../src/services/discovery/fingerprint';
import { KubernetesResource } from '../../../../src/types';
import { ResourceRecord } from '../../../../src/models/snapshot.model';

const mkResource = (overrides: Partial<KubernetesResource> = {}): KubernetesResource => ({
  apiVersion: 'v1',
  kind: 'ConfigMap',
  metadata: { name: 'my-cm', namespace: 'default' },
  spec: { data: { key: 'value' } },
  ...overrides,
});

const mkRecord = (overrides: Partial<ResourceRecord> = {}): ResourceRecord => ({
  apiVersion: 'v1',
  kind: 'ConfigMap',
  namespace: 'default',
  name: 'my-cm',
  fingerprint: 'aaa',
  rawSpec: {},
  ...overrides,
});

describe('canonicalizeResource', () => {
  it('produces deterministic JSON', () => {
    const r = mkResource();
    expect(canonicalizeResource(r)).toBe(canonicalizeResource(r));
  });

  it('excludes volatile metadata keys (resourceVersion, uid, managedFields)', () => {
    const r = mkResource({
      metadata: {
        name: 'my-cm',
        namespace: 'default',
        resourceVersion: '12345',
        uid: 'abc-uuid',
      } as KubernetesResource['metadata'] & Record<string, unknown>,
    });
    const canonical = canonicalizeResource(r);
    expect(canonical).not.toContain('resourceVersion');
    expect(canonical).not.toContain('uid');
    expect(canonical).not.toContain('12345');
  });

  it('includes stable metadata keys (labels, annotations)', () => {
    const r = mkResource({
      metadata: { name: 'my-cm', namespace: 'default', labels: { app: 'noip' } },
    });
    expect(canonicalizeResource(r)).toContain('noip');
  });

  it('same spec → same canonical', () => {
    const a = mkResource({ spec: { x: 1, y: 2 } });
    const b = mkResource({ spec: { x: 1, y: 2 } });
    expect(canonicalizeResource(a)).toBe(canonicalizeResource(b));
  });

  it('different spec → different canonical', () => {
    const a = mkResource({ spec: { x: 1 } });
    const b = mkResource({ spec: { x: 2 } });
    expect(canonicalizeResource(a)).not.toBe(canonicalizeResource(b));
  });
});

describe('fingerprintResource', () => {
  it('returns a 64-char hex string (SHA-256)', () => {
    const fp = fingerprintResource(mkResource());
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is stable across calls', () => {
    const r = mkResource();
    expect(fingerprintResource(r)).toBe(fingerprintResource(r));
  });

  it('differs when spec changes', () => {
    const a = fingerprintResource(mkResource({ spec: { x: 1 } }));
    const b = fingerprintResource(mkResource({ spec: { x: 2 } }));
    expect(a).not.toBe(b);
  });

  it('is unaffected by volatile resourceVersion', () => {
    const base = mkResource({ metadata: { name: 'cm', namespace: 'ns' } });
    const withRV = mkResource({
      metadata: { name: 'cm', namespace: 'ns', resourceVersion: '999' } as any,
    });
    expect(fingerprintResource(base)).toBe(fingerprintResource(withRV));
  });
});

describe('computeDrift', () => {
  it('returns empty array when snapshots are identical', () => {
    const records = [mkRecord({ fingerprint: 'fp1' }), mkRecord({ name: 'cm2', fingerprint: 'fp2' })];
    expect(computeDrift(records, records)).toHaveLength(0);
  });

  it('detects added resources', () => {
    const baseline: ResourceRecord[] = [];
    const current = [mkRecord({ name: 'new-cm', fingerprint: 'fp-new' })];
    const drift = computeDrift(baseline, current);
    expect(drift).toHaveLength(1);
    expect(drift[0].changeType).toBe('added');
    expect(drift[0].resourceName).toBe('new-cm');
  });

  it('detects removed resources', () => {
    const baseline = [mkRecord({ name: 'old-cm', fingerprint: 'fp-old' })];
    const current: ResourceRecord[] = [];
    const drift = computeDrift(baseline, current);
    expect(drift).toHaveLength(1);
    expect(drift[0].changeType).toBe('removed');
    expect(drift[0].resourceName).toBe('old-cm');
  });

  it('detects modified resources (fingerprint change)', () => {
    const baseline = [mkRecord({ fingerprint: 'fp-v1' })];
    const current = [mkRecord({ fingerprint: 'fp-v2' })];
    const drift = computeDrift(baseline, current);
    expect(drift).toHaveLength(1);
    expect(drift[0].changeType).toBe('modified');
    expect(drift[0].previousFingerprint).toBe('fp-v1');
    expect(drift[0].currentFingerprint).toBe('fp-v2');
  });

  it('assigns critical severity to removed RBAC resources', () => {
    const baseline = [mkRecord({ kind: 'ClusterRoleBinding', fingerprint: 'fp1' })];
    const drift = computeDrift(baseline, []);
    expect(drift[0].severity).toBe('critical');
  });

  it('assigns high severity to removed ClusterRole', () => {
    const baseline = [mkRecord({ kind: 'ClusterRole', fingerprint: 'fp1' })];
    const drift = computeDrift(baseline, []);
    expect(drift[0].severity).toBe('critical');
  });

  it('handles multiple changes simultaneously', () => {
    const baseline = [
      mkRecord({ name: 'cm-keep', fingerprint: 'same' }),
      mkRecord({ name: 'cm-mod', fingerprint: 'old' }),
      mkRecord({ name: 'cm-del', fingerprint: 'del' }),
    ];
    const current = [
      mkRecord({ name: 'cm-keep', fingerprint: 'same' }),
      mkRecord({ name: 'cm-mod', fingerprint: 'new' }),
      mkRecord({ name: 'cm-add', fingerprint: 'add' }),
    ];
    const drift = computeDrift(baseline, current);
    expect(drift).toHaveLength(3); // modified + removed + added
    const types = drift.map(d => d.changeType).sort();
    expect(types).toEqual(['added', 'modified', 'removed']);
  });
});
