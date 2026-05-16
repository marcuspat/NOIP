// SecurityService end-to-end (with in-memory repos + stub scanner).

import { SecurityService } from '../../../src/contexts/security/application/security.service';
import { InMemorySecurityScanRepository } from '../../../src/contexts/security/infrastructure/persistence/security-scan.repository';
import { InMemoryFindingRepository } from '../../../src/contexts/security/infrastructure/persistence/finding.repository';
import { InMemorySecurityPolicyRepository } from '../../../src/contexts/security/infrastructure/persistence/security-policy.repository';
import { InMemorySecurityPolicyVersionRepository } from '../../../src/contexts/security/infrastructure/persistence/security-policy-version.repository';
import {
  FixedClock,
  InMemoryEventBus,
  newId,
  type ClusterId,
  type DomainEvent,
  type Instant,
  type SnapshotId,
  type UserId,
} from '../../../src/shared/kernel';
import {
  builtinPolicyId,
  BuiltinPolicyScanner,
} from '../../../src/contexts/security/infrastructure/scanners/builtin-policy-scanner';
import type {
  RawFinding,
  ScannerClient,
} from '../../../src/contexts/security/domain/ports/scanner-client';
import { ValidationError } from '../../../src/shared/errors';
import { securityFindingsTotal } from '../../../src/observability/metrics';

interface Harness {
  service: SecurityService;
  events: DomainEvent<unknown>[];
  findings: InMemoryFindingRepository;
  scans: InMemorySecurityScanRepository;
  policies: InMemorySecurityPolicyRepository;
  cluster: ClusterId;
}

