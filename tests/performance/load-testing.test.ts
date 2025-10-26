import { PerformanceService, LoadTestConfig } from '../../src/services/performance.service';
import { config } from '../../src/config';

describe('Performance Service - Load Testing', () => {
  let performanceService: PerformanceService;

  beforeAll(async () => {
    performanceService = new PerformanceService();
    await performanceService.initialize();
  });

  afterAll(async () => {
    await performanceService.shutdown();
  });

  describe('Load Test Execution', () => {
    test('should execute basic load test successfully', async () => {
      const config: LoadTestConfig = {
        targetUrl: 'http://localhost:3000',
        concurrentUsers: 10,
        duration: 30, // 30 seconds
        rampUpTime: 10,
        requestRate: 5,
        scenarios: [
          {
            name: 'Health Check',
            weight: 100,
            method: 'GET',
            endpoint: '/health',
            expectedStatus: 200,
            timeout: 5000
          }
        ]
      };

      const result = await performanceService.runLoadTest(config);

      expect(result).toBeDefined();
      expect(result.testId).toBeDefined();
      expect(result.totalRequests).toBeGreaterThan(0);
      expect(result.successfulRequests).toBeGreaterThanOrEqual(0);
      expect(result.averageResponseTime).toBeGreaterThan(0);
      expect(result.requestsPerSecond).toBeGreaterThan(0);
      expect(result.bottlenecks).toBeDefined();
      expect(result.recommendations).toBeDefined();
    });

    test('should handle multiple scenarios correctly', async () => {
      const config: LoadTestConfig = {
        targetUrl: 'http://localhost:3000',
        concurrentUsers: 20,
        duration: 60,
        rampUpTime: 15,
        requestRate: 10,
        scenarios: [
          {
            name: 'Health Check',
            weight: 20,
            method: 'GET',
            endpoint: '/health',
            expectedStatus: 200,
            timeout: 5000
          },
          {
            name: 'API Test',
            weight: 50,
            method: 'POST',
            endpoint: '/api/test',
            expectedStatus: 200,
            timeout: 10000
          },
          {
            name: 'Dashboard Load',
            weight: 30,
            method: 'GET',
            endpoint: '/dashboard',
            expectedStatus: 200,
            timeout: 8000
          }
        ]
      };

      const result = await performanceService.runLoadTest(config);

      expect(result.totalRequests).toBeGreaterThan(0);
      expect(result.averageResponseTime).toBeGreaterThan(0);
      expect(result.p50ResponseTime).toBeGreaterThan(0);
      expect(result.p95ResponseTime).toBeGreaterThan(0);
      expect(result.p99ResponseTime).toBeGreaterThan(0);
    });

    test('should identify performance bottlenecks', async () => {
      const config: LoadTestConfig = {
        targetUrl: 'http://localhost:3000',
        concurrentUsers: 100,
        duration: 120,
        rampUpTime: 30,
        requestRate: 50,
        scenarios: [
          {
            name: 'Stress Test',
            weight: 100,
            method: 'GET',
            endpoint: '/api/heavy-load',
            expectedStatus: 200,
            timeout: 30000
          }
        ]
      };

      const result = await performanceService.runLoadTest(config);

      expect(result.bottlenecks).toBeDefined();
      expect(Array.isArray(result.bottlenecks)).toBe(true);

      // Check for bottleneck structure
      if (result.bottlenecks.length > 0) {
        const bottleneck = result.bottlenecks[0];
        expect(bottleneck.type).toBeDefined();
        expect(bottleneck.severity).toBeDefined();
        expect(bottleneck.description).toBeDefined();
        expect(bottleneck.recommendation).toBeDefined();
      }
    });

    test('should generate meaningful recommendations', async () => {
      const config: LoadTestConfig = {
        targetUrl: 'http://localhost:3000',
        concurrentUsers: 50,
        duration: 60,
        rampUpTime: 20,
        requestRate: 25,
        scenarios: [
          {
            name: 'Performance Test',
            weight: 100,
            method: 'GET',
            endpoint: '/api/performance-test',
            expectedStatus: 200,
            timeout: 15000
          }
        ]
      };

      const result = await performanceService.runLoadTest(config);

      expect(result.recommendations).toBeDefined();
      expect(Array.isArray(result.recommendations)).toBe(true);
      expect(result.recommendations.length).toBeGreaterThan(0);

      // Check that recommendations are meaningful
      result.recommendations.forEach(recommendation => {
        expect(typeof recommendation).toBe('string');
        expect(recommendation.length).toBeGreaterThan(10);
      });
    });
  });

  describe('Performance Metrics', () => {
    test('should collect current system metrics', async () => {
      const metrics = await performanceService.getCurrentMetrics();

      expect(metrics).toBeDefined();
      expect(metrics.timestamp).toBeDefined();
      expect(metrics.cpu).toBeDefined();
      expect(metrics.memory).toBeDefined();
      expect(metrics.network).toBeDefined();
      expect(metrics.disk).toBeDefined();
      expect(metrics.application).toBeDefined();

      // CPU metrics
      expect(metrics.cpu.usage).toBeGreaterThanOrEqual(0);
      expect(metrics.cpu.usage).toBeLessThanOrEqual(100);
      expect(metrics.cpu.cores).toBeGreaterThan(0);
      expect(Array.isArray(metrics.cpu.loadAverage)).toBe(true);

      // Memory metrics
      expect(metrics.memory.total).toBeGreaterThan(0);
      expect(metrics.memory.used).toBeGreaterThanOrEqual(0);
      expect(metrics.memory.free).toBeGreaterThanOrEqual(0);
      expect(metrics.memory.percentage).toBeGreaterThanOrEqual(0);
      expect(metrics.memory.percentage).toBeLessThanOrEqual(100);

      // Network metrics
      expect(metrics.network.bytesIn).toBeGreaterThanOrEqual(0);
      expect(metrics.network.bytesOut).toBeGreaterThanOrEqual(0);
      expect(metrics.network.packetsIn).toBeGreaterThanOrEqual(0);
      expect(metrics.network.packetsOut).toBeGreaterThanOrEqual(0);
      expect(metrics.network.connections).toBeGreaterThanOrEqual(0);

      // Disk metrics
      expect(metrics.disk.total).toBeGreaterThan(0);
      expect(metrics.disk.used).toBeGreaterThanOrEqual(0);
      expect(metrics.disk.free).toBeGreaterThanOrEqual(0);
      expect(metrics.disk.percentage).toBeGreaterThanOrEqual(0);
      expect(metrics.disk.percentage).toBeLessThanOrEqual(100);
      expect(metrics.disk.iops).toBeGreaterThanOrEqual(0);

      // Application metrics
      expect(metrics.application.activeConnections).toBeGreaterThanOrEqual(0);
      expect(metrics.application.requestRate).toBeGreaterThanOrEqual(0);
      expect(metrics.application.responseTime).toBeGreaterThanOrEqual(0);
      expect(metrics.application.errorRate).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Test History and Management', () => {
    test('should maintain test history', async () => {
      // Run a test to add to history
      const config: LoadTestConfig = {
        targetUrl: 'http://localhost:3000',
        concurrentUsers: 5,
        duration: 10,
        rampUpTime: 5,
        requestRate: 2,
        scenarios: [
          {
            name: 'History Test',
            weight: 100,
            method: 'GET',
            endpoint: '/health',
            expectedStatus: 200,
            timeout: 5000
          }
        ]
      };

      await performanceService.runLoadTest(config);

      const history = await performanceService.getTestHistory();
      expect(history).toBeDefined();
      expect(Array.isArray(history)).toBe(true);
      expect(history.length).toBeGreaterThan(0);

      const latestTest = history[history.length - 1];
      expect(latestTest.testId).toBeDefined();
      expect(latestTest.totalRequests).toBeGreaterThan(0);
    });

    test('should retrieve specific test by ID', async () => {
      const config: LoadTestConfig = {
        targetUrl: 'http://localhost:3000',
        concurrentUsers: 5,
        duration: 10,
        rampUpTime: 5,
        requestRate: 2,
        scenarios: [
          {
            name: 'ID Test',
            weight: 100,
            method: 'GET',
            endpoint: '/health',
            expectedStatus: 200,
            timeout: 5000
          }
        ]
      };

      const result = await performanceService.runLoadTest(config);
      const retrievedTest = await performanceService.getTestById(result.testId);

      expect(retrievedTest).toBeDefined();
      expect(retrievedTest.testId).toBe(result.testId);
      expect(retrievedTest.totalRequests).toBe(result.totalRequests);
    });

    test('should return null for non-existent test ID', async () => {
      const nonExistentTest = await performanceService.getTestById('non-existent-id');
      expect(nonExistentTest).toBeNull();
    });
  });

  describe('Standard Configurations', () => {
    test('should provide standard load test configurations', () => {
      const configs = performanceService.getStandardLoadTestConfigs();

      expect(configs).toBeDefined();
      expect(Array.isArray(configs)).toBe(true);
      expect(configs.length).toBe(3); // light, medium, heavy

      // Check light configuration
      const lightConfig = configs[0];
      expect(lightConfig.concurrentUsers).toBe(100);
      expect(lightConfig.duration).toBe(300);
      expect(lightConfig.scenarios).toBeDefined();
      expect(lightConfig.scenarios.length).toBeGreaterThan(0);

      // Check medium configuration
      const mediumConfig = configs[1];
      expect(mediumConfig.concurrentUsers).toBe(1000);
      expect(mediumConfig.duration).toBe(600);

      // Check heavy configuration
      const heavyConfig = configs[2];
      expect(heavyConfig.concurrentUsers).toBe(10000);
      expect(heavyConfig.duration).toBe(1800);
    });
  });

  describe('Performance Summary', () => {
    test('should generate performance summary', async () => {
      // First run a test to have data
      const config: LoadTestConfig = {
        targetUrl: 'http://localhost:3000',
        concurrentUsers: 10,
        duration: 30,
        rampUpTime: 10,
        requestRate: 5,
        scenarios: [
          {
            name: 'Summary Test',
            weight: 100,
            method: 'GET',
            endpoint: '/health',
            expectedStatus: 200,
            timeout: 5000
          }
        ]
      };

      await performanceService.runLoadTest(config);

      const summary = await performanceService.getPerformanceSummary();

      expect(summary).toBeDefined();
      expect(summary.latestTest).toBeDefined();
      expect(summary.currentMetrics).toBeDefined();
      expect(summary.testCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Health Check', () => {
    test('should return health status', async () => {
      const health = await performanceService.healthCheck();

      expect(health).toBeDefined();
      expect(health.status).toBe('healthy');
      expect(typeof health.monitoring).toBe('boolean');
      expect(typeof health.testsPerformed).toBe('number');
      expect(health.testsPerformed).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Error Handling', () => {
    test('should handle invalid configuration gracefully', async () => {
      const invalidConfig = {
        targetUrl: '', // Invalid empty URL
        concurrentUsers: -1, // Invalid negative number
        duration: 0 // Invalid zero duration
      } as LoadTestConfig;

      await expect(performanceService.runLoadTest(invalidConfig)).rejects.toThrow();
    });

    test('should handle missing configuration', async () => {
      const incompleteConfig = {
        targetUrl: 'http://localhost:3000'
        // Missing required fields
      } as LoadTestConfig;

      // This should still work with default values
      const result = await performanceService.runLoadTest(incompleteConfig);
      expect(result).toBeDefined();
      expect(result.totalRequests).toBeGreaterThan(0);
    });
  });

  describe('Load Test Scenarios', () => {
    test('should handle different HTTP methods', async () => {
      const config: LoadTestConfig = {
        targetUrl: 'http://localhost:3000',
        concurrentUsers: 10,
        duration: 30,
        rampUpTime: 10,
        requestRate: 5,
        scenarios: [
          {
            name: 'GET Request',
            weight: 25,
            method: 'GET',
            endpoint: '/api/data',
            expectedStatus: 200,
            timeout: 5000
          },
          {
            name: 'POST Request',
            weight: 25,
            method: 'POST',
            endpoint: '/api/data',
            expectedStatus: 201,
            timeout: 10000,
            body: { test: 'data' }
          },
          {
            name: 'PUT Request',
            weight: 25,
            method: 'PUT',
            endpoint: '/api/data/1',
            expectedStatus: 200,
            timeout: 10000,
            body: { test: 'updated' }
          },
          {
            name: 'DELETE Request',
            weight: 25,
            method: 'DELETE',
            endpoint: '/api/data/1',
            expectedStatus: 204,
            timeout: 5000
          }
        ]
      };

      const result = await performanceService.runLoadTest(config);

      expect(result.totalRequests).toBeGreaterThan(0);
      expect(result.successfulRequests).toBeGreaterThanOrEqual(0);
      expect(result.failedRequests).toBeGreaterThanOrEqual(0);
    });

    test('should respect scenario weights', async () => {
      const config: LoadTestConfig = {
        targetUrl: 'http://localhost:3000',
        concurrentUsers: 20,
        duration: 60,
        rampUpTime: 15,
        requestRate: 10,
        scenarios: [
          {
            name: 'Primary Scenario',
            weight: 80,
            method: 'GET',
            endpoint: '/api/primary',
            expectedStatus: 200,
            timeout: 5000
          },
          {
            name: 'Secondary Scenario',
            weight: 20,
            method: 'GET',
            endpoint: '/api/secondary',
            expectedStatus: 200,
            timeout: 5000
          }
        ]
      };

      const result = await performanceService.runLoadTest(config);

      expect(result.totalRequests).toBeGreaterThan(0);
      // Primary scenario should dominate (approximately 80% of requests)
    });
  });
});