// ComplianceService — application service for the Compliance side of
// DDD-07. Reports are *derived* from findings + policies as of
// `generatedAt`. Once signed they are immutable; regenerations
// produce new report IDs.

import type { Clock, EventBus, ReportId, UserId } from '../../../shared/kernel';
import { NotFoundError, ValidationError } from '../../../shared/errors';
import { ComplianceMapper } from '../domain/compliance-mapper';
import type { ControlDefinition } from '../domain/compliance-mapper';
import { ComplianceReport } from '../domain/compliance-report';
import type { ComplianceFramework, Scope } from '../domain/value-objects';
import type { FindingRepository } from '../infrastructure/persistence/finding.repository';
import type { SecurityPolicyRepository } from '../infrastructure/persistence/security-policy.repository';
import type { ComplianceReportRepository } from '../infrastructure/persistence/compliance-report.repository';

export interface ComplianceServiceLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

const NOOP_LOGGER: ComplianceServiceLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface ComplianceServiceDeps {
  findings: FindingRepository;
  policies: SecurityPolicyRepository;
  reports: ComplianceReportRepository;
  bus: EventBus;
  clock: Clock;
  mapper?: ComplianceMapper;
  logger?: ComplianceServiceLogger;
}

export class ComplianceService {
  private readonly findings: FindingRepository;
  private readonly policies: SecurityPolicyRepository;
  private readonly reports: ComplianceReportRepository;
  private readonly bus: EventBus;
  private readonly clock: Clock;
  private readonly mapper: ComplianceMapper;
  private readonly logger: ComplianceServiceLogger;

  constructor(deps: ComplianceServiceDeps) {
    this.findings = deps.findings;
    this.policies = deps.policies;
    this.reports = deps.reports;
    this.bus = deps.bus;
    this.clock = deps.clock;
    this.mapper = deps.mapper ?? new ComplianceMapper();
    this.logger = deps.logger ?? NOOP_LOGGER;
  }

  /**
   * Generate a fresh `ComplianceReport`. Reads the live findings and
   * policy catalogue, runs the mapper, persists the report.
   */
  async generateReport(
    framework: ComplianceFramework,
    scope: Scope
  ): Promise<ComplianceReport> {
    const [findings, policies] = await Promise.all([
      this.findings.list(scope, { limit: 5000 }),
      this.policies.listAll(),
    ]);
    const { controls, overall } = this.mapper.assess({
      framework,
      scope,
      findings,
      policies: policies.map(p => ({ id: p.id, name: p.name })),
    });
    const report = ComplianceReport.generate(
      { framework, scope, controls, overall },
      this.clock
    );
    await this.reports.save(report);
    this.bus.publishMany(report.drainEvents());
    return report;
  }

  async signReport(id: ReportId, by: UserId): Promise<ComplianceReport> {
    const report = await this.reports.findById(id);
    if (!report) throw new NotFoundError('ComplianceReport', id);
    if (report.isImmutable()) {
      throw new ValidationError('report already signed', { reportId: id });
    }
    report.sign(by, this.clock);
    await this.reports.save(report);
    this.bus.publishMany(report.drainEvents());
    return report;
  }

  async listReports(
    framework?: ComplianceFramework,
    scope?: Scope
  ): Promise<ComplianceReport[]> {
    return this.reports.list(framework, scope);
  }

  async getReport(id: ReportId): Promise<ComplianceReport> {
    const r = await this.reports.findById(id);
    if (!r) throw new NotFoundError('ComplianceReport', id);
    return r;
  }

  listFrameworks(): ComplianceFramework[] {
    return this.mapper.listFrameworks();
  }

  listControls(framework: ComplianceFramework): ControlDefinition[] {
    return this.mapper.listControls(framework);
  }

  async healthCheck(): Promise<{
    status: string;
    frameworks: number;
    lastAssessment: Date;
  }> {
    return {
      status: 'healthy',
      frameworks: this.listFrameworks().length,
      lastAssessment: this.clock.now(),
    };
  }

  async initialize(): Promise<void> {
    this.logger.info('ComplianceService initialised');
  }

  async stop(): Promise<void> {
    this.logger.info('ComplianceService stopped');
  }
}
