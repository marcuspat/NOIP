import { Request, Response } from 'express';
import { PerformanceService, LoadTestConfig } from '../services/performance.service';
import { ServiceResponse } from '../types';

export class PerformanceController {
  private performanceService: PerformanceService;

  constructor() {
    this.performanceService = new PerformanceService();
  }

  // Initialize performance service
  async initialize(req: Request, res: Response): Promise<void> {
    try {
      await this.performanceService.initialize();
      const response: ServiceResponse = {
        success: true,
        data: { message: 'Performance service initialized successfully' },
        timestamp: new Date(),
        requestId: req.headers['x-request-id'] as string || 'unknown'
      };
      res.status(200).json(response);
    } catch (error) {
      const response: ServiceResponse = {
        success: false,
        error: error.message,
        timestamp: new Date(),
        requestId: req.headers['x-request-id'] as string || 'unknown'
      };
      res.status(500).json(response);
    }
  }

  // Get current performance metrics
  async getCurrentMetrics(req: Request, res: Response): Promise<void> {
    try {
      const metrics = await this.performanceService.getCurrentMetrics();
      const response: ServiceResponse = {
        success: true,
        data: metrics,
        timestamp: new Date(),
        requestId: req.headers['x-request-id'] as string || 'unknown'
      };
      res.status(200).json(response);
    } catch (error) {
      const response: ServiceResponse = {
        success: false,
        error: error.message,
        timestamp: new Date(),
        requestId: req.headers['x-request-id'] as string || 'unknown'
      };
      res.status(500).json(response);
    }
  }

  // Run load test
  async runLoadTest(req: Request, res: Response): Promise<void> {
    try {
      const config: LoadTestConfig = req.body;

      // Validate configuration
      if (!config.targetUrl || !config.concurrentUsers || !config.duration) {
        const response: ServiceResponse = {
          success: false,
          error: 'Missing required configuration: targetUrl, concurrentUsers, duration',
          timestamp: new Date(),
          requestId: req.headers['x-request-id'] as string || 'unknown'
        };
        res.status(400).json(response);
        return;
      }

      // Set default values if not provided
      config.rampUpTime = config.rampUpTime || 60;
      config.requestRate = config.requestRate || 10;
      config.scenarios = config.scenarios || this.getDefaultScenarios();

      const result = await this.performanceService.runLoadTest(config);

      const response: ServiceResponse = {
        success: true,
        data: result,
        timestamp: new Date(),
        requestId: req.headers['x-request-id'] as string || 'unknown'
      };
      res.status(200).json(response);
    } catch (error) {
      const response: ServiceResponse = {
        success: false,
        error: error.message,
        timestamp: new Date(),
        requestId: req.headers['x-request-id'] as string || 'unknown'
      };
      res.status(500).json(response);
    }
  }

