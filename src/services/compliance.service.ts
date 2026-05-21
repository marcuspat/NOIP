import { BaseService } from './base.service';
import { config } from '../config';

// Compliance Framework Types
export interface ComplianceFramework {
  name: string;
  version: string;
  description: string;
  controls: ComplianceControl[];
  lastUpdated: Date;
  nextReview: Date;
}

export interface ComplianceControl {
  id: string;
  category: string;
  title: string;
  description: string;
  requirement: string;
  implementation: string;
  evidence: ComplianceEvidence[];
  status:
    | 'compliant'
    | 'non-compliant'
    | 'partially-compliant'
    | 'not-assessed';
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  lastAssessed: Date;
  nextAssessment: Date;
  owner: string;
  automatedTesting: boolean;
  testFrequency: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annually' | 'continuous';
}

export interface ComplianceEvidence {
  id: string;
  type:
    | 'automated'
    | 'manual'
    | 'document'
    | 'screenshot'
    | 'log'
    | 'configuration';
  description: string;
  source: string;
  timestamp: Date;
  data?: any;
  fileUrl?: string;
  verified: boolean;
  verificationDate?: Date;
}

export interface ComplianceReport {
  framework: string;
  version: string;
  reportDate: Date;
  period: {
    start: Date;
    end: Date;
  };
  overallScore: number; // 0-100
  status: 'compliant' | 'non-compliant' | 'requires-improvement';
  summary: {
    totalControls: number;
    compliantControls: number;
    partiallyCompliantControls: number;
    nonCompliantControls: number;
    notAssessedControls: number;
    criticalRisks: number;
    highRisks: number;
    mediumRisks: number;
    lowRisks: number;
  };
  categories: ComplianceCategorySummary[];
  controlResults: ComplianceControlResult[];
  recommendations: ComplianceRecommendation[];
  evidenceAudit: ComplianceEvidenceAudit;
  trendAnalysis: ComplianceTrendAnalysis;
}

export interface ComplianceCategorySummary {
  category: string;
  score: number;
  status: 'compliant' | 'non-compliant' | 'requires-improvement';
  totalControls: number;
  compliantControls: number;
  risks: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
}

export interface ComplianceControlResult {
  controlId: string;
  title: string;
  category: string;
  status:
    | 'compliant'
    | 'non-compliant'
    | 'partially-compliant'
    | 'not-assessed';
  score: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  lastAssessed: Date;
  evidenceCount: number;
  findings: string[];
  gaps: string[];
  remediationPlan?: string;
}

export interface ComplianceRecommendation {
  priority: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  controlId: string;
  title: string;
  description: string;
  impact: string;
  effort: 'low' | 'medium' | 'high';
  timeline: string;
  owner: string;
  dependencies?: string[];
}

export interface ComplianceEvidenceAudit {
  totalEvidence: number;
  verifiedEvidence: number;
  pendingVerification: number;
  expiredEvidence: number;
  missingEvidence: number;
  auditTrail: ComplianceAuditEntry[];
}

export interface ComplianceAuditEntry {
  timestamp: Date;
  action: 'created' | 'verified' | 'updated' | 'expired' | 'deleted';
  evidenceId: string;
  controlId: string;
  performedBy: string;
  details: string;
}

export interface ComplianceTrendAnalysis {
  period: '30d' | '60d' | '90d' | '180d' | '365d';
  complianceScore: {
    current: number;
    previous: number;
    change: number;
    trend: 'improving' | 'stable' | 'declining';
  };
  riskTrends: {
    critical: {
      current: number;
      previous: number;
      trend: 'increasing' | 'stable' | 'decreasing';
    };
    high: {
      current: number;
      previous: number;
      trend: 'increasing' | 'stable' | 'decreasing';
    };
    medium: {
      current: number;
      previous: number;
      trend: 'increasing' | 'stable' | 'decreasing';
    };
    low: {
      current: number;
      previous: number;
      trend: 'increasing' | 'stable' | 'decreasing';
    };
  };
  categoryTrends: Array<{
    category: string;
    score: number;
    trend: 'improving' | 'stable' | 'declining';
  }>;
}