function makeHarness(scanner: ScannerClient): Harness {
  const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
  const events: DomainEvent<unknown>[] = [];
  const bus = new InMemoryEventBus({
    warn: () => undefined,
    error: () => undefined,
  });
  bus.subscribe('security.*', evt => {
    events.push(evt as DomainEvent<unknown>);
  });
  const versions = new InMemorySecurityPolicyVersionRepository();
  const policies = new InMemorySecurityPolicyRepository(versions);
  const findings = new InMemoryFindingRepository();
  const scans = new InMemorySecurityScanRepository();
  const cluster = newId<ClusterId>();
  const service = new SecurityService({
    scans,
    findings,
    policies,
    scanner,
    bus,
    clock,
    snapshotProvider: {
      getLatestSnapshot: async scope => ({
        id: newId<SnapshotId>(),
        clusterId: scope.clusterId,
        hash: 'h1',
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
  return { service, events, findings, scans, policies, cluster };
}

describe('SecurityService.runScan', () => {
  it('emits scan.started, finding.opened…, scan.completed in order', async () => {
    const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
    const h = makeHarness(new BuiltinPolicyScanner(clock));
    const result = await h.service.runScan({ clusterId: h.cluster });
    expect(result.findingsOpened).toBeGreaterThan(0);
    const order = h.events.map(e => e.type);
    expect(order[0]).toBe('security.scan.started');
    expect(order[order.length - 1]).toBe('security.scan.completed');
    expect(order.some(t => t === 'security.finding.opened')).toBe(true);
  });

  it('dedupes by fingerprint on a second run', async () => {
    const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
    const h = makeHarness(new BuiltinPolicyScanner(clock));
    const r1 = await h.service.runScan({ clusterId: h.cluster });
    const r2 = await h.service.runScan({ clusterId: h.cluster });
    expect(r1.findingsOpened).toBeGreaterThan(0);
    expect(r2.findingsOpened).toBe(0);
    expect(r2.findingsReSeen).toBeGreaterThan(0);
    const all = await h.findings.list({ clusterId: h.cluster }, { limit: 100 });
    const fingerprints = all.map(f => f.fingerprint);
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });

  it('auto-resolves findings whose pattern no longer matches', async () => {
    const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
    const policyId = builtinPolicyId('k8s.privileged');
    const fixed: RawFinding[] = [
      {
        policyId,
        resource: { apiVersion: 'v1', kind: 'Pod', name: 'p', namespace: 'd' },
        severity: 'critical',
        description: 'privileged',
        evidence: {
          source: 'static',
          summary: 's',
          capturedAt: clock.nowInstant(),
        },
      },
    ];
    const scanner = {
      calls: 0,
      id: 'twoRun',
      async scan() {
        this.calls++;
        return this.calls === 1 ? fixed : [];
      },
    };
    const h = makeHarness(scanner as ScannerClient);
    await h.service.runScan({ clusterId: h.cluster });
    const before = await h.findings.listOpenByScope({ clusterId: h.cluster });
    expect(before).toHaveLength(1);
    const r = await h.service.runScan({ clusterId: h.cluster });
    expect(r.findingsResolved).toBe(1);
    const after = await h.findings.listOpenByScope({ clusterId: h.cluster });
    expect(after).toHaveLength(0);
  });
});

describe('SecurityService finding lifecycle', () => {
  it('acknowledge → resolve mutates status and emits events', async () => {
    const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
    const h = makeHarness(new BuiltinPolicyScanner(clock));
    await h.service.runScan({ clusterId: h.cluster });
    const open = await h.findings.list(
      { clusterId: h.cluster },
      { status: 'open', limit: 1 }
    );
    expect(open.length).toBeGreaterThanOrEqual(1);
    const id = open[0]!.id;
    const userId = newId<UserId>();
    await h.service.acknowledgeFinding(id, userId, 'noted');
    await h.service.resolveFinding(id, userId);
    const types = h.events.map(e => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'security.finding.acknowledged',
        'security.finding.resolved',
      ])
    );
  });

  it('suppression requires a justification', async () => {
    const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
    const h = makeHarness(new BuiltinPolicyScanner(clock));
    await h.service.runScan({ clusterId: h.cluster });
    const open = await h.findings.list(
      { clusterId: h.cluster },
      { status: 'open', limit: 1 }
    );
    const id = open[0]!.id;
    await expect(
      h.service.suppressFinding(
        id,
        newId<UserId>(),
        '2026-12-31T00:00:00.000Z' as Instant,
        ''
      )
    ).rejects.toThrow(ValidationError);
  });

  it('suppress with valid justification updates status and emits event', async () => {
    const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
    const h = makeHarness(new BuiltinPolicyScanner(clock));
    await h.service.runScan({ clusterId: h.cluster });
    const open = await h.findings.list(
      { clusterId: h.cluster },
      { status: 'open', limit: 1 }
    );
    const id = open[0]!.id;
    const future = '2026-12-31T00:00:00.000Z' as Instant;
    const result = await h.service.suppressFinding(
      id,
      newId<UserId>(),
      future,
      'risk accepted'
    );
    expect(result.status).toBe('suppressed');
    expect(h.events.some(e => e.type === 'security.finding.suppressed')).toBe(
      true
    );
  });
});

describe('SecurityService score & policies', () => {
  it('getScore returns a 0-100 number with breakdown', async () => {
    const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
    const h = makeHarness(new BuiltinPolicyScanner(clock));
    await h.service.runScan({ clusterId: h.cluster });
    const score = await h.service.getScore({ clusterId: h.cluster });
    expect(score.score).toBeGreaterThanOrEqual(0);
    expect(score.score).toBeLessThanOrEqual(100);
    expect(score.scope.clusterId).toBe(h.cluster);
  });

  it('seedBuiltinPolicies is idempotent', async () => {
    const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
    const h = makeHarness(new BuiltinPolicyScanner(clock));
    await h.service.seedBuiltinPolicies();
    await h.service.seedBuiltinPolicies();
    const all = await h.policies.listAll();
    // 10 builtin policies
    expect(all).toHaveLength(10);
  });

  it('fires noip_security_findings_total{severity} when a scan opens new findings (ADR-0023)', async () => {
    const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
    const h = makeHarness(new BuiltinPolicyScanner(clock));
    const beforeCritical = readSeverityCounter('critical');
    const result = await h.service.runScan({ clusterId: h.cluster });
    const afterCritical = readSeverityCounter('critical');
    // The builtin scanner flags the privileged Pod as critical.
    expect(result.findingsOpened).toBeGreaterThan(0);
    expect(afterCritical).toBeGreaterThan(beforeCritical);
  });
});

function readSeverityCounter(severity: string): number {
  const hashMap = (
    securityFindingsTotal as unknown as {
      hashMap: Record<
        string,
        { labels: Record<string, string>; value: number }
      >;
    }
  ).hashMap;
  for (const entry of Object.values(hashMap)) {
    if (entry.labels['severity'] === severity) return entry.value;
  }
  return 0;
}