  // Get test history
  async getTestHistory(req: Request, res: Response): Promise<void> {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const history = await this.performanceService.getTestHistory(limit);

      const response: ServiceResponse = {
        success: true,
        data: history,
        timestamp: new Date(),
        requestId: req.headers['x-request-id'] as string || 'unknown'
      };
      res.status(200).json(response);
    } catch (error) {
      const response: ServiceResponse = {
        success: false,
        error: error.message,
        timestamp: new Date(),
        requestId: req.headers['x-request-id'] as string || 'unknown'
      };
      res.status(500).json(response);
    }
  }

  // Get specific test result
  async getTestById(req: Request, res: Response): Promise<void> {
    try {
      const { testId } = req.params;
      const result = await this.performanceService.getTestById(testId);

      if (!result) {
        const response: ServiceResponse = {
          success: false,
          error: 'Test not found',
          timestamp: new Date(),
          requestId: req.headers['x-request-id'] as string || 'unknown'
        };
        res.status(404).json(response);
        return;
      }

      const response: ServiceResponse = {
        success: true,
        data: result,
        timestamp: new Date(),
        requestId: req.headers['x-request-id'] as string || 'unknown'
      };
      res.status(200).json(response);
    } catch (error) {
      const response: ServiceResponse = {
        success: false,
        error: error.message,
        timestamp: new Date(),
        requestId: req.headers['x-request-id'] as string || 'unknown'
      };
      res.status(500).json(response);
    }
  }

  // Get performance summary
  async getPerformanceSummary(req: Request, res: Response): Promise<void> {
    try {
      const summary = await this.performanceService.getPerformanceSummary();

      const response: ServiceResponse = {
        success: true,
        data: summary,
        timestamp: new Date(),
        requestId: req.headers['x-request-id'] as string || 'unknown'
      };
      res.status(200).json(response);
    } catch (error) {
      const response: ServiceResponse = {
        success: false,
        error: error.message,
        timestamp: new Date(),
        requestId: req.headers['x-request-id'] as string || 'unknown'
      };
      res.status(500).json(response);
    }
  }

  // Get standard load test configurations
  async getStandardConfigs(req: Request, res: Response): Promise<void> {
    try {
      const configs = this.performanceService.getStandardLoadTestConfigs();

      const response: ServiceResponse = {
        success: true,
        data: configs,
        timestamp: new Date(),
        requestId: req.headers['x-request-id'] as string || 'unknown'
      };
      res.status(200).json(response);
    } catch (error) {
      const response: ServiceResponse = {
        success: false,
        error: error.message,
        timestamp: new Date(),
        requestId: req.headers['x-request-id'] as string || 'unknown'
      };
      res.status(500).json(response);
    }
  }

  // Run predefined load test
  async runPredefinedTest(req: Request, res: Response): Promise<void> {
    try {
      const { testType } = req.params;
      const configs = this.performanceService.getStandardLoadTestConfigs();

      let configIndex = 0;
      switch (testType) {
        case 'light':
          configIndex = 0; // 100 concurrent users
          break;
        case 'medium':
          configIndex = 1; // 1000 concurrent users
          break;
        case 'heavy':
          configIndex = 2; // 10000 concurrent users
          break;
        default:
          const response: ServiceResponse = {
            success: false,
            error: 'Invalid test type. Use: light, medium, heavy',
            timestamp: new Date(),
            requestId: req.headers['x-request-id'] as string || 'unknown'
          };
          res.status(400).json(response);
          return;
      }

      const config = configs[configIndex];
      const result = await this.performanceService.runLoadTest(config);

      const response: ServiceResponse = {
        success: true,
        data: result,
        timestamp: new Date(),
        requestId: req.headers['x-request-id'] as string || 'unknown'
      };
      res.status(200).json(response);
    } catch (error) {
      const response: ServiceResponse = {
        success: false,
        error: error.message,
        timestamp: new Date(),
        requestId: req.headers['x-request-id'] as string || 'unknown'
      };
      res.status(500).json(response);
    }
  }

  // Health check
  async healthCheck(req: Request, res: Response): Promise<void> {
    try {
      const health = await this.performanceService.healthCheck();

      const response: ServiceResponse = {
        success: true,
        data: health,
        timestamp: new Date(),
        requestId: req.headers['x-request-id'] as string || 'unknown'
      };
      res.status(200).json(response);
    } catch (error) {
      const response: ServiceResponse = {
        success: false,
        error: error.message,
        timestamp: new Date(),
        requestId: req.headers['x-request-id'] as string || 'unknown'
      };
      res.status(500).json(response);
    }
  }

  // Generate performance report
  async generateReport(req: Request, res: Response): Promise<void> {
    try {
      const { testId } = req.params;
      const test = await this.performanceService.getTestById(testId);

      if (!test) {
        const response: ServiceResponse = {
          success: false,
          error: 'Test not found',
          timestamp: new Date(),
          requestId: req.headers['x-request-id'] as string || 'unknown'
        };
        res.status(404).json(response);
        return;
      }

      const report = this.generatePerformanceReport(test);

      const response: ServiceResponse = {
        success: true,
        data: report,
        timestamp: new Date(),
        requestId: req.headers['x-request-id'] as string || 'unknown'
      };
      res.status(200).json(response);
    } catch (error) {
      const response: ServiceResponse = {
        success: false,
        error: error.message,
        timestamp: new Date(),
        requestId: req.headers['x-request-id'] as string || 'unknown'
      };
      res.status(500).json(response);
    }
  }

  // Helper methods
  private getDefaultScenarios() {
    return [
      {
        name: 'Health Check',
        weight: 10,
        method: 'GET' as const,
        endpoint: '/health',
        expectedStatus: 200,
        timeout: 5000
      },
      {
        name: 'Dashboard Load',
        weight: 40,
        method: 'GET' as const,
        endpoint: '/api/dashboard',
        expectedStatus: 200,
        timeout: 10000
      },
      {
        name: 'API Test',
        weight: 50,
        method: 'POST' as const,
        endpoint: '/api/test',
        expectedStatus: 200,
        timeout: 5000
      }
    ];
  }

  private generatePerformanceReport(test: any) {
    const successRate = ((test.successfulRequests / test.totalRequests) * 100).toFixed(2);
    const errorRate = ((test.failedRequests / test.totalRequests) * 100).toFixed(2);

    return {
      testSummary: {
        testId: test.testId,
        timestamp: test.startTime,
        duration: `${Math.floor(test.duration / 60)}m ${test.duration % 60}s`,
        targetUrl: test.config.targetUrl,
        concurrentUsers: test.config.concurrentUsers
      },
      performance: {
        totalRequests: test.totalRequests,
        successfulRequests: test.successfulRequests,
        failedRequests: test.failedRequests,
        successRate: `${successRate}%`,
        errorRate: `${errorRate}%`,
        requestsPerSecond: test.requestsPerSecond.toFixed(2),
        throughput: `${(test.throughput / 1024).toFixed(2)} KB/s`
      },
      responseTime: {
        average: `${test.averageResponseTime.toFixed(2)}ms`,
        minimum: `${test.minResponseTime}ms`,
        maximum: `${test.maxResponseTime}ms`,
        p50: `${test.p50ResponseTime}ms`,
        p90: `${test.p90ResponseTime}ms`,
        p95: `${test.p95ResponseTime}ms`,
        p99: `${test.p99ResponseTime}ms`
      },
      analysis: {
        bottlenecks: test.bottlenecks.length,
        criticalIssues: test.bottlenecks.filter((b: any) => b.severity === 'critical').length,
        recommendations: test.recommendations.length,
        overallPerformance: this.calculatePerformanceScore(test)
      },
      bottlenecks: test.bottlenecks,
      recommendations: test.recommendations,
      errors: test.errors.map((error: any) => ({
        type: error.type,
        count: error.count,
        percentage: `${error.percentage.toFixed(2)}%`,
        message: error.message
      }))
    };
  }

  private calculatePerformanceScore(test: any): string {
    let score = 100;

    // Deduct points for high response times
    if (test.p95ResponseTime > 1000) score -= 20;
    else if (test.p95ResponseTime > 500) score -= 10;

    // Deduct points for errors
    const errorRate = (test.failedRequests / test.totalRequests) * 100;
    if (errorRate > 5) score -= 30;
    else if (errorRate > 1) score -= 15;

    // Deduct points for low throughput
    if (test.requestsPerSecond < 100) score -= 20;
    else if (test.requestsPerSecond < 500) score -= 10;

    // Deduct points for bottlenecks
    score -= test.bottlenecks.length * 5;

    score = Math.max(0, Math.min(100, score));

    if (score >= 90) return 'Excellent';
    if (score >= 80) return 'Good';
    if (score >= 70) return 'Fair';
    if (score >= 60) return 'Poor';
    return 'Critical';
  }
}