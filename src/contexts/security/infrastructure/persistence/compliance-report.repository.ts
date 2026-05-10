// ComplianceReport repository — Mongoose-backed.

import type { Model } from 'mongoose';
import type { ReportId } from '../../../../shared/kernel';
import { ComplianceReport } from '../../domain/compliance-report';
import type { ComplianceReportPersistence } from '../../domain/compliance-report';
import type { ComplianceFramework, Scope } from '../../domain/value-objects';
import { ComplianceReportModel as DefaultModel } from './compliance-report.schema';

export interface ComplianceReportRepository {
  save(report: ComplianceReport): Promise<void>;
  findById(id: ReportId): Promise<ComplianceReport | null>;
  list(
    framework?: ComplianceFramework,
    scope?: Scope
  ): Promise<ComplianceReport[]>;
}

export class MongooseComplianceReportRepository
  implements ComplianceReportRepository
{
  constructor(
    private readonly model: Model<ComplianceReportPersistence> = DefaultModel
  ) {}
  async save(report: ComplianceReport): Promise<void> {
    const doc = report.toPersistence();
    await this.model.updateOne({ id: doc.id }, { $set: doc }, { upsert: true });
  }
  async findById(id: ReportId): Promise<ComplianceReport | null> {
    const doc = await this.model
      .findOne({ id })
      .lean<ComplianceReportPersistence>()
      .exec();
    return doc ? ComplianceReport.fromPersistence(doc) : null;
  }
  async list(
    framework?: ComplianceFramework,
    scope?: Scope
  ): Promise<ComplianceReport[]> {
    const q: Record<string, unknown> = {};
    if (framework !== undefined) q['framework'] = framework;
    if (scope?.clusterId !== undefined) {
      q['scope.clusterId'] = scope.clusterId;
    }
    const docs = await this.model
      .find(q)
      .sort({ generatedAt: -1 })
      .lean<ComplianceReportPersistence[]>()
      .exec();
    return docs.map(d => ComplianceReport.fromPersistence(d));
  }
}

export class InMemoryComplianceReportRepository
  implements ComplianceReportRepository
{
  private readonly reports = new Map<string, ComplianceReportPersistence>();
  async save(report: ComplianceReport): Promise<void> {
    this.reports.set(report.id, report.toPersistence());
  }
  async findById(id: ReportId): Promise<ComplianceReport | null> {
    const doc = this.reports.get(id);
    return doc ? ComplianceReport.fromPersistence(doc) : null;
  }
  async list(
    framework?: ComplianceFramework,
    scope?: Scope
  ): Promise<ComplianceReport[]> {
    return Array.from(this.reports.values())
      .filter(d => {
        if (framework !== undefined && d.framework !== framework) return false;
        if (
          scope?.clusterId !== undefined &&
          d.scope.clusterId !== scope.clusterId
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => (a.generatedAt > b.generatedAt ? -1 : 1))
      .map(d => ComplianceReport.fromPersistence(d));
  }
}