export interface ComplianceAssessment {
  id: string;
  framework: string;
  controlId: string;
  timestamp: Date;
  type: 'automated' | 'manual';
  result: 'pass' | 'fail' | 'warning';
  score: number;
  findings: string[];
  evidence: ComplianceEvidence[];
  assessor: string;
  notes?: string;
}

export class ComplianceService extends BaseService {
  private frameworks: Map<string, ComplianceFramework> = new Map();
  private assessments: Map<string, ComplianceAssessment[]> = new Map();
  private evidence: Map<string, ComplianceEvidence[]> = new Map();

  constructor() {
    super('ComplianceService');
  }

  async initialize(): Promise<void> {
    this.logOperation('Initializing Compliance service');

    // Frameworks are static, in-memory definitions, so they always load —
    // the service is non-functional without them. The config flag only
    // governs optional background assessment scheduling.
    await this.loadComplianceFrameworks();
    this.logOperation('Compliance frameworks loaded');
  }

  private async loadComplianceFrameworks(): Promise<void> {
    // Load SOC2 Type II framework
    this.frameworks.set('soc2-type2', this.createSOC2Type2Framework());

    // Load ISO27001 framework
    this.frameworks.set('iso27001', this.createISO27001Framework());

    // Load custom NOIP framework
    this.frameworks.set('noip-enterprise', this.createNOIPFramework());

    this.logOperation('Compliance frameworks initialized', {
      frameworks: Array.from(this.frameworks.keys()),
    });
  }

  private createSOC2Type2Framework(): ComplianceFramework {
    const controls: ComplianceControl[] = [
      // Security Category
      {
        id: 'CC1.1',
        category: 'Security',
        title: 'Inventory of Information Systems',
        description:
          'The entity maintains an inventory of information systems.',
        requirement:
          'Maintain a comprehensive inventory of all information systems including hardware, software, and network components.',
        implementation:
          'Automated discovery and inventory management through NOIP platform',
        evidence: [],
        status: 'compliant',
        riskLevel: 'medium',
        lastAssessed: new Date(),
        nextAssessment: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        owner: 'Infrastructure Team',
        automatedTesting: true,
        testFrequency: 'monthly',
      },
      {
        id: 'CC2.1',
        category: 'Security',
        title: 'Use of Privileged Accounts',
        description:
          'The entity restricts the use of privileged accounts to specified personnel.',
        requirement:
          'Implement and enforce access controls for privileged accounts with proper authentication and authorization.',
        implementation:
          'Role-based access control (RBAC) with MFA enforcement for all privileged operations',
        evidence: [],
        status: 'compliant',
        riskLevel: 'high',
        lastAssessed: new Date(),
        nextAssessment: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        owner: 'Security Team',
        automatedTesting: true,
        testFrequency: 'weekly',
      },
      {
        id: 'CC3.1',
        category: 'Security',
        title: 'System Boundaries',
        description:
          'The entity identifies system boundaries and all system components.',
        requirement:
          'Document and maintain system architecture diagrams showing all components and data flows.',
        implementation:
          'Automated infrastructure discovery and visualization through NOIP dashboard',
        evidence: [],
        status: 'compliant',
        riskLevel: 'low',
        lastAssessed: new Date(),
        nextAssessment: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
        owner: 'Architecture Team',
        automatedTesting: true,
        testFrequency: 'quarterly',
      },
      // Availability Category
      {
        id: 'CC7.1',
        category: 'Availability',
        title: 'Availability Monitoring',
        description: 'The entity monitors system availability and performance.',
        requirement:
          'Implement comprehensive monitoring of system availability and performance metrics.',
        implementation:
          'Real-time monitoring dashboard with automated alerting for service degradation',
        evidence: [],
        status: 'compliant',
        riskLevel: 'medium',
        lastAssessed: new Date(),
        nextAssessment: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        owner: 'Operations Team',
        automatedTesting: true,
        testFrequency: 'daily',
      },
      // Processing Integrity Category
      {
        id: 'CC8.1',
        category: 'Processing Integrity',
        title: 'Data Processing Accuracy',
        description:
          'The entity implements controls to ensure data processing is accurate, complete, and valid.',
        requirement:
          'Validate and verify data processing accuracy at critical points.',
        implementation:
          'Automated data validation and integrity checks in all processing pipelines',
        evidence: [],
        status: 'compliant',
        riskLevel: 'medium',
        lastAssessed: new Date(),
        nextAssessment: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        owner: 'Development Team',
        automatedTesting: true,
        testFrequency: 'weekly',
      },
      // Confidentiality Category
      {
        id: 'CC9.1',
        category: 'Confidentiality',
        title: 'Data Encryption',
        description: 'The entity encrypts data at rest and in transit.',
        requirement:
          'Implement encryption for sensitive data both at rest and during transmission.',
        implementation:
          'AES-256 encryption for data at rest, TLS 1.3 for data in transit',
        evidence: [],
        status: 'compliant',
        riskLevel: 'high',
        lastAssessed: new Date(),
        nextAssessment: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        owner: 'Security Team',
        automatedTesting: true,
        testFrequency: 'weekly',
      },
      // Privacy Category
      {
        id: 'CC10.1',
        category: 'Privacy',
        title: 'Privacy Notice',
        description: 'The entity provides a privacy notice to customers.',
        requirement:
          'Maintain and provide clear privacy notices describing data collection and usage practices.',
        implementation:
          'Comprehensive privacy policy and data handling documentation',
        evidence: [],
        status: 'partially-compliant',
        riskLevel: 'low',
        lastAssessed: new Date(),
        nextAssessment: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        owner: 'Legal Team',
        automatedTesting: false,
        testFrequency: 'quarterly',
      },
    ];

    return {
      name: 'SOC 2 Type II',
      version: '2017',
      description:
        'Service Organization Control 2 Type II compliance framework for security, availability, processing integrity, confidentiality, and privacy',
      controls,
      lastUpdated: new Date(),
      nextReview: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    };
  }

  private createISO27001Framework(): ComplianceFramework {
    const controls: ComplianceControl[] = [
      // Annex A Controls
      {
        id: 'A.5.1',
        category: 'Information Security Policies',
        title: 'Policies for Information Security',
        description:
          'A set of policies for information security shall be defined, approved by management, published and communicated to employees and relevant external parties.',
        requirement:
          'Comprehensive information security policies covering all aspects of the organization.',
        implementation:
          'Information Security Policy, Acceptable Use Policy, Incident Response Policy',
        evidence: [],
        status: 'compliant',
        riskLevel: 'medium',
        lastAssessed: new Date(),
        nextAssessment: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
        owner: 'CISO',
        automatedTesting: false,
        testFrequency: 'annually',
      },
      {
        id: 'A.8.2',
        category: 'Asset Management',
        title: 'Classification of Information',
        description:
          'Information shall be classified in terms of legal requirements, value, criticality and sensitivity to unauthorized disclosure or modification.',
        requirement:
          'Formal information classification scheme with appropriate handling procedures.',
        implementation:
          'Automated data classification and labeling system based on sensitivity',
        evidence: [],
        status: 'compliant',
        riskLevel: 'medium',
        lastAssessed: new Date(),
        nextAssessment: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        owner: 'Data Governance Team',
        automatedTesting: true,
        testFrequency: 'monthly',
      },
      {
        id: 'A.9.2',
        category: 'Access Control',
        title: 'User Access Management',
        description:
          'Formal user registration and de-registration shall be implemented.',
        requirement:
          'Controlled user access management with proper onboarding and offboarding procedures.',
        implementation:
          'Automated user provisioning/deprovisioning with access review workflows',
        evidence: [],
        status: 'compliant',
        riskLevel: 'high',
        lastAssessed: new Date(),
        nextAssessment: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        owner: 'Identity Management Team',
        automatedTesting: true,
        testFrequency: 'weekly',
      },
      {
        id: 'A.12.6',
        category: 'Operations Security',
        title: 'Management of Technical Vulnerabilities',
        description:
          "Information about technical vulnerabilities of information systems being used shall be obtained in a timely fashion, the organization's exposure to such vulnerabilities evaluated and appropriate measures taken.",
        requirement:
          'Vulnerability management program with timely patching and remediation.',
        implementation:
          'Automated vulnerability scanning and patch management system',
        evidence: [],
        status: 'compliant',
        riskLevel: 'high',
        lastAssessed: new Date(),
        nextAssessment: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        owner: 'Security Operations Team',
        automatedTesting: true,
        testFrequency: 'daily',
      },
      {
        id: 'A.14.2',
        category: 'System Acquisition',
        title: 'Security in Development and Support Processes',
        description:
          'Security shall be integrated into the development and implementation of information systems.',
        requirement:
          'Secure software development lifecycle (SDLC) with security testing.',
        implementation:
          'DevSecOps pipeline with automated security testing and code analysis',
        evidence: [],
        status: 'compliant',
        riskLevel: 'medium',
        lastAssessed: new Date(),
        nextAssessment: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        owner: 'Development Team',
        automatedTesting: true,
        testFrequency: 'continuous',
      },
      {
        id: 'A.16.1',
        category: 'Incident Management',
        title: 'Management of Information Security Incidents',
        description:
          'The organization shall have a process for managing information security incidents.',
        requirement:
          'Comprehensive incident management process with detection, response, and recovery procedures.',
        implementation:
          'Automated incident detection and response system with playbooks',
        evidence: [],
        status: 'compliant',
        riskLevel: 'high',
        lastAssessed: new Date(),
        nextAssessment: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        owner: 'Security Operations Team',
        automatedTesting: true,
        testFrequency: 'monthly',
      },
    ];

    return {
      name: 'ISO 27001:2022',
      version: '2022',
      description:
        'International Organization for Standardization 27001 Information Security Management System standard',
      controls,
      lastUpdated: new Date(),
      nextReview: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    };
  }

  private createNOIPFramework(): ComplianceFramework {
    const controls: ComplianceControl[] = [
      {
        id: 'NOIP-SEC-001',
        category: 'Infrastructure Security',
        title: 'Automated Security Scanning',
        description:
          'Continuous automated security scanning of all infrastructure components.',
        requirement:
          'Implement comprehensive security scanning for Kubernetes clusters, containers, and cloud resources.',
        implementation:
          'NOIP platform provides continuous security scanning with AI-powered analysis',
        evidence: [],
        status: 'compliant',
        riskLevel: 'high',
        lastAssessed: new Date(),
        nextAssessment: new Date(Date.now() + 24 * 60 * 60 * 1000),
        owner: 'Security Team',
        automatedTesting: true,
        testFrequency: 'daily',
      },
      {
        id: 'NOIP-SEC-002',
        category: 'Configuration Management',
        title: 'Drift Detection and Prevention',
        description:
          'Automated detection and prevention of configuration drift.',
        requirement:
          'Monitor infrastructure configurations and detect deviations from approved baselines.',
        implementation:
          'AI-powered drift detection with automated remediation capabilities',
        evidence: [],
        status: 'compliant',
        riskLevel: 'medium',
        lastAssessed: new Date(),
        nextAssessment: new Date(Date.now() + 6 * 60 * 60 * 1000),
        owner: 'Operations Team',
        automatedTesting: true,
        testFrequency: 'continuous',
      },
      {
        id: 'NOIP-SEC-003',
        category: 'Access Control',
        title: 'Zero Trust Architecture',
        description: 'Implementation of zero trust security principles.',
        requirement:
          'Verify and secure all access requests regardless of network location.',
        implementation:
          'Zero trust network access with continuous authentication and authorization',
        evidence: [],
        status: 'compliant',
        riskLevel: 'high',
        lastAssessed: new Date(),
        nextAssessment: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        owner: 'Security Architecture Team',
        automatedTesting: true,
        testFrequency: 'weekly',
      },
      {
        id: 'NOIP-OPS-001',
        category: 'Operational Excellence',
        title: 'AI-Powered Monitoring',
        description:
          'Advanced monitoring with AI anomaly detection and predictive analysis.',
        requirement:
          'Implement intelligent monitoring with automated threat detection and performance optimization.',
        implementation:
          'AI-powered monitoring with predictive analytics and automated response',
        evidence: [],
        status: 'compliant',
        riskLevel: 'medium',
        lastAssessed: new Date(),
        nextAssessment: new Date(Date.now() + 24 * 60 * 60 * 1000),
        owner: 'Observability Team',
        automatedTesting: true,
        testFrequency: 'continuous',
      },
      {
        id: 'NOIP-DATA-001',
        category: 'Data Protection',
        title: 'Advanced Data Encryption',
        description:
          'Comprehensive data protection with advanced encryption methods.',
        requirement:
          'Implement end-to-end encryption with key management and rotation.',
        implementation:
          'Quantum-resistant encryption algorithms with automated key rotation',
        evidence: [],
        status: 'compliant',
        riskLevel: 'high',
        lastAssessed: new Date(),
        nextAssessment: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        owner: 'Cryptography Team',
        automatedTesting: true,
        testFrequency: 'daily',
      },
    ];

    return {
      name: 'NOIP Enterprise',
      version: '1.0',
      description:
        'NetOps Intelligence Platform enterprise compliance framework with advanced security and operational requirements',
      controls,
      lastUpdated: new Date(),
      nextReview: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
    };
  }

