// Legacy back-compat tests for SecurityService.
//
// The SecurityService now lives in `src/contexts/security/api`. The
// shape of the legacy methods (`scanResources`, `scanPodSecurity`,
// `scanNetworkPolicies`, `getSecurityScore`,
// `getSecurityRecommendations`, `healthCheck`, `initialize`,
// `stop`) is preserved so the historic test surface keeps passing.

import { composeSecurity } from '../../../src/contexts/security/api';
import {
  FixedClock,
  InMemoryEventBus,
  newId,
  type ClusterId,
} from '../../../src/shared/kernel';
import {
  InMemorySecurityScanRepository,
  InMemoryFindingRepository,
  InMemorySecurityPolicyRepository,
  InMemorySecurityPolicyVersionRepository,
  InMemoryComplianceReportRepository,
  Finding,
} from './_security-test-helpers';

describe('SecurityService (legacy back-compat)', () => {
  const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
  const bus = new InMemoryEventBus({
    warn: () => undefined,
    error: () => undefined,
  });
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  const findings = new InMemoryFindingRepository();
  const composed = composeSecurity({
    bus,
    clock,
    logger,
    repos: {
      scans: new InMemorySecurityScanRepository(),
      findings,
      policies: new InMemorySecurityPolicyRepository(
        new InMemorySecurityPolicyVersionRepository()
      ),
      reports: new InMemoryComplianceReportRepository(),
    },
  });
  const service = composed.service;

  // Seed a couple of legacy-scope findings so the legacy
  // pod/network helpers have something to project. We persist them
  // directly via the in-memory repository so we don't run a scan
  // (the scanner contract is exercised in dedicated tests).
  beforeAll(async () => {
    const legacy: ClusterId = 'legacy' as ClusterId;
    const policyId = newId() as never;
    const evidence = {
      source: 'legacy-test',
      summary: 'fixture',
      capturedAt: clock.nowInstant(),
    };
    const f1 = Finding.open(
      {
        scanId: newId() as never,
        scope: { clusterId: legacy },
        resource: {
          apiVersion: 'v1',
          kind: 'Pod',
          name: 'p1',
          namespace: 'default',
        },
        policyId,
        policyVersion: 1 as never,
        severity: 'high',
        description: 'legacy pod',
        evidence,
      },
      clock
    );
    f1.drainEvents();
    const f2 = Finding.open(
      {
        scanId: newId() as never,
        scope: { clusterId: legacy },
        resource: {
          apiVersion: 'networking.k8s.io/v1',
          kind: 'Pod',
          name: 'p2',
          namespace: 'default',
        },
        policyId,
        policyVersion: 1 as never,
        severity: 'medium',
        description: 'legacy network',
        evidence,
      },
      clock
    );
    f2.drainEvents();
    await findings.saveMany([f1, f2]);
  });

  describe('scanResources', () => {
    it('returns security scan results', async () => {
      const mockResources = [
        {
          apiVersion: 'v1',
          kind: 'Pod',
          metadata: { name: 'test-pod' },
          spec: {
            containers: [
              {
                name: 'c',
                image: 'nginx:latest',
                securityContext: { privileged: true },
              },
            ],
          },
        },
      ];
      const results = await service.scanResources(mockResources);
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
      results.forEach(result => {
        expect(result.scanId).toBeDefined();
        expect(result.timestamp).toBeInstanceOf(Date);
        expect(result.severity).toMatch(/^(low|medium|high|critical)$/);
        expect(result.category).toBeDefined();
        expect(result.description).toBeDefined();
        expect(Array.isArray(result.affectedResources)).toBe(true);
      });
    });

    it('handles empty resources array', async () => {
      const results = await service.scanResources([]);
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('scanPodSecurity', () => {
    it('returns pod security scan results', async () => {
      const results = await service.scanPodSecurity();
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('scanNetworkPolicies', () => {
    it('returns network policy scan results', async () => {
      const results = await service.scanNetworkPolicies();
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('getSecurityScore', () => {
    it('returns a numeric security score', async () => {
      const score = await service.getSecurityScore();
      expect(typeof score).toBe('number');
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });
  });

  describe('getSecurityRecommendations', () => {
    it('returns array of security recommendations', async () => {
      const recommendations = await service.getSecurityRecommendations();
      expect(Array.isArray(recommendations)).toBe(true);
    });
  });

  describe('healthCheck', () => {
    it('returns health status with score', async () => {
      const health = await service.healthCheck();
      expect(health).toBeDefined();
      expect(health.status).toBe('healthy');
      expect(health.lastScan).toBeInstanceOf(Date);
      expect(typeof health.score).toBe('number');
      expect(health.score).toBeGreaterThanOrEqual(0);
      expect(health.score).toBeLessThanOrEqual(100);
    });
  });

  describe('initialization', () => {
    it('initializes without errors', async () => {
      await expect(service.initialize()).resolves.not.toThrow();
    });
  });
});
