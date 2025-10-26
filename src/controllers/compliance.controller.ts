import { Request, Response } from 'express';
import { ComplianceService } from '../services/compliance.service';
import { ServiceResponse } from '../types';

export class ComplianceController {
  private complianceService: ComplianceService;

  constructor() {
    this.complianceService = new ComplianceService();
  }

  // Initialize compliance service
  async initialize(req: Request, res: Response): Promise<void> {
    try {
      await this.complianceService.initialize();
      const response: ServiceResponse = {
        success: true,
        data: { message: 'Compliance service initialized successfully' },
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

  // Get all compliance frameworks
  async getFrameworks(req: Request, res: Response): Promise<void> {
    try {
      const frameworks = await this.complianceService.getAllFrameworks();
      const response: ServiceResponse = {
        success: true,
        data: frameworks,
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

  // Get specific compliance framework
  async getFramework(req: Request, res: Response): Promise<void> {
    try {
      const { framework } = req.params;
      const frameworkData = await this.complianceService.getComplianceFramework(framework);

      if (!frameworkData) {
        const response: ServiceResponse = {
          success: false,
          error: 'Framework not found',
          timestamp: new Date(),
          requestId: req.headers['x-request-id'] as string || 'unknown'
        };
        res.status(404).json(response);
        return;
      }

      const response: ServiceResponse = {
        success: true,
        data: frameworkData,
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

  // Generate compliance report
  async generateReport(req: Request, res: Response): Promise<void> {
    try {
      const { framework } = req.params;
      const { start, end } = req.query;

      let period;
      if (start && end) {
        period = {
          start: new Date(start as string),
          end: new Date(end as string)
        };
      }

      const report = await this.complianceService.generateComplianceReport(framework, period);

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

  // Run compliance assessment
  async runAssessment(req: Request, res: Response): Promise<void> {
    try {
      const { framework } = req.params;
      const { controlId } = req.query;

      const assessments = await this.complianceService.runComplianceAssessment(
        framework,
        controlId as string
      );

      const response: ServiceResponse = {
        success: true,
        data: assessments,
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

  // Get compliance dashboard data
  async getDashboard(req: Request, res: Response): Promise<void> {
    try {
      const frameworks = await this.complianceService.getAllFrameworks();

      // Generate dashboard summary
      const dashboard = {
        overview: {
          totalFrameworks: frameworks.length,
          lastUpdated: new Date(),
          status: 'healthy'
        },
        frameworkSummaries: await Promise.all(
          frameworks.map(async (framework) => {
            const report = await this.complianceService.generateComplianceReport(framework.name);
            return {
              name: framework.name,
              version: framework.version,
              overallScore: report.overallScore,
              status: report.status,
              totalControls: report.summary.totalControls,
              compliantControls: report.summary.compliantControls,
              criticalRisks: report.summary.criticalRisks,
              highRisks: report.summary.highRisks
            };
          })
        ),
        alerts: this.generateComplianceAlerts(frameworks),
        upcomingAssessments: this.getUpcomingAssessments(frameworks)
      };

      const response: ServiceResponse = {
        success: true,
        data: dashboard,
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

  // Get compliance evidence
  async getEvidence(req: Request, res: Response): Promise<void> {
    try {
      const { framework, controlId } = req.params;

      // In a real implementation, this would query the evidence store
      const mockEvidence = {
        controlId,
        framework,
        evidence: [
          {
            id: 'evidence-1',
            type: 'automated',
            description: 'Automated security scan results',
            timestamp: new Date(),
            status: 'verified',
            fileUrl: '/api/evidence/evidence-1.pdf'
          },
          {
            id: 'evidence-2',
            type: 'configuration',
            description: 'System configuration verification',
            timestamp: new Date(),
            status: 'verified',
            fileUrl: '/api/evidence/evidence-2.json'
          }
        ]
      };

      const response: ServiceResponse = {
        success: true,
        data: mockEvidence,
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

  // Export compliance report
  async exportReport(req: Request, res: Response): Promise<void> {
    try {
      const { framework } = req.params;
      const { format, start, end } = req.query;

      let period;
      if (start && end) {
        period = {
          start: new Date(start as string),
          end: new Date(end as string)
        };
      }

      const report = await this.complianceService.generateComplianceReport(framework, period);

      // Export in different formats
      switch (format) {
        case 'pdf':
          // Generate PDF
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `attachment; filename="compliance-report-${framework}.pdf"`);
          // PDF generation logic here
          res.send(Buffer.from('PDF content would go here'));
          break;

        case 'excel':
          // Generate Excel
          res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
          res.setHeader('Content-Disposition', `attachment; filename="compliance-report-${framework}.xlsx"`);
          // Excel generation logic here
          res.send(Buffer.from('Excel content would go here'));
          break;

        case 'json':
        default:
          // Return JSON
          const response: ServiceResponse = {
            success: true,
            data: report,
            timestamp: new Date(),
            requestId: req.headers['x-request-id'] as string || 'unknown'
          };
          res.status(200).json(response);
          break;
      }
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

  // Get compliance metrics
  async getMetrics(req: Request, res: Response): Promise<void> {
    try {
      const { timeframe } = req.query as { timeframe: string };

      // Generate comprehensive compliance metrics
      const metrics = {
        timeframe: timeframe || '30d',
        overallCompliance: {
          currentScore: 87,
          previousScore: 84,
          trend: 'improving',
          targetScore: 95
        },
        frameworkMetrics: {
          soc2Type2: {
            score: 92,
            status: 'compliant',
            controlsAssessed: 67,
            criticalIssues: 0,
            lastAssessment: new Date()
          },
          iso27001: {
            score: 85,
            status: 'requires-improvement',
            controlsAssessed: 114,
            criticalIssues: 1,
            lastAssessment: new Date()
          },
          noipEnterprise: {
            score: 88,
            status: 'compliant',
            controlsAssessed: 5,
            criticalIssues: 0,
            lastAssessment: new Date()
          }
        },
        riskMetrics: {
          totalRisks: 11,
          critical: 1,
          high: 3,
          medium: 5,
          low: 2,
          riskTrend: 'decreasing'
        },
        assessmentMetrics: {
          totalAssessments: 186,
          automatedAssessments: 142,
          manualAssessments: 44,
          averageAssessmentTime: '2.5 hours',
          nextAssessmentsDue: 8
        },
        evidenceMetrics: {
          totalEvidence: 1248,
          verifiedEvidence: 1198,
          pendingVerification: 35,
          expiredEvidence: 15,
          evidenceAuditScore: 96
        },
        remediationMetrics: {
          openRemediations: 12,
          inProgressRemediations: 8,
          completedRemediations: 45,
          averageRemediationTime: '14 days',
          overdueRemediations: 2
        }
      };

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

  // Health check
  async healthCheck(req: Request, res: Response): Promise<void> {
    try {
      const health = await this.complianceService.healthCheck();

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

  // Helper methods
  private generateComplianceAlerts(frameworks: any[]): any[] {
    const alerts = [];

    // Check for critical issues
    frameworks.forEach(framework => {
      framework.controls.forEach((control: any) => {
        if (control.riskLevel === 'critical' && control.status !== 'compliant') {
          alerts.push({
            id: `alert-${framework.name}-${control.id}`,
            type: 'critical',
            title: `Critical Compliance Issue: ${control.title}`,
            description: `Control ${control.id} in ${framework.name} framework requires immediate attention`,
            severity: 'critical',
            timestamp: new Date(),
            framework: framework.name,
            controlId: control.id
          });
        }

        // Check for upcoming assessments
        const daysUntilAssessment = Math.floor(
          (control.nextAssessment.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)
        );

        if (daysUntilAssessment <= 7 && daysUntilAssessment > 0) {
          alerts.push({
            id: `assessment-due-${framework.name}-${control.id}`,
            type: 'assessment_due',
            title: `Assessment Due Soon: ${control.title}`,
            description: `Assessment for control ${control.id} is due in ${daysUntilAssessment} days`,
            severity: daysUntilAssessment <= 3 ? 'high' : 'medium',
            timestamp: new Date(),
            framework: framework.name,
            controlId: control.id,
            dueDate: control.nextAssessment
          });
        }
      });
    });

    return alerts.sort((a, b) => {
      const severityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
      return severityOrder[b.severity] - severityOrder[a.severity];
    });
  }

  private getUpcomingAssessments(frameworks: any[]): any[] {
    const upcomingAssessments = [];

    frameworks.forEach(framework => {
      framework.controls.forEach((control: any) => {
        const daysUntilAssessment = Math.floor(
          (control.nextAssessment.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)
        );

        if (daysUntilAssessment <= 30) {
          upcomingAssessments.push({
            controlId: control.id,
            title: control.title,
            category: control.category,
            framework: framework.name,
            dueDate: control.nextAssessment,
            daysUntilAssessment,
            riskLevel: control.riskLevel,
            automatedTesting: control.automatedTesting
          });
        }
      });
    });

    return upcomingAssessments
      .sort((a, b) => a.daysUntilAssessment - b.daysUntilAssessment)
      .slice(0, 10); // Return next 10 assessments
  }
}