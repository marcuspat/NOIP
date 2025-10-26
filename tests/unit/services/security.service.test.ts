import { SecurityService } from '../../../src/services/security.service';
import { SecurityScanResult } from '../../../src/types';

describe('SecurityService', () => {
  let service: SecurityService;

  beforeEach(() => {
    service = new SecurityService();
  });

  afterEach(async () => {
    await service.stop();
  });

  describe('scanResources', () => {
    it('should return security scan results', async () => {
      const mockResources = [
        { kind: 'Pod', metadata: { name: 'test-pod' } },
        { kind: 'Service', metadata: { name: 'test-service' } },
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

    it('should handle empty resources array', async () => {
      const results = await service.scanResources([]);
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('scanPodSecurity', () => {
    it('should return pod security scan results', async () => {
      const results = await service.scanPodSecurity();

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);

      results.forEach(result => {
        expect(result.category).toBe('Pod Security');
        expect(['low', 'medium', 'high', 'critical']).toContain(result.severity);
      });
    });
  });

  describe('scanNetworkPolicies', () => {
    it('should return network policy scan results', async () => {
      const results = await service.scanNetworkPolicies();

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);

      results.forEach(result => {
        expect(result.category).toBe('Network Security');
      });
    });
  });

  describe('scanSecrets', () => {
    it('should return secrets scan results', async () => {
      const results = await service.scanSecrets();

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);

      results.forEach(result => {
        expect(result.category).toBe('Secret Management');
      });
    });
  });

  describe('getSecurityScore', () => {
    it('should return a numeric security score', async () => {
      const score = await service.getSecurityScore();

      expect(typeof score).toBe('number');
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });
  });

  describe('getSecurityRecommendations', () => {
    it('should return array of security recommendations', async () => {
      const recommendations = await service.getSecurityRecommendations();

      expect(Array.isArray(recommendations)).toBe(true);
      expect(recommendations.length).toBeGreaterThan(0);

      recommendations.forEach(rec => {
        expect(typeof rec).toBe('string');
        expect(rec.length).toBeGreaterThan(0);
      });
    });
  });

  describe('healthCheck', () => {
    it('should return health status with score', async () => {
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
    it('should initialize without errors', async () => {
      await expect(service.initialize()).resolves.not.toThrow();
    });
  });
});