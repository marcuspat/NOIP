import { BaseService } from './base.service';
import { config } from '../config';

export interface PerformanceMetrics {
  timestamp: Date;
  cpu: {
    usage: number;
    cores: number;
    loadAverage: number[];
  };
  memory: {
    total: number;
    used: number;
    free: number;
    percentage: number;
  };
  network: {
    bytesIn: number;
    bytesOut: number;
    packetsIn: number;
    packetsOut: number;
    connections: number;
  };
  disk: {
    total: number;
    used: number;
    free: number;
    percentage: number;
    iops: number;
  };
  application: {
    activeConnections: number;
    requestRate: number;
    responseTime: number;
    errorRate: number;
  };
}

export interface LoadTestConfig {
  targetUrl: string;
  concurrentUsers: number;
  duration: number; // seconds
  rampUpTime: number; // seconds
  requestRate: number; // requests per second
  scenarios: LoadTestScenario[];
}

export interface LoadTestScenario {
  name: string;
  weight: number; // percentage of total requests
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  endpoint: string;
  headers?: Record<string, string>;
  body?: any;
  expectedStatus: number;
  timeout: number;
}

export interface LoadTestResult {
  testId: string;
  config: LoadTestConfig;
  startTime: Date;
  endTime: Date;
  duration: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageResponseTime: number;
  minResponseTime: number;
  maxResponseTime: number;
  p50ResponseTime: number;
  p90ResponseTime: number;
  p95ResponseTime: number;
  p99ResponseTime: number;
  requestsPerSecond: number;
  throughput: number; // bytes per second
  errors: TestError[];
  bottlenecks: Bottleneck[];
  recommendations: string[];
}

export interface TestError {
  type: string;
  message: string;
  count: number;
  percentage: number;
  timestamp: Date;
}

export interface Bottleneck {
  type: 'cpu' | 'memory' | 'network' | 'disk' | 'database' | 'api' | 'application';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  impact: string;
  recommendation: string;
  metrics: any;
}

export class PerformanceService extends BaseService {
  private testHistory: LoadTestResult[] = [];
  private monitoringInterval: NodeJS.Timeout | null = null;
  private currentMetrics: PerformanceMetrics | null = null;

  constructor() {
    super('PerformanceService');
  }

  async initialize(): Promise<void> {
    this.logOperation('Initializing Performance service');

    if (config.services.performance?.enabled) {
      this.startPerformanceMonitoring();
      this.logOperation('Performance monitoring started');
    }
  }

  // Load Testing Methods

  async runLoadTest(config: LoadTestConfig): Promise<LoadTestResult> {
    const testId = `test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const startTime = new Date();

    this.logOperation('Starting load test', {
      testId,
      targetUrl: config.targetUrl,
      concurrentUsers: config.concurrentUsers,
      duration: config.duration
    });

    try {
      const result = await this.executeLoadTest(testId, config);

      // Analyze results for bottlenecks
      result.bottlenecks = await this.identifyBottlenecks(result);

      // Generate recommendations
      result.recommendations = this.generateRecommendations(result);

      // Store in history
      this.testHistory.push(result);

      this.logOperation('Load test completed', {
        testId,
        duration: result.duration,
        totalRequests: result.totalRequests,
        successRate: (result.successfulRequests / result.totalRequests * 100).toFixed(2) + '%'
      });

      return result;
    } catch (error) {
      this.logOperation('Load test failed', error);
      throw error;
    }
  }

  private async executeLoadTest(testId: string, config: LoadTestConfig): Promise<LoadTestResult> {
    const startTime = Date.now();
    const result: LoadTestResult = {
      testId,
      config,
      startTime: new Date(startTime),
      endTime: new Date(),
      duration: 0,
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageResponseTime: 0,
      minResponseTime: Infinity,
      maxResponseTime: 0,
      p50ResponseTime: 0,
      p90ResponseTime: 0,
      p95ResponseTime: 0,
      p99ResponseTime: 0,
      requestsPerSecond: 0,
      throughput: 0,
      errors: [],
      bottlenecks: [],
      recommendations: []
    };

    const responseTimes: number[] = [];
    const activeConnections = new Set<string>();
    let totalBytes = 0;

    // Simulate load test execution
    const totalRequests = config.concurrentUsers * config.requestRate * config.duration;

    for (let second = 0; second < config.duration; second++) {
      const requestsThisSecond = Math.min(
        config.requestRate,
        Math.ceil(totalRequests / config.duration)
      );

      for (let i = 0; i < requestsThisSecond; i++) {
        const scenario = this.selectScenario(config.scenarios);
        const requestId = `${testId}_${second}_${i}`;

        try {
          const { responseTime, responseSize, success } = await this.simulateRequest(
            config.targetUrl,
            scenario,
            requestId
          );

          responseTimes.push(responseTime);
          totalBytes += responseSize;

          if (success) {
            result.successfulRequests++;
          } else {
            result.failedRequests++;
            this.recordError(result, 'HTTP_ERROR', 'Request failed', second);
          }

          result.minResponseTime = Math.min(result.minResponseTime, responseTime);
          result.maxResponseTime = Math.max(result.maxResponseTime, responseTime);

        } catch (error) {
          result.failedRequests++;
          this.recordError(result, 'NETWORK_ERROR', error.message, second);
        }

        result.totalRequests++;
      }

      // Small delay to simulate real timing
      await new Promise(resolve => setTimeout(resolve, 1000 / requestsThisSecond));
    }

    const endTime = Date.now();
    result.endTime = new Date(endTime);
    result.duration = Math.floor((endTime - startTime) / 1000);

    // Calculate statistics
    this.calculateStatistics(result, responseTimes, totalBytes);

    return result;
  }

  private selectScenario(scenarios: LoadTestScenario[]): LoadTestScenario {
    const totalWeight = scenarios.reduce((sum, s) => sum + s.weight, 0);
    let random = Math.random() * totalWeight;

    for (const scenario of scenarios) {
      random -= scenario.weight;
      if (random <= 0) {
        return scenario;
      }
    }

    return scenarios[0];
  }

  private async simulateRequest(
    targetUrl: string,
    scenario: LoadTestScenario,
    requestId: string
  ): Promise<{ responseTime: number; responseSize: number; success: boolean }> {
    const startTime = Date.now();

    // Simulate network latency and processing time
    const baseLatency = 50 + Math.random() * 100; // 50-150ms base
    const processingTime = Math.random() * 200; // 0-200ms processing
    const networkJitter = Math.random() * 50; // 0-50ms jitter

    const totalLatency = baseLatency + processingTime + networkJitter;

    await new Promise(resolve => setTimeout(resolve, totalLatency));

    const responseTime = Date.now() - startTime;

    // Simulate response sizes based on endpoint
    let responseSize = 1024; // 1KB default
    if (scenario.endpoint.includes('/api/')) {
      responseSize = 2048 + Math.random() * 4096; // 2-6KB for API responses
    } else if (scenario.endpoint.includes('/dashboard')) {
      responseSize = 10240 + Math.random() * 20480; // 10-30KB for dashboard
    }

    // Simulate occasional failures
    const success = Math.random() > 0.02; // 2% failure rate

    return { responseTime, responseSize, success };
  }

  private recordError(result: LoadTestResult, type: string, message: string, timestamp: number): void {
    const existingError = result.errors.find(e => e.type === type);

    if (existingError) {
      existingError.count++;
      existingError.percentage = (existingError.count / result.totalRequests) * 100;
    } else {
      result.errors.push({
        type,
        message,
        count: 1,
        percentage: (1 / result.totalRequests) * 100,
        timestamp: new Date(timestamp * 1000)
      });
    }
  }

  private calculateStatistics(result: LoadTestResult, responseTimes: number[], totalBytes: number): void {
    if (responseTimes.length === 0) return;

    // Average response time
    result.averageResponseTime = responseTimes.reduce((sum, time) => sum + time, 0) / responseTimes.length;

    // Percentiles
    const sortedTimes = responseTimes.sort((a, b) => a - b);
    result.p50ResponseTime = sortedTimes[Math.floor(sortedTimes.length * 0.5)];
    result.p90ResponseTime = sortedTimes[Math.floor(sortedTimes.length * 0.9)];
    result.p95ResponseTime = sortedTimes[Math.floor(sortedTimes.length * 0.95)];
    result.p99ResponseTime = sortedTimes[Math.floor(sortedTimes.length * 0.99)];

    // Requests per second
    result.requestsPerSecond = result.totalRequests / result.duration;

    // Throughput
    result.throughput = totalBytes / result.duration;
  }

  // Bottleneck Analysis

  private async identifyBottlenecks(result: LoadTestResult): Promise<Bottleneck[]> {
    const bottlenecks: Bottleneck[] = [];

    // Response time bottlenecks
    if (result.p95ResponseTime > 1000) {
      bottlenecks.push({
        type: 'application',
        severity: result.p95ResponseTime > 2000 ? 'critical' : 'high',
        description: `95th percentile response time is ${result.p95ResponseTime}ms`,
        impact: 'Users experiencing slow response times',
        recommendation: 'Optimize database queries, implement caching, or scale horizontally',
        metrics: { p95ResponseTime: result.p95ResponseTime }
      });
    }

    // Error rate bottlenecks
    const errorRate = (result.failedRequests / result.totalRequests) * 100;
    if (errorRate > 1) {
      bottlenecks.push({
        type: 'application',
        severity: errorRate > 5 ? 'critical' : 'medium',
        description: `Error rate is ${errorRate.toFixed(2)}%`,
        impact: 'Users experiencing failed requests',
        recommendation: 'Investigate error logs, fix application bugs, improve error handling',
        metrics: { errorRate, totalErrors: result.failedRequests }
      });
    }

    // Throughput bottlenecks
    if (result.requestsPerSecond < 100) {
      bottlenecks.push({
        type: 'application',
        severity: result.requestsPerSecond < 50 ? 'high' : 'medium',
        description: `Low throughput: ${result.requestsPerSecond.toFixed(2)} requests/second`,
        impact: 'System cannot handle required load',
        recommendation: 'Scale horizontally, optimize code, implement load balancing',
        metrics: { throughput: result.requestsPerSecond }
      });
    }

    // Add simulated infrastructure bottlenecks
    const currentMetrics = this.currentMetrics || await this.getSystemMetrics();

    if (currentMetrics.cpu.usage > 80) {
      bottlenecks.push({
        type: 'cpu',
        severity: currentMetrics.cpu.usage > 90 ? 'critical' : 'high',
        description: `CPU usage at ${currentMetrics.cpu.usage}%`,
        impact: 'System performance degradation',
        recommendation: 'Scale vertically (more CPU cores) or horizontally (more instances)',
        metrics: { cpuUsage: currentMetrics.cpu.usage }
      });
    }

    if (currentMetrics.memory.percentage > 85) {
      bottlenecks.push({
        type: 'memory',
        severity: currentMetrics.memory.percentage > 95 ? 'critical' : 'high',
        description: `Memory usage at ${currentMetrics.memory.percentage}%`,
        impact: 'Risk of out-of-memory errors',
        recommendation: 'Add more memory, optimize memory usage, implement memory leaks fixes',
        metrics: { memoryUsage: currentMetrics.memory.percentage }
      });
    }

    return bottlenecks;
  }

  private generateRecommendations(result: LoadTestResult): string[] {
    const recommendations: string[] = [];

    // Performance recommendations
    if (result.p95ResponseTime > 500) {
      recommendations.push('Implement response caching to reduce average response times');
      recommendations.push('Consider using a CDN for static assets');
    }

    if (result.requestsPerSecond < 500) {
      recommendations.push('Implement horizontal scaling with load balancer');
      recommendations.push('Optimize database connection pooling');
    }

    // Error handling recommendations
    const errorRate = (result.failedRequests / result.totalRequests) * 100;
    if (errorRate > 0.5) {
      recommendations.push('Implement comprehensive error logging and monitoring');
      recommendations.push('Add circuit breakers for external service calls');
    }

    // Infrastructure recommendations
    if (result.config.concurrentUsers > 1000) {
      recommendations.push('Consider using auto-scaling groups for production workloads');
      recommendations.push('Implement health checks and graceful degradation');
    }

    // Add specific bottleneck recommendations
    result.bottlenecks.forEach(bottleneck => {
      recommendations.push(bottleneck.recommendation);
    });

    // Remove duplicates
    return [...new Set(recommendations)];
  }

  // Performance Monitoring

  private startPerformanceMonitoring(): void {
    this.monitoringInterval = setInterval(async () => {
      try {
        this.currentMetrics = await this.getSystemMetrics();
      } catch (error) {
        this.logOperation('Performance monitoring error', error);
      }
    }, 5000); // Collect metrics every 5 seconds
  }

  private async getSystemMetrics(): Promise<PerformanceMetrics> {
    // Mock system metrics - in production, this would use actual system monitoring
    const now = new Date();

    return {
      timestamp: now,
      cpu: {
        usage: 20 + Math.random() * 60, // 20-80% CPU usage
        cores: 8,
        loadAverage: [
          0.5 + Math.random() * 2,
          0.6 + Math.random() * 1.5,
          0.7 + Math.random() * 1
        ]
      },
      memory: {
        total: 16384, // 16GB
        used: 8192 + Math.random() * 4096, // 8-12GB used
        free: 4096 + Math.random() * 2048, // 4-6GB free
        percentage: 50 + Math.random() * 25 // 50-75% usage
      },
      network: {
        bytesIn: Math.random() * 1000000,
        bytesOut: Math.random() * 1000000,
        packetsIn: Math.floor(Math.random() * 10000),
        packetsOut: Math.floor(Math.random() * 10000),
        connections: Math.floor(100 + Math.random() * 500)
      },
      disk: {
        total: 1024 * 1024, // 1TB
        used: 512 * 1024 + Math.random() * 256 * 1024, // 512-768GB used
        free: 256 * 1024 + Math.random() * 256 * 1024, // 256-512GB free
        percentage: 50 + Math.random() * 25, // 50-75% usage
        iops: Math.floor(100 + Math.random() * 900)
      },
      application: {
        activeConnections: Math.floor(50 + Math.random() * 200),
        requestRate: Math.floor(10 + Math.random() * 100),
        responseTime: 50 + Math.random() * 200,
        errorRate: Math.random() * 5
      }
    };
  }

  // Public API Methods

  async getCurrentMetrics(): Promise<PerformanceMetrics> {
    return this.currentMetrics || await this.getSystemMetrics();
  }

  async getTestHistory(limit: number = 10): Promise<LoadTestResult[]> {
    return this.testHistory.slice(-limit);
  }

  async getTestById(testId: string): Promise<LoadTestResult | null> {
    return this.testHistory.find(test => test.testId === testId) || null;
  }

  async getPerformanceSummary(): Promise<any> {
    if (this.testHistory.length === 0) {
      return { message: 'No tests performed yet' };
    }

    const latestTest = this.testHistory[this.testHistory.length - 1];
    const currentMetrics = await this.getCurrentMetrics();

    return {
      latestTest: {
        testId: latestTest.testId,
        timestamp: latestTest.startTime,
        requestsPerSecond: latestTest.requestsPerSecond,
        averageResponseTime: latestTest.averageResponseTime,
        errorRate: (latestTest.failedRequests / latestTest.totalRequests) * 100
      },
      currentMetrics,
      testCount: this.testHistory.length,
      bottlenecks: latestTest.bottlenecks.length,
      recommendations: latestTest.recommendations.length
    };
  }

  // Predefined Load Test Configurations

  getStandardLoadTestConfigs(): LoadTestConfig[] {
    return [
      {
        targetUrl: config.baseUrl || 'http://localhost:3000',
        concurrentUsers: 100,
        duration: 300, // 5 minutes
        rampUpTime: 60,
        requestRate: 50,
        scenarios: [
          {
            name: 'Health Check',
            weight: 10,
            method: 'GET',
            endpoint: '/health',
            expectedStatus: 200,
            timeout: 5000
          },
          {
            name: 'Dashboard Load',
            weight: 30,
            method: 'GET',
            endpoint: '/api/dashboard',
            expectedStatus: 200,
            timeout: 10000
          },
          {
            name: 'Infrastructure Scan',
            weight: 20,
            method: 'POST',
            endpoint: '/api/scan',
            expectedStatus: 200,
            timeout: 30000
          },
          {
            name: 'AI Analysis',
            weight: 25,
            method: 'POST',
            endpoint: '/api/ai/analyze',
            expectedStatus: 200,
            timeout: 15000
          },
          {
            name: 'Security Check',
            weight: 15,
            method: 'GET',
            endpoint: '/api/security/status',
            expectedStatus: 200,
            timeout: 5000
          }
        ]
      },
      {
        targetUrl: config.baseUrl || 'http://localhost:3000',
        concurrentUsers: 1000,
        duration: 600, // 10 minutes
        rampUpTime: 120,
        requestRate: 200,
        scenarios: [
          // Same scenarios but higher load
          {
            name: 'Health Check',
            weight: 5,
            method: 'GET',
            endpoint: '/health',
            expectedStatus: 200,
            timeout: 5000
          },
          {
            name: 'Dashboard Load',
            weight: 35,
            method: 'GET',
            endpoint: '/api/dashboard',
            expectedStatus: 200,
            timeout: 10000
          },
          {
            name: 'Infrastructure Scan',
            weight: 20,
            method: 'POST',
            endpoint: '/api/scan',
            expectedStatus: 200,
            timeout: 30000
          },
          {
            name: 'AI Analysis',
            weight: 30,
            method: 'POST',
            endpoint: '/api/ai/analyze',
            expectedStatus: 200,
            timeout: 15000
          },
          {
            name: 'Security Check',
            weight: 10,
            method: 'GET',
            endpoint: '/api/security/status',
            expectedStatus: 200,
            timeout: 5000
          }
        ]
      },
      {
        targetUrl: config.baseUrl || 'http://localhost:3000',
        concurrentUsers: 10000,
        duration: 1800, // 30 minutes
        rampUpTime: 300,
        requestRate: 1000,
        scenarios: [
          // Enterprise-scale load test
          {
            name: 'Health Check',
            weight: 2,
            method: 'GET',
            endpoint: '/health',
            expectedStatus: 200,
            timeout: 5000
          },
          {
            name: 'Dashboard Load',
            weight: 40,
            method: 'GET',
            endpoint: '/api/dashboard',
            expectedStatus: 200,
            timeout: 10000
          },
          {
            name: 'Infrastructure Scan',
            weight: 18,
            method: 'POST',
            endpoint: '/api/scan',
            expectedStatus: 200,
            timeout: 30000
          },
          {
            name: 'AI Analysis',
            weight: 35,
            method: 'POST',
            endpoint: '/api/ai/analyze',
            expectedStatus: 200,
            timeout: 15000
          },
          {
            name: 'Security Check',
            weight: 5,
            method: 'GET',
            endpoint: '/api/security/status',
            expectedStatus: 200,
            timeout: 5000
          }
        ]
      }
    ];
  }

  async healthCheck(): Promise<{ status: string; monitoring: boolean; testsPerformed: number }> {
    return {
      status: 'healthy',
      monitoring: !!this.monitoringInterval,
      testsPerformed: this.testHistory.length
    };
  }

  async shutdown(): Promise<void> {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    this.logOperation('Performance service shutdown');
  }
}