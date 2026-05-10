// ComplianceMapper — SOC2 + ISO27001 mapping shape.

import { ComplianceMapper } from '../../../src/contexts/security/domain/compliance-mapper';
import { Finding } from '../../../src/contexts/security/domain/finding';
import { asPolicyVersion } from '../../../src/contexts/security/domain/value-objects';
import {
  FixedClock,
  newId,
  type ClusterId,
  type PolicyId,
  type ScanId,
} from '../../../src/shared/kernel';
import { builtinPolicyId } from '../../../src/contexts/security/infrastructure/scanners/builtin-policy-scanner';

describe('ComplianceMapper', () => {
  const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
  const mapper = new ComplianceMapper();

  it('lists every framework it has at least one control for', () => {
    const fws = mapper.listFrameworks();
    expect(fws).toEqual(
      expect.arrayContaining(['SOC2', 'ISO27001', 'HIPAA', 'PCI-DSS', 'GDPR'])
    );
  });

  it('SOC2 assessment with no findings returns all-pass / na', () => {
    const cluster = newId<ClusterId>();
    const policies = [
      { id: builtinPolicyId('k8s.privileged'), name: 'k8s.privileged' },
      { id: builtinPolicyId('k8s.runAsRoot'), name: 'k8s.runAsRoot' },
    ];
    const { controls, overall } = mapper.assess({
      framework: 'SOC2',
      scope: { clusterId: cluster },
      findings: [],
      policies,
    });
    expect(controls.length).toBeGreaterThan(0);
    for (const c of controls) {
      expect(c.framework).toBe('SOC2');
      expect(['pass', 'na']).toContain(c.status);
    }
    expect(overall.score).toBeGreaterThanOrEqual(0);
    expect(overall.score).toBeLessThanOrEqual(100);
  });

  it('ISO27001 fail when an open finding maps to A.5.15', () => {
    const cluster = newId<ClusterId>();
    const privId: PolicyId = builtinPolicyId('k8s.privileged');
    const policies = [{ id: privId, name: 'k8s.privileged' }];
    const finding = Finding.open(
      {
        scanId: newId<ScanId>(),
        scope: { clusterId: cluster },
        resource: { apiVersion: 'v1', kind: 'Pod', name: 'p', namespace: 'd' },
        policyId: privId,
        policyVersion: asPolicyVersion(1),
        severity: 'critical',
        description: 'priv',
        evidence: { source: 'x', summary: 's', capturedAt: clock.nowInstant() },
      },
      clock
    );
    const { controls } = mapper.assess({
      framework: 'ISO27001',
      scope: { clusterId: cluster },
      findings: [finding],
      policies,
    });
    const a515 = controls.find(c => c.controlId === 'A.5.15');
    expect(a515).toBeDefined();
    expect(a515!.status).toBe('fail');
    expect(a515!.supportingFindings).toContain(finding.id);
  });

  it('control reports na with rationale when no policies map', () => {
    const cluster = newId<ClusterId>();
    const { controls } = mapper.assess({
      framework: 'HIPAA',
      scope: { clusterId: cluster },
      findings: [],
      policies: [],
    });
    expect(controls).toHaveLength(1);
    expect(controls[0]!.status).toBe('na');
    expect(controls[0]!.rationale).toContain('Phase 5');
  });
});
