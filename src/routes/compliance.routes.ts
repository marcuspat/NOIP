import { Router } from 'express';
import { ComplianceController } from '../controllers/compliance.controller';

const router = Router();
const complianceController = new ComplianceController();

// Initialize compliance service
router.post('/initialize', complianceController.initialize.bind(complianceController));

// Get all compliance frameworks
router.get('/frameworks', complianceController.getFrameworks.bind(complianceController));

// Get specific compliance framework
router.get('/frameworks/:framework', complianceController.getFramework.bind(complianceController));

// Generate compliance report
router.get('/report/:framework', complianceController.generateReport.bind(complianceController));

// Export compliance report in different formats
router.get('/report/:framework/export', complianceController.exportReport.bind(complianceController));

// Run compliance assessment
router.post('/assessment/:framework', complianceController.runAssessment.bind(complianceController));

// Get compliance dashboard
router.get('/dashboard', complianceController.getDashboard.bind(complianceController));

// Get compliance metrics
router.get('/metrics', complianceController.getMetrics.bind(complianceController));

// Get compliance evidence
router.get('/evidence/:framework/:controlId', complianceController.getEvidence.bind(complianceController));

// Health check
router.get('/health', complianceController.healthCheck.bind(complianceController));

export default router;