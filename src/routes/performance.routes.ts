import { Router } from 'express';
import { PerformanceController } from '../controllers/performance.controller';

const router = Router();
const performanceController = new PerformanceController();

// Initialize performance service
router.post('/initialize', performanceController.initialize.bind(performanceController));

// Get current performance metrics
router.get('/metrics', performanceController.getCurrentMetrics.bind(performanceController));

// Run custom load test
router.post('/load-test', performanceController.runLoadTest.bind(performanceController));

// Run predefined load tests
router.post('/load-test/:testType', performanceController.runPredefinedTest.bind(performanceController));

// Get test history
router.get('/tests', performanceController.getTestHistory.bind(performanceController));

// Get specific test result
router.get('/tests/:testId', performanceController.getTestById.bind(performanceController));

// Generate performance report for a test
router.get('/tests/:testId/report', performanceController.generateReport.bind(performanceController));

// Get performance summary
router.get('/summary', performanceController.getPerformanceSummary.bind(performanceController));

// Get standard load test configurations
router.get('/configs', performanceController.getStandardConfigs.bind(performanceController));

// Health check
router.get('/health', performanceController.healthCheck.bind(performanceController));

export default router;