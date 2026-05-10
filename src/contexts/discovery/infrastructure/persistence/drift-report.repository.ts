// DriftReport repository — Mongoose-backed.

import type { Model } from 'mongoose';
import type { ClusterId, DriftId } from '../../../../shared/kernel';
import { DriftReport } from '../../domain/drift-report';
import type { DriftReportPersistence } from '../../domain/drift-report';
import { DriftReportModel as DefaultModel } from './drift-report.schema';

export interface DriftReportRepository {
  save(report: DriftReport): Promise<void>;
  findById(id: DriftId): Promise<DriftReport | null>;
  listByCluster(clusterId: ClusterId, limit?: number): Promise<DriftReport[]>;
}

export class MongooseDriftReportRepository implements DriftReportRepository {
  constructor(
    private readonly model: Model<DriftReportPersistence> = DefaultModel
  ) {}

  async save(report: DriftReport): Promise<void> {
    const doc = report.toPersistence();
    await this.model.updateOne({ id: doc.id }, { $set: doc }, { upsert: true });
  }

  async findById(id: DriftId): Promise<DriftReport | null> {
    const doc = await this.model
      .findOne({ id })
      .lean<DriftReportPersistence>()
      .exec();
    return doc ? DriftReport.fromPersistence(doc) : null;
  }

  async listByCluster(
    clusterId: ClusterId,
    limit = 50
  ): Promise<DriftReport[]> {
    const docs = await this.model
      .find({ clusterId })
      .sort({ detectedAt: -1 })
      .limit(limit)
      .lean<DriftReportPersistence[]>()
      .exec();
    return docs.map((d) => DriftReport.fromPersistence(d));
  }
}
