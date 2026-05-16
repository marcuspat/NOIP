import { Request, Response } from 'express';
import {
  PerformanceService,
  LoadTestConfig,
} from '../services/performance.service';
import { ServiceResponse } from '../types';
import { messageOf } from '../shared/errors/from-unknown';

// Local helper: assemble the boilerplate ServiceResponse envelope from
// the request id so every handler stops repeating the same dozen lines.
function envelope<T>(
  req: Request,
  body: { success: true; data: T } | { success: false; error: string }
): ServiceResponse<T> {
  const requestId =
    (req.headers['x-request-id'] as string | undefined) ?? 'unknown';
  if (body.success) {
    return {
      success: true,
      data: body.data,
      timestamp: new Date(),
      requestId,
    };
  }
  return {
    success: false,
    error: body.error,
    timestamp: new Date(),
    requestId,
  };
}

export class PerformanceController {
  private performanceService: PerformanceService;

  constructor() {
    this.performanceService = new PerformanceService();
  }

  // Initialize performance service
  async initialize(req: Request, res: Response): Promise<void> {
    try {
      await this.performanceService.initialize();
      res.status(200).json(
        envelope(req, {
          success: true,
          data: { message: 'Performance service initialized successfully' },
        })
      );
    } catch (error) {
      res
        .status(500)
        .json(envelope(req, { success: false, error: messageOf(error) }));
    }
  }

  // Get current performance metrics
  async getCurrentMetrics(req: Request, res: Response): Promise<void> {
    try {
      const metrics = await this.performanceService.getCurrentMetrics();
      res.status(200).json(envelope(req, { success: true, data: metrics }));
    } catch (error) {
      res
        .status(500)
        .json(envelope(req, { success: false, error: messageOf(error) }));
    }
  }

  // Run load test
  async runLoadTest(req: Request, res: Response): Promise<void> {
    try {
      const config: LoadTestConfig = req.body;

      // Validate configuration
      if (!config.targetUrl || !config.concurrentUsers || !config.duration) {
        res.status(400).json(
          envelope(req, {
            success: false,
            error:
              'Missing required configuration: targetUrl, concurrentUsers, duration',
          })
        );
        return;
      }

      // Set default values if not provided
      config.rampUpTime = config.rampUpTime || 60;
      config.requestRate = config.requestRate || 10;
      config.scenarios = config.scenarios || this.getDefaultScenarios();

      const result = await this.performanceService.runLoadTest(config);
      res.status(200).json(envelope(req, { success: true, data: result }));
    } catch (error) {
      res
        .status(500)
        .json(envelope(req, { success: false, error: messageOf(error) }));
    }
  }

  // Get test history
  async getTestHistory(req: Request, res: Response): Promise<void> {
    try {
      // `req.query` is typed as an index signature under
      // `noPropertyAccessFromIndexSignature` — use bracket access and
      // parseInt's NaN fallback for invalid input.
      const limitParam = req.query['limit'];
      const limit = parseInt(limitParam as string) || 10;
      const history = await this.performanceService.getTestHistory(limit);
      res.status(200).json(envelope(req, { success: true, data: history }));
    } catch (error) {
      res
        .status(500)
        .json(envelope(req, { success: false, error: messageOf(error) }));
    }
  }

  // Get specific test result
  async getTestById(req: Request, res: Response): Promise<void> {
    try {
      const testId = req.params['testId'];
      if (testId === undefined) {
        res
          .status(400)
          .json(
            envelope(req, { success: false, error: 'Missing testId param' })
          );
        return;
      }
      const result = await this.performanceService.getTestById(testId);

      if (!result) {
        res
          .status(404)
          .json(envelope(req, { success: false, error: 'Test not found' }));
        return;
      }

      res.status(200).json(envelope(req, { success: true, data: result }));
    } catch (error) {
      res
        .status(500)
        .json(envelope(req, { success: false, error: messageOf(error) }));
    }
  }

  // Get performance summary
  async getPerformanceSummary(req: Request, res: Response): Promise<void> {
    try {
      const summary = await this.performanceService.getPerformanceSummary();
      res.status(200).json(envelope(req, { success: true, data: summary }));
    } catch (error) {
      res
        .status(500)
        .json(envelope(req, { success: false, error: messageOf(error) }));
    }
  }

  // Get standard load test configurations
  async getStandardConfigs(req: Request, res: Response): Promise<void> {
    try {
      const configs = this.performanceService.getStandardLoadTestConfigs();
      res.status(200).json(envelope(req, { success: true, data: configs }));
    } catch (error) {
      res
        .status(500)
        .json(envelope(req, { success: false, error: messageOf(error) }));
    }
  }

