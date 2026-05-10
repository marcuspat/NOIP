// ScanOrchestrator — wires discovery.* to security.runScan with debounce.

import { ScanOrchestrator } from '../../../src/contexts/security/application/scan-orchestrator';
import { SecurityService } from '../../../src/contexts/security/application/security.service';
import { InMemorySecurityScanRepository } from '../../../src/contexts/security/infrastructure/persistence/security-scan.repository';
import { InMemoryFindingRepository } from '../../../src/contexts/security/infrastructure/persistence/finding.repository';
import { InMemorySecurityPolicyRepository } from '../../../src/contexts/security/infrastructure/persistence/security-policy.repository';
import { InMemorySecurityPolicyVersionRepository } from '../../../src/contexts/security/infrastructure/persistence/security-policy-version.repository';
import { BuiltinPolicyScanner } from '../../../src/contexts/security/infrastructure/scanners/builtin-policy-scanner';
import {
  FixedClock,
  InMemoryEventBus,
  newId,
  type ClusterId,
  type SnapshotId,
} from '../../../src/shared/kernel';

function harness() {
  const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
  const bus = new InMemoryEventBus({
    warn: () => undefined,
    error: () => undefined,
  });
  const scans = new InMemorySecurityScanRepository();
  const findings = new InMemoryFindingRepository();
  const policies = new InMemorySecurityPolicyRepository(
    new InMemorySecurityPolicyVersionRepository()
  );
  const cluster = newId<ClusterId>();
  const security = new SecurityService({
    scans,
    findings,
    policies,
    scanner: new BuiltinPolicyScanner(clock),
    bus,
    clock,
    snapshotProvider: {
      getLatestSnapshot: async scope => ({
        id: newId<SnapshotId>(),
        clusterId: scope.clusterId,
        hash: 'h-abc',
        takenAt: clock.nowInstant(),
        records: [
          {
            apiVersion: 'v1',
            kind: 'Pod',
            namespace: 'default',
            name: 'p',
            labels: {},
            annotations: {},
            spec: {
              containers: [
                {
                  name: 'c',
                  image: 'nginx:latest',
                  securityContext: { privileged: true },
                },
              ],
            },
            status: {},
          },
        ],
      }),
    },
  });
  const orchestrator = new ScanOrchestrator({
    bus,
    clock,
    security,
    scans,
    findings,
  });
  return { orchestrator, scans, findings, security, cluster, clock };
}

describe('ScanOrchestrator', () => {
  it('runs a scan on discovery.cluster.scanned', async () => {
    const h = harness();
    const result = await h.orchestrator.onClusterScanned({
      clusterId: h.cluster,
      snapshotHash: 'h-abc',
    });
    expect((result as { skipped: boolean }).skipped).toBe(false);
    const scans = await h.scans.listByCluster(h.cluster);
    expect(scans.length).toBeGreaterThanOrEqual(1);
  });

  it('debounces a second event with the same (clusterId, snapshotHash)', async () => {
    const h = harness();
    await h.orchestrator.onClusterScanned({
      clusterId: h.cluster,
      snapshotHash: 'h-abc',
    });
    const second = await h.orchestrator.onClusterScanned({
      clusterId: h.cluster,
      snapshotHash: 'h-abc',
    });
    expect((second as { skipped: boolean; reason?: string }).skipped).toBe(
      true
    );
    expect((second as { skipped: boolean; reason?: string }).reason).toBe(
      'debounced'
    );
    // Still only one scan persisted.
    const scans = await h.scans.listByCluster(h.cluster);
    expect(scans).toHaveLength(1);
  });

  it('promotes HIGH/CRITICAL drift to findings; ignores low/medium', async () => {
    const h = harness();
    const ref = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      name: 'd1',
      namespace: 'default',
    };
    const r = await h.orchestrator.onDriftDetected({
      clusterId: h.cluster,
      highestSeverity: 'high',
      changes: [
        {
          ref,
          severity: 'high',
          rationale: 'replicas went from 3 to 0',
        },
        { ref, severity: 'low', rationale: 'label change' },
      ],
    });
    expect(r.promoted).toBe(1);
    const lo = await h.orchestrator.onDriftDetected({
      clusterId: h.cluster,
      highestSeverity: 'low',
      changes: [{ ref, severity: 'low' }],
    });
    expect(lo.promoted).toBe(0);
  });

  it('install/uninstall wires bus subscriptions', async () => {
    const h = harness();
    const handles = h.orchestrator.install();
    expect(handles).toHaveLength(2);
    h.orchestrator.uninstall();
  });
});
