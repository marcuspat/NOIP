// ComplianceService — generate + sign + immutability.

import { ComplianceService } from '../../../src/contexts/security/application/compliance.service';
import { InMemoryFindingRepository } from '../../../src/contexts/security/infrastructure/persistence/finding.repository';
import { InMemorySecurityPolicyRepository } from '../../../src/contexts/security/infrastructure/persistence/security-policy.repository';
import { InMemorySecurityPolicyVersionRepository } from '../../../src/contexts/security/infrastructure/persistence/security-policy-version.repository';
import { InMemoryComplianceReportRepository } from '../../../src/contexts/security/infrastructure/persistence/compliance-report.repository';
import { Finding } from '../../../src/contexts/security/domain/finding';
import { SecurityPolicy } from '../../../src/contexts/security/domain/security-policy';
import { asPolicyVersion } from '../../../src/contexts/security/domain/value-objects';
import {
  FixedClock,
  InMemoryEventBus,
  newId,
  type ClusterId,
  type DomainEvent,
  type ScanId,
  type UserId,
} from '../../../src/shared/kernel';
import { builtinPolicyId } from '../../../src/contexts/security/infrastructure/scanners/builtin-policy-scanner';
import { ValidationError } from '../../../src/shared/errors';

function harness() {
  const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
  const events: DomainEvent<unknown>[] = [];
  const bus = new InMemoryEventBus({
    warn: () => undefined,
    error: () => undefined,
  });
  bus.subscribe('compliance.*', evt => {
    events.push(evt as DomainEvent<unknown>);
  });
  const findings = new InMemoryFindingRepository();
  const policies = new InMemorySecurityPolicyRepository(
    new InMemorySecurityPolicyVersionRepository()
  );
  const reports = new InMemoryComplianceReportRepository();
  const service = new ComplianceService({
    findings,
    policies,
    reports,
    bus,
    clock,
  });
  return { service, clock, events, findings, policies, reports };
}

describe('ComplianceService.generateReport', () => {
  it('produces a SOC2 report with controls referencing the right findings', async () => {
    const h = harness();
    const cluster = newId<ClusterId>();
    const policy = SecurityPolicy.create(
      {
        id: builtinPolicyId('k8s.privileged'),
        name: 'k8s.privileged',
        type: 'k8s',
        config: {},
      },
      h.clock
    );
    await h.policies.save(policy);
    const finding = Finding.open(
      {
        scanId: newId<ScanId>(),
        scope: { clusterId: cluster },
        resource: { apiVersion: 'v1', kind: 'Pod', name: 'p', namespace: 'd' },
        policyId: policy.id,
        policyVersion: asPolicyVersion(1),
        severity: 'critical',
        description: 'priv',
        evidence: {
          source: 's',
          summary: 's',
          capturedAt: h.clock.nowInstant(),
        },
      },
      h.clock
    );
    await h.findings.save(finding);

    const report = await h.service.generateReport('SOC2', {
      clusterId: cluster,
    });
    expect(report.framework).toBe('SOC2');
    expect(report.status).toBe('draft');
    const cc61 = report.controls.find(c => c.controlId === 'CC6.1');
    expect(cc61).toBeDefined();
    expect(cc61!.status).toBe('fail');
    expect(cc61!.supportingFindings).toContain(finding.id);
    expect(h.events.map(e => e.type)).toEqual(['compliance.report.generated']);
  });

  it('signing makes the report immutable; re-signing throws', async () => {
    const h = harness();
    const cluster = newId<ClusterId>();
    const r = await h.service.generateReport('SOC2', { clusterId: cluster });
    const userId = newId<UserId>();
    await h.service.signReport(r.id, userId);
    const stored = await h.reports.findById(r.id);
    expect(stored!.status).toBe('signed');
    await expect(h.service.signReport(r.id, userId)).rejects.toThrow(
      ValidationError
    );
  });

  it('listFrameworks returns all supported frameworks', () => {
    const h = harness();
    expect(h.service.listFrameworks()).toEqual(
      expect.arrayContaining(['SOC2', 'ISO27001', 'HIPAA', 'PCI-DSS', 'GDPR'])
    );
  });
});
