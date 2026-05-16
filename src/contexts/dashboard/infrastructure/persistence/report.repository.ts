// Report repository — Mongoose-backed plus an in-memory variant for
// tests / dev. Reports are append-only from the repository's point of
// view: once written the row is mutable only via `markGenerated` /
// `markFailed`, both of which are state transitions, never edits to
// the artifact reference.

import type { Model } from 'mongoose';
import type { ReportId, UserId } from '../../../../shared/kernel';
import { Report, type ReportPersistence } from '../../domain/report';
import type { Format, ReportKind } from '../../domain/value-objects';
import { ReportModel as DefaultModel } from './report.schema';

export interface ReportListFilter {
  kind?: ReportKind;
  format?: Format;
  generatedBy?: UserId;
  limit?: number;
}

export interface ReportRepository {
  save(report: Report): Promise<void>;
  findById(id: ReportId): Promise<Report | null>;
  list(filter?: ReportListFilter): Promise<Report[]>;
  delete(id: ReportId): Promise<boolean>;
}

export class MongooseReportRepository implements ReportRepository {
  constructor(
    private readonly model: Model<ReportPersistence> = DefaultModel
  ) {}

  async save(report: Report): Promise<void> {
    const doc = report.toPersistence();
    await this.model.updateOne({ id: doc.id }, { $set: doc }, { upsert: true });
  }

  async findById(id: ReportId): Promise<Report | null> {
    const doc = await this.model
      .findOne({ id })
      .lean<ReportPersistence>()
      .exec();
    return doc ? Report.fromPersistence(doc) : null;
  }

  async list(filter: ReportListFilter = {}): Promise<Report[]> {
    const q: Record<string, unknown> = {};
    if (filter.kind) q['kind'] = filter.kind;
    if (filter.format) q['format'] = filter.format;
    if (filter.generatedBy) q['generatedBy.userId'] = filter.generatedBy;
    const docs = await this.model
      .find(q)
      .sort({ generatedAt: -1 })
      .limit(filter.limit ?? 50)
      .lean<ReportPersistence[]>()
      .exec();
    return docs.map(d => Report.fromPersistence(d));
  }

  async delete(id: ReportId): Promise<boolean> {
    const r = await this.model.deleteOne({ id }).exec();
    return r.deletedCount > 0;
  }
}

export class InMemoryReportRepository implements ReportRepository {
  private readonly store = new Map<string, ReportPersistence>();

  async save(report: Report): Promise<void> {
    this.store.set(report.id, report.toPersistence());
  }

  async findById(id: ReportId): Promise<Report | null> {
    const doc = this.store.get(id);
    return doc ? Report.fromPersistence(doc) : null;
  }

  async list(filter: ReportListFilter = {}): Promise<Report[]> {
    let rows = Array.from(this.store.values());
    if (filter.kind) rows = rows.filter(r => r.kind === filter.kind);
    if (filter.format) rows = rows.filter(r => r.format === filter.format);
    if (filter.generatedBy) {
      rows = rows.filter(r => r.generatedBy.userId === filter.generatedBy);
    }
    return rows
      .sort((a, b) => {
        const av = a.generatedAt ?? '';
        const bv = b.generatedAt ?? '';
        return av > bv ? -1 : 1;
      })
      .slice(0, filter.limit ?? 50)
      .map(d => Report.fromPersistence(d));
  }

  async delete(id: ReportId): Promise<boolean> {
    return this.store.delete(id);
  }
}