  // Run predefined load test
  async runPredefinedTest(req: Request, res: Response): Promise<void> {
    try {
      const testType = req.params['testType'];
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
          res.status(400).json(
            envelope(req, {
              success: false,
              error: 'Invalid test type. Use: light, medium, heavy',
            })
          );
          return;
      }

      const config = configs[configIndex];
      if (config === undefined) {
        res
          .status(500)
          .json(
            envelope(req, { success: false, error: 'Config slot is empty' })
          );
        return;
      }
      const result = await this.performanceService.runLoadTest(config);
      res.status(200).json(envelope(req, { success: true, data: result }));
    } catch (error) {
      res
        .status(500)
        .json(envelope(req, { success: false, error: messageOf(error) }));
    }
  }

  // Health check
  async healthCheck(req: Request, res: Response): Promise<void> {
    try {
      const health = await this.performanceService.healthCheck();
      res.status(200).json(envelope(req, { success: true, data: health }));
    } catch (error) {
      res
        .status(500)
        .json(envelope(req, { success: false, error: messageOf(error) }));
    }
  }

  // Generate performance report
  async generateReport(req: Request, res: Response): Promise<void> {
    try {
      const testId = req.params['testId'];
      if (testId === undefined) {
        res
          .status(400)
          .json(
            envelope(req, { success: false, error: 'Missing testId param' })
          );
        return;
      }
      const test = await this.performanceService.getTestById(testId);

      if (!test) {
        res
          .status(404)
          .json(envelope(req, { success: false, error: 'Test not found' }));
        return;
      }

      const report = this.generatePerformanceReport(test);
      res.status(200).json(envelope(req, { success: true, data: report }));
    } catch (error) {
      res
        .status(500)
        .json(envelope(req, { success: false, error: messageOf(error) }));
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
        timeout: 5000,
      },
      {
        name: 'Dashboard Load',
        weight: 40,
        method: 'GET' as const,
        endpoint: '/api/dashboard',
        expectedStatus: 200,
        timeout: 10000,
      },
      {
        name: 'API Test',
        weight: 50,
        method: 'POST' as const,
        endpoint: '/api/test',
        expectedStatus: 200,
        timeout: 5000,
      },
    ];
  }

  private generatePerformanceReport(test: {
    testId: string;
    startTime: Date;
    duration: number;
    config: { targetUrl: string; concurrentUsers: number };
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    requestsPerSecond: number;
    throughput: number;
    averageResponseTime: number;
    minResponseTime: number;
    maxResponseTime: number;
    p50ResponseTime: number;
    p90ResponseTime: number;
    p95ResponseTime: number;
    p99ResponseTime: number;
    bottlenecks: Array<{ severity: string }>;
    recommendations: unknown[];
    errors: Array<{
      type: string;
      count: number;
      percentage: number;
      message: string;
    }>;
  }) {
    const successRate = (
      (test.successfulRequests / test.totalRequests) *
      100
    ).toFixed(2);
    const errorRate = (
      (test.failedRequests / test.totalRequests) *
      100
    ).toFixed(2);

    return {
      testSummary: {
        testId: test.testId,
        timestamp: test.startTime,
        duration: `${Math.floor(test.duration / 60)}m ${test.duration % 60}s`,
        targetUrl: test.config.targetUrl,
        concurrentUsers: test.config.concurrentUsers,
      },
      performance: {
        totalRequests: test.totalRequests,
        successfulRequests: test.successfulRequests,
        failedRequests: test.failedRequests,
        successRate: `${successRate}%`,
        errorRate: `${errorRate}%`,
        requestsPerSecond: test.requestsPerSecond.toFixed(2),
        throughput: `${(test.throughput / 1024).toFixed(2)} KB/s`,
      },
      responseTime: {
        average: `${test.averageResponseTime.toFixed(2)}ms`,
        minimum: `${test.minResponseTime}ms`,
        maximum: `${test.maxResponseTime}ms`,
        p50: `${test.p50ResponseTime}ms`,
        p90: `${test.p90ResponseTime}ms`,
        p95: `${test.p95ResponseTime}ms`,
        p99: `${test.p99ResponseTime}ms`,
      },
      analysis: {
        bottlenecks: test.bottlenecks.length,
        criticalIssues: test.bottlenecks.filter(b => b.severity === 'critical')
          .length,
        recommendations: test.recommendations.length,
        overallPerformance: this.calculatePerformanceScore(test),
      },
      bottlenecks: test.bottlenecks,
      recommendations: test.recommendations,
      errors: test.errors.map(error => ({
        type: error.type,
        count: error.count,
        percentage: `${error.percentage.toFixed(2)}%`,
        message: error.message,
      })),
    };
  }

  private calculatePerformanceScore(test: {
    p95ResponseTime: number;
    failedRequests: number;
    totalRequests: number;
    requestsPerSecond: number;
    bottlenecks: unknown[];
  }): string {
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