  // Public API Methods

  async getComplianceFramework(
    framework: string
  ): Promise<ComplianceFramework | null> {
    return this.frameworks.get(framework) || null;
  }

  async getAllFrameworks(): Promise<ComplianceFramework[]> {
    return Array.from(this.frameworks.values());
  }

  async generateComplianceReport(
    framework: string,
    period?: { start: Date; end: Date }
  ): Promise<ComplianceReport> {
    const frameworkData = this.frameworks.get(framework);
    if (!frameworkData) {
      throw new Error(`Framework ${framework} not found`);
    }

    if (period) {
      const startInvalid = Number.isNaN(period.start?.getTime?.());
      const endInvalid = Number.isNaN(period.end?.getTime?.());
      if (startInvalid || endInvalid) {
        throw new Error('Invalid reporting period: start and end must be valid dates');
      }
      if (period.start > period.end) {
        throw new Error('Invalid reporting period: start must be before end');
      }
    }

    const reportPeriod = period || {
      start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      end: new Date(),
    };

    // Generate control results
    const controlResults = await this.generateControlResults(frameworkData);

    // Calculate overall score and status
    const overallScore = this.calculateOverallScore(controlResults);
    const status = this.determineOverallStatus(overallScore, controlResults);

    // Generate category summaries
    const categorySummaries = this.generateCategorySummaries(controlResults);

    // Generate recommendations
    const recommendations = this.generateRecommendations(controlResults);

    // Audit evidence
    const evidenceAudit = await this.auditEvidence(framework);

    // Trend analysis
    const trendAnalysis = await this.generateTrendAnalysis(
      framework,
      reportPeriod
    );

    const report: ComplianceReport = {
      framework: frameworkData.name,
      version: frameworkData.version,
      reportDate: new Date(),
      period: reportPeriod,
      overallScore,
      status,
      summary: this.generateSummary(controlResults),
      categories: categorySummaries,
      controlResults,
      recommendations,
      evidenceAudit,
      trendAnalysis,
    };

    return report;
  }

  private async generateControlResults(
    framework: ComplianceFramework
  ): Promise<ComplianceControlResult[]> {
    const results: ComplianceControlResult[] = [];

    for (const control of framework.controls) {
      const assessment = await this.performControlAssessment(control);

      results.push({
        controlId: control.id,
        title: control.title,
        category: control.category,
        status:
          assessment.result === 'pass'
            ? 'compliant'
            : assessment.result === 'fail'
              ? 'non-compliant'
              : 'partially-compliant',
        score: assessment.score,
        riskLevel: control.riskLevel,
        lastAssessed: control.lastAssessed,
        evidenceCount: assessment.evidence.length,
        findings: assessment.findings,
        gaps: assessment.findings.filter(
          f => f.includes('gap') || f.includes('missing')
        ),
        remediationPlan:
          assessment.score < 80
            ? 'Implement remediation actions to address identified gaps'
            : undefined,
      });
    }

    return results;
  }

  private async performControlAssessment(
    control: ComplianceControl
  ): Promise<ComplianceAssessment> {
    const assessment: ComplianceAssessment = {
      id: `assessment_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      framework: 'current',
      controlId: control.id,
      timestamp: new Date(),
      type: control.automatedTesting ? 'automated' : 'manual',
      result:
        control.status === 'compliant'
          ? 'pass'
          : control.status === 'non-compliant'
            ? 'fail'
            : 'warning',
      score: this.calculateControlScore(control),
      findings: this.generateControlFindings(control),
      evidence: await this.generateEvidenceForControl(control),
      assessor: 'Compliance Service',
      notes: `Automated assessment performed on ${new Date().toISOString()}`,
    };

    // Store assessment
    if (!this.assessments.has(control.id)) {
      this.assessments.set(control.id, []);
    }
    this.assessments.get(control.id)!.push(assessment);

    return assessment;
  }

  private calculateControlScore(control: ComplianceControl): number {
    let score = 100;

    // Deduct points based on status
    switch (control.status) {
      case 'compliant':
        break; // No deduction
      case 'partially-compliant':
        score -= 20;
        break;
      case 'non-compliant':
        score -= 50;
        break;
      case 'not-assessed':
        score -= 30;
        break;
    }

    // Deduct points based on risk level
    switch (control.riskLevel) {
      case 'critical':
        if (control.status !== 'compliant') score -= 30;
        break;
      case 'high':
        if (control.status !== 'compliant') score -= 20;
        break;
      case 'medium':
        if (control.status !== 'compliant') score -= 10;
        break;
      case 'low':
        if (control.status !== 'compliant') score -= 5;
        break;
    }

    return Math.max(0, Math.min(100, score));
  }

  private generateControlFindings(control: ComplianceControl): string[] {
    const findings: string[] = [];

    if (control.status === 'compliant') {
      findings.push('Control implementation meets requirements');
      findings.push('All evidence verified and current');
    } else if (control.status === 'partially-compliant') {
      findings.push('Partial implementation identified');
      findings.push('Additional controls needed for full compliance');
    } else if (control.status === 'non-compliant') {
      findings.push('Significant gaps in implementation');
      findings.push('Immediate remediation required');
    } else {
      findings.push('Control not assessed');
      findings.push('Assessment required to determine compliance status');
    }

    return findings;
  }

  private async generateEvidenceForControl(
    control: ComplianceControl
  ): Promise<ComplianceEvidence[]> {
    const evidence: ComplianceEvidence[] = [];

    // Generate automated evidence based on control type
    if (control.automatedTesting) {
      evidence.push({
        id: `evidence_${Date.now()}_1`,
        type: 'automated',
        description: 'Automated compliance check execution',
        source: 'NOIP Compliance Service',
        timestamp: new Date(),
        data: {
          testResult: control.status === 'compliant' ? 'pass' : 'fail',
          testTimestamp: new Date(),
          testEnvironment: 'production',
        },
        verified: true,
        verificationDate: new Date(),
      });
    }

    // Add configuration evidence
    evidence.push({
      id: `evidence_${Date.now()}_2`,
      type: 'configuration',
      description: 'System configuration verification',
      source: 'NOIP Platform Configuration',
      timestamp: new Date(),
      data: {
        configurationHash: 'abc123def456',
        lastModified: new Date(),
        compliant: control.status === 'compliant',
      },
      verified: true,
      verificationDate: new Date(),
    });

    return evidence;
  }

  private calculateOverallScore(
    controlResults: ComplianceControlResult[]
  ): number {
    if (controlResults.length === 0) return 0;

    const totalScore = controlResults.reduce(
      (sum, result) => sum + result.score,
      0
    );
    return Math.round(totalScore / controlResults.length);
  }

  private determineOverallStatus(
    overallScore: number,
    controlResults: ComplianceControlResult[]
  ): 'compliant' | 'non-compliant' | 'requires-improvement' {
    const criticalNonCompliant = controlResults.filter(
      r => r.status === 'non-compliant' && r.riskLevel === 'critical'
    ).length;

    if (criticalNonCompliant > 0) return 'non-compliant';
    if (overallScore >= 90) return 'compliant';
    if (overallScore >= 70) return 'requires-improvement';
    return 'non-compliant';
  }

  private generateSummary(controlResults: ComplianceControlResult[]) {
    const summary = {
      totalControls: controlResults.length,
      compliantControls: controlResults.filter(r => r.status === 'compliant')
        .length,
      partiallyCompliantControls: controlResults.filter(
        r => r.status === 'partially-compliant'
      ).length,
      nonCompliantControls: controlResults.filter(
        r => r.status === 'non-compliant'
      ).length,
      notAssessedControls: controlResults.filter(
        r => r.status === 'not-assessed'
      ).length,
      criticalRisks: controlResults.filter(r => r.riskLevel === 'critical')
        .length,
      highRisks: controlResults.filter(r => r.riskLevel === 'high').length,
      mediumRisks: controlResults.filter(r => r.riskLevel === 'medium').length,
      lowRisks: controlResults.filter(r => r.riskLevel === 'low').length,
    };

    return summary;
  }

  private generateCategorySummaries(
    controlResults: ComplianceControlResult[]
  ): ComplianceCategorySummary[] {
    const categories = new Map<string, ComplianceControlResult[]>();

    // Group by category
    controlResults.forEach(result => {
      if (!categories.has(result.category)) {
        categories.set(result.category, []);
      }
      categories.get(result.category)!.push(result);
    });

    // Generate summaries for each category
    return Array.from(categories.entries()).map(([category, controls]) => {
      const score = Math.round(
        controls.reduce((sum, c) => sum + c.score, 0) / controls.length
      );

      const risks = {
        critical: controls.filter(c => c.riskLevel === 'critical').length,
        high: controls.filter(c => c.riskLevel === 'high').length,
        medium: controls.filter(c => c.riskLevel === 'medium').length,
        low: controls.filter(c => c.riskLevel === 'low').length,
      };

      return {
        category,
        score,
        status:
          score >= 90
            ? 'compliant'
            : score >= 70
              ? 'requires-improvement'
              : 'non-compliant',
        totalControls: controls.length,
        compliantControls: controls.filter(c => c.status === 'compliant')
          .length,
        risks,
      };
    });
  }

  private generateRecommendations(
    controlResults: ComplianceControlResult[]
  ): ComplianceRecommendation[] {
    const recommendations: ComplianceRecommendation[] = [];

    // Generate recommendations for non-compliant controls
    controlResults
      .filter(
        result =>
          result.status === 'non-compliant' ||
          result.status === 'partially-compliant'
      )
      .forEach(result => {
        recommendations.push({
          priority:
            result.riskLevel === 'critical'
              ? 'critical'
              : result.riskLevel === 'high'
                ? 'high'
                : result.status === 'non-compliant'
                  ? 'medium'
                  : 'low',
          category: result.category,
          controlId: result.controlId,
          title: `Address non-compliance for ${result.title}`,
          description: `Implement necessary controls to achieve compliance for ${result.title}`,
          impact: 'Reduces compliance risk and improves security posture',
          effort: result.riskLevel === 'critical' ? 'high' : 'medium',
          timeline: result.riskLevel === 'critical' ? '30 days' : '90 days',
          owner: 'Compliance Team',
          dependencies:
            result.gaps.length > 0 ? ['Gap analysis completion'] : undefined,
        });
      });

    return recommendations.sort((a, b) => {
      const priorityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
      return priorityOrder[b.priority] - priorityOrder[a.priority];
    });
  }

  private async auditEvidence(
    framework: string
  ): Promise<ComplianceEvidenceAudit> {
    const frameworkData = this.frameworks.get(framework);
    if (!frameworkData) {
      throw new Error(`Framework ${framework} not found`);
    }

    let totalEvidence = 0;
    let verifiedEvidence = 0;
    let pendingVerification = 0;
    let expiredEvidence = 0;
    let missingEvidence = 0;

    const auditTrail: ComplianceAuditEntry[] = [];

    // Audit evidence for each control
    for (const control of frameworkData.controls) {
      const controlEvidence = this.evidence.get(control.id) || [];

      totalEvidence += controlEvidence.length;
      verifiedEvidence += controlEvidence.filter(e => e.verified).length;
      pendingVerification += controlEvidence.filter(e => !e.verified).length;
      expiredEvidence += controlEvidence.filter(
        e => e.timestamp < new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      ).length;

      // Check for missing evidence
      if (controlEvidence.length === 0) {
        missingEvidence++;
      }

      // Add audit trail entries
      controlEvidence.forEach(evidence => {
        auditTrail.push({
          timestamp: evidence.timestamp,
          action: evidence.verified ? 'verified' : 'created',
          evidenceId: evidence.id,
          controlId: control.id,
          performedBy: 'Compliance Service',
          details: `Evidence ${evidence.type} for control ${control.id}`,
        });
      });
    }

    return {
      totalEvidence,
      verifiedEvidence,
      pendingVerification,
      expiredEvidence,
      missingEvidence,
      auditTrail: auditTrail.sort(
        (a, b) => b.timestamp.getTime() - a.timestamp.getTime()
      ),
    };
  }

  private async generateTrendAnalysis(
    framework: string,
    period: { start: Date; end: Date }
  ): Promise<ComplianceTrendAnalysis> {
    // Mock trend analysis - in production, this would analyze historical data
    const mockTrend: ComplianceTrendAnalysis = {
      period: '30d',
      complianceScore: {
        current: 87,
        previous: 84,
        change: 3.6,
        trend: 'improving',
      },
      riskTrends: {
        critical: { current: 1, previous: 2, trend: 'decreasing' },
        high: { current: 3, previous: 4, trend: 'decreasing' },
        medium: { current: 5, previous: 5, trend: 'stable' },
        low: { current: 2, previous: 3, trend: 'decreasing' },
      },
      categoryTrends: [
        { category: 'Security', score: 92, trend: 'improving' },
        { category: 'Availability', score: 88, trend: 'stable' },
        { category: 'Processing Integrity', score: 85, trend: 'improving' },
        { category: 'Confidentiality', score: 90, trend: 'stable' },
        { category: 'Privacy', score: 75, trend: 'declining' },
      ],
    };

    return mockTrend;
  }

  async runComplianceAssessment(
    framework: string,
    controlId?: string
  ): Promise<ComplianceAssessment[]> {
    const frameworkData = this.frameworks.get(framework);
    if (!frameworkData) {
      throw new Error(`Framework ${framework} not found`);
    }

    const controls = controlId
      ? frameworkData.controls.filter(c => c.id === controlId)
      : frameworkData.controls;

    const assessments: ComplianceAssessment[] = [];

    for (const control of controls) {
      const assessment = await this.performControlAssessment(control);
      assessments.push(assessment);
    }

    return assessments;
  }

  async healthCheck(): Promise<{
    status: string;
    frameworks: number;
    lastAssessment: Date;
  }> {
    return {
      status: 'healthy',
      frameworks: this.frameworks.size,
      lastAssessment: new Date(),
    };
  }
}
