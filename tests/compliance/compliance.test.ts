import { ComplianceService } from '../../src/services/compliance.service';

describe('Compliance Service', () => {
  let complianceService: ComplianceService;

  beforeAll(async () => {
    complianceService = new ComplianceService();
    await complianceService.initialize();
  });

  describe('Framework Management', () => {
    test('should load all compliance frameworks', async () => {
      const frameworks = await complianceService.getAllFrameworks();

      expect(frameworks).toBeDefined();
      expect(Array.isArray(frameworks)).toBe(true);
      expect(frameworks.length).toBeGreaterThan(0);

      // Check for required frameworks
      const frameworkNames = frameworks.map(f => f.name);
      expect(frameworkNames).toContain('SOC 2 Type II');
      expect(frameworkNames).toContain('ISO 27001:2022');
      expect(frameworkNames).toContain('NOIP Enterprise');
    });

    test('should retrieve specific framework', async () => {
      const soc2Framework =
        await complianceService.getComplianceFramework('soc2-type2');

      expect(soc2Framework).toBeDefined();
      expect(soc2Framework!.name).toBe('SOC 2 Type II');
      expect(soc2Framework!.controls).toBeDefined();
      expect(soc2Framework!.controls.length).toBeGreaterThan(0);
    });

    test('should return null for non-existent framework', async () => {
      const nonExistentFramework =
        await complianceService.getComplianceFramework('non-existent');
      expect(nonExistentFramework).toBeNull();
    });

    test('should have proper control structure', async () => {
      const frameworks = await complianceService.getAllFrameworks();

      for (const framework of frameworks) {
        expect(framework.name).toBeDefined();
        expect(framework.version).toBeDefined();
        expect(framework.controls).toBeDefined();
        expect(framework.controls.length).toBeGreaterThan(0);

        // Check control structure
        for (const control of framework.controls) {
          expect(control.id).toBeDefined();
          expect(control.category).toBeDefined();
          expect(control.title).toBeDefined();
          expect(control.description).toBeDefined();
          expect(control.requirement).toBeDefined();
          expect(control.implementation).toBeDefined();
          expect(control.status).toBeDefined();
          expect(control.riskLevel).toBeDefined();
          expect(control.lastAssessed).toBeDefined();
          expect(control.nextAssessment).toBeDefined();
          expect(control.owner).toBeDefined();
          expect(control.automatedTesting).toBeDefined();
          expect(control.testFrequency).toBeDefined();

          // Validate status values
          expect([
            'compliant',
            'non-compliant',
            'partially-compliant',
            'not-assessed',
          ]).toContain(control.status);

          // Validate risk level values
          expect(['low', 'medium', 'high', 'critical']).toContain(
            control.riskLevel
          );

          // Validate test frequency values
          expect([
            'daily',
            'weekly',
            'monthly',
            'quarterly',
            'annually',
          ]).toContain(control.testFrequency);
        }
      }
    });
  });

  describe('Compliance Reports', () => {
    test('should generate compliance report for SOC 2', async () => {
      const report =
        await complianceService.generateComplianceReport('soc2-type2');

      expect(report).toBeDefined();
      expect(report.framework).toBe('SOC 2 Type II');
      expect(report.reportDate).toBeDefined();
      expect(report.overallScore).toBeGreaterThanOrEqual(0);
      expect(report.overallScore).toBeLessThanOrEqual(100);
      expect(report.status).toBeDefined();
      expect(['compliant', 'non-compliant', 'requires-improvement']).toContain(
        report.status
      );

      // Check summary
      expect(report.summary).toBeDefined();
      expect(report.summary.totalControls).toBeGreaterThan(0);
      expect(report.summary.compliantControls).toBeGreaterThanOrEqual(0);
      expect(report.summary.partiallyCompliantControls).toBeGreaterThanOrEqual(
        0
      );
      expect(report.summary.nonCompliantControls).toBeGreaterThanOrEqual(0);
      expect(report.summary.notAssessedControls).toBeGreaterThanOrEqual(0);

      // Check categories
      expect(report.categories).toBeDefined();
      expect(Array.isArray(report.categories)).toBe(true);

      // Check control results
      expect(report.controlResults).toBeDefined();
      expect(Array.isArray(report.controlResults)).toBe(true);
      expect(report.controlResults.length).toBe(report.summary.totalControls);

      // Check recommendations
      expect(report.recommendations).toBeDefined();
      expect(Array.isArray(report.recommendations)).toBe(true);

      // Check evidence audit
      expect(report.evidenceAudit).toBeDefined();
      expect(report.evidenceAudit.totalEvidence).toBeGreaterThanOrEqual(0);
      expect(report.evidenceAudit.verifiedEvidence).toBeGreaterThanOrEqual(0);

      // Check trend analysis
      expect(report.trendAnalysis).toBeDefined();
      expect(report.trendAnalysis.period).toBeDefined();
      expect(report.trendAnalysis.complianceScore).toBeDefined();
    });

    test('should generate compliance report for ISO 27001', async () => {
      const report =
        await complianceService.generateComplianceReport('iso27001');

      expect(report).toBeDefined();
      expect(report.framework).toBe('ISO 27001:2022');
      expect(report.overallScore).toBeGreaterThanOrEqual(0);
      expect(report.overallScore).toBeLessThanOrEqual(100);
    });

    test('should generate compliance report for custom period', async () => {
      const customPeriod = {
        start: new Date('2025-01-01'),
        end: new Date('2025-01-31'),
      };

      const report = await complianceService.generateComplianceReport(
        'soc2-type2',
        customPeriod
      );

      expect(report).toBeDefined();
      expect(report.period.start).toEqual(customPeriod.start);
      expect(report.period.end).toEqual(customPeriod.end);
    });

    test('should handle report generation errors gracefully', async () => {
      await expect(
        complianceService.generateComplianceReport('non-existent-framework')
      ).rejects.toThrow('Framework non-existent-framework not found');
    });
  });

  describe('Compliance Assessments', () => {
    test('should run assessment for entire framework', async () => {
      const assessments =
        await complianceService.runComplianceAssessment('soc2-type2');

      expect(assessments).toBeDefined();
      expect(Array.isArray(assessments)).toBe(true);
      expect(assessments.length).toBeGreaterThan(0);

      // Check assessment structure
      assessments.forEach(assessment => {
        expect(assessment.id).toBeDefined();
        expect(assessment.controlId).toBeDefined();
        expect(assessment.timestamp).toBeDefined();
        expect(assessment.type).toBeDefined();
        expect(['automated', 'manual']).toContain(assessment.type);
        expect(assessment.result).toBeDefined();
        expect(['pass', 'fail', 'warning']).toContain(assessment.result);
        expect(assessment.score).toBeGreaterThanOrEqual(0);
        expect(assessment.score).toBeLessThanOrEqual(100);
        expect(assessment.findings).toBeDefined();
        expect(Array.isArray(assessment.findings)).toBe(true);
        expect(assessment.evidence).toBeDefined();
        expect(Array.isArray(assessment.evidence)).toBe(true);
        expect(assessment.assessor).toBeDefined();
      });
    });

    test('should run assessment for specific control', async () => {
      const assessments = await complianceService.runComplianceAssessment(
        'soc2-type2',
        'CC1.1'
      );

      expect(assessments).toBeDefined();
      expect(Array.isArray(assessments)).toBe(true);
      expect(assessments.length).toBe(1);
      expect(assessments[0].controlId).toBe('CC1.1');
    });

    test('should generate appropriate findings', async () => {
      const assessments =
        await complianceService.runComplianceAssessment('soc2-type2');

      assessments.forEach(assessment => {
        expect(assessment.findings.length).toBeGreaterThan(0);
        assessment.findings.forEach(finding => {
          expect(typeof finding).toBe('string');
          expect(finding.length).toBeGreaterThan(0);
        });
      });
    });

    test('should generate evidence for assessments', async () => {
      const assessments =
        await complianceService.runComplianceAssessment('soc2-type2');

      assessments.forEach(assessment => {
        expect(assessment.evidence.length).toBeGreaterThan(0);
        assessment.evidence.forEach(evidence => {
          expect(evidence.id).toBeDefined();
          expect(evidence.type).toBeDefined();
          expect(evidence.description).toBeDefined();
          expect(evidence.timestamp).toBeDefined();
          expect(evidence.verified).toBeDefined();
        });
      });
    });
  });

  describe('Compliance Calculations', () => {
    test('should calculate overall compliance score correctly', async () => {
      const report =
        await complianceService.generateComplianceReport('soc2-type2');

      // Verify score calculation
      const expectedScore = Math.round(
        report.controlResults.reduce((sum, result) => sum + result.score, 0) /
          report.controlResults.length
      );

      expect(report.overallScore).toBe(expectedScore);
      expect(report.overallScore).toBeGreaterThanOrEqual(0);
      expect(report.overallScore).toBeLessThanOrEqual(100);
    });

    test('should determine compliance status correctly', async () => {
      const report =
        await complianceService.generateComplianceReport('soc2-type2');

      // Verify status determination
      const criticalNonCompliant = report.controlResults.filter(
        r => r.status === 'non-compliant' && r.riskLevel === 'critical'
      ).length;

      if (criticalNonCompliant > 0) {
        expect(report.status).toBe('non-compliant');
      } else if (report.overallScore >= 90) {
        expect(report.status).toBe('compliant');
      } else if (report.overallScore >= 70) {
        expect(report.status).toBe('requires-improvement');
      } else {
        expect(report.status).toBe('non-compliant');
      }
    });

    test('should generate category summaries correctly', async () => {
      const report =
        await complianceService.generateComplianceReport('soc2-type2');

      expect(report.categories.length).toBeGreaterThan(0);

      report.categories.forEach(category => {
        expect(category.category).toBeDefined();
        expect(category.score).toBeGreaterThanOrEqual(0);
        expect(category.score).toBeLessThanOrEqual(100);
        expect(category.totalControls).toBeGreaterThan(0);
        expect(category.compliantControls).toBeGreaterThanOrEqual(0);
        expect(category.compliantControls).toBeLessThanOrEqual(
          category.totalControls
        );
        expect(category.risks).toBeDefined();
        expect(category.risks.critical).toBeGreaterThanOrEqual(0);
        expect(category.risks.high).toBeGreaterThanOrEqual(0);
        expect(category.risks.medium).toBeGreaterThanOrEqual(0);
        expect(category.risks.low).toBeGreaterThanOrEqual(0);
      });
    });

    test('should generate meaningful recommendations', async () => {
      const report =
        await complianceService.generateComplianceReport('soc2-type2');

      report.recommendations.forEach(recommendation => {
        expect(recommendation.priority).toBeDefined();
        expect(['critical', 'high', 'medium', 'low']).toContain(
          recommendation.priority
        );
        expect(recommendation.category).toBeDefined();
        expect(recommendation.controlId).toBeDefined();
        expect(recommendation.title).toBeDefined();
        expect(recommendation.description).toBeDefined();
        expect(recommendation.impact).toBeDefined();
        expect(recommendation.effort).toBeDefined();
        expect(['low', 'medium', 'high']).toContain(recommendation.effort);
        expect(recommendation.timeline).toBeDefined();
        expect(recommendation.owner).toBeDefined();
      });
    });
  });

  describe('Evidence Management', () => {
    test('should audit evidence correctly', async () => {
      const report =
        await complianceService.generateComplianceReport('soc2-type2');

      expect(report.evidenceAudit).toBeDefined();
      expect(report.evidenceAudit.totalEvidence).toBeGreaterThanOrEqual(0);
      expect(report.evidenceAudit.verifiedEvidence).toBeGreaterThanOrEqual(0);
      expect(report.evidenceAudit.pendingVerification).toBeGreaterThanOrEqual(
        0
      );
      expect(report.evidenceAudit.expiredEvidence).toBeGreaterThanOrEqual(0);
      expect(report.evidenceAudit.missingEvidence).toBeGreaterThanOrEqual(0);
      expect(report.evidenceAudit.auditTrail).toBeDefined();
      expect(Array.isArray(report.evidenceAudit.auditTrail)).toBe(true);

      // Check audit trail structure
      if (report.evidenceAudit.auditTrail.length > 0) {
        const entry = report.evidenceAudit.auditTrail[0];
        expect(entry.timestamp).toBeDefined();
        expect(entry.action).toBeDefined();
        expect([
          'created',
          'verified',
          'updated',
          'expired',
          'deleted',
        ]).toContain(entry.action);
        expect(entry.evidenceId).toBeDefined();
        expect(entry.controlId).toBeDefined();
        expect(entry.performedBy).toBeDefined();
        expect(entry.details).toBeDefined();
      }
    });

    test('should generate evidence for controls', async () => {
      const assessments =
        await complianceService.runComplianceAssessment('soc2-type2');

      assessments.forEach(assessment => {
        expect(assessment.evidence.length).toBeGreaterThan(0);

        assessment.evidence.forEach(evidence => {
          expect(evidence.id).toBeDefined();
          expect(evidence.type).toBeDefined();
          expect([
            'automated',
            'manual',
            'document',
            'screenshot',
            'log',
            'configuration',
          ]).toContain(evidence.type);
          expect(evidence.description).toBeDefined();
          expect(evidence.source).toBeDefined();
          expect(evidence.timestamp).toBeDefined();
          expect(evidence.verified).toBeDefined();
        });
      });
    });
  });

  describe('Trend Analysis', () => {
    test('should generate trend analysis', async () => {
      const report =
        await complianceService.generateComplianceReport('soc2-type2');

      expect(report.trendAnalysis).toBeDefined();
      expect(report.trendAnalysis.period).toBeDefined();
      expect(['30d', '60d', '90d', '180d', '365d']).toContain(
        report.trendAnalysis.period
      );

      // Check compliance score trends
      expect(report.trendAnalysis.complianceScore).toBeDefined();
      expect(
        report.trendAnalysis.complianceScore.current
      ).toBeGreaterThanOrEqual(0);
      expect(report.trendAnalysis.complianceScore.current).toBeLessThanOrEqual(
        100
      );
      expect(
        report.trendAnalysis.complianceScore.previous
      ).toBeGreaterThanOrEqual(0);
      expect(report.trendAnalysis.complianceScore.previous).toBeLessThanOrEqual(
        100
      );
      expect(report.trendAnalysis.complianceScore.trend).toBeDefined();
      expect(['improving', 'stable', 'declining']).toContain(
        report.trendAnalysis.complianceScore.trend
      );

      // Check risk trends
      expect(report.trendAnalysis.riskTrends).toBeDefined();
      expect(report.trendAnalysis.riskTrends.critical).toBeDefined();
      expect(report.trendAnalysis.riskTrends.high).toBeDefined();
      expect(report.trendAnalysis.riskTrends.medium).toBeDefined();
      expect(report.trendAnalysis.riskTrends.low).toBeDefined();

      Object.values(report.trendAnalysis.riskTrends).forEach(trend => {
        expect(trend.current).toBeGreaterThanOrEqual(0);
        expect(trend.previous).toBeGreaterThanOrEqual(0);
        expect(trend.trend).toBeDefined();
        expect(['increasing', 'stable', 'decreasing']).toContain(trend.trend);
      });

      // Check category trends
      expect(report.trendAnalysis.categoryTrends).toBeDefined();
      expect(Array.isArray(report.trendAnalysis.categoryTrends)).toBe(true);

      report.trendAnalysis.categoryTrends.forEach(categoryTrend => {
        expect(categoryTrend.category).toBeDefined();
        expect(categoryTrend.score).toBeGreaterThanOrEqual(0);
        expect(categoryTrend.score).toBeLessThanOrEqual(100);
        expect(categoryTrend.trend).toBeDefined();
        expect(['improving', 'stable', 'declining']).toContain(
          categoryTrend.trend
        );
      });
    });
  });

  describe('Control Status Management', () => {
    test('should handle different control statuses', async () => {
      const frameworks = await complianceService.getAllFrameworks();

      frameworks.forEach(framework => {
        framework.controls.forEach(control => {
          expect([
            'compliant',
            'non-compliant',
            'partially-compliant',
            'not-assessed',
          ]).toContain(control.status);

          // Validate assessment scheduling
          expect(control.nextAssessment.getTime()).toBeGreaterThan(
            control.lastAssessed.getTime()
          );

          // Validate risk-based scheduling
          const daysUntilNextAssessment = Math.floor(
            (control.nextAssessment.getTime() - new Date().getTime()) /
              (1000 * 60 * 60 * 24)
          );

          // Higher risk controls should have more frequent assessments
          if (control.riskLevel === 'critical') {
            expect(daysUntilNextAssessment).toBeLessThanOrEqual(30);
          } else if (control.riskLevel === 'high') {
            expect(daysUntilNextAssessment).toBeLessThanOrEqual(60);
          }
        });
      });
    });

    test('should track assessment history', async () => {
      // Run multiple assessments
      await complianceService.runComplianceAssessment('soc2-type2');
      await complianceService.runComplianceAssessment('soc2-type2');

      const report =
        await complianceService.generateComplianceReport('soc2-type2');

      // Each control should have been assessed
      expect(report.controlResults.length).toBeGreaterThan(0);

      report.controlResults.forEach(result => {
        expect(result.lastAssessed).toBeDefined();
        expect(result.lastAssessed.getTime()).toBeLessThanOrEqual(
          new Date().getTime()
        );
      });
    });
  });

  describe('Health Check', () => {
    test('should return health status', async () => {
      const health = await complianceService.healthCheck();

      expect(health).toBeDefined();
      expect(health.status).toBe('healthy');
      expect(health.frameworks).toBeGreaterThan(0);
      expect(health.lastAssessment).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    test('should handle invalid framework names', async () => {
      await expect(
        complianceService.generateComplianceReport('invalid-framework')
      ).rejects.toThrow();
    });

    test('should handle invalid control IDs', async () => {
      const assessments = await complianceService.runComplianceAssessment(
        'soc2-type2',
        'invalid-control-id'
      );
      expect(assessments).toBeDefined();
      expect(assessments.length).toBe(0);
    });

    test('should handle invalid dates', async () => {
      const invalidPeriod = {
        start: new Date('invalid-date'),
        end: new Date(),
      };

      // Should handle gracefully or throw appropriate error
      await expect(
        complianceService.generateComplianceReport('soc2-type2', invalidPeriod)
      ).rejects.toThrow();
    });
  });
});
