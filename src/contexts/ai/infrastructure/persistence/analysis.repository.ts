// Analysis repository — Mongoose-backed + in-memory fallback for tests.

import type { Model } from 'mongoose';
import type { AnalysisId, ClusterId } from '../../../../shared/kernel';
import { Analysis, type AnalysisPersistence } from '../../domain/analysis';
import { AnalysisModel as DefaultModel } from './analysis.schema';
import type { AnalysisType, Scope } from '../../domain/value-objects';

export interface AnalysisRepository {
  save(analysis: Analysis): Promise<void>;
  findById(id: AnalysisId): Promise<Analysis | null>;
  listLatestByScope(
    scope: Scope,
    type?: AnalysisType,
    limit?: number
  ): Promise<Analysis[]>;
}

export class MongooseAnalysisRepository implements AnalysisRepository {
  constructor(
    private readonly model: Model<AnalysisPersistence> = DefaultModel
  ) {}

  async save(analysis: Analysis): Promise<void> {
    const doc = analysis.toPersistence();
    await this.model.updateOne({ id: doc.id }, { $set: doc }, { upsert: true });
  }

  async findById(id: AnalysisId): Promise<Analysis | null> {
    const doc = await this.model
      .findOne({ id })
      .lean<AnalysisPersistence>()
      .exec();
    return doc ? Analysis.fromPersistence(doc) : null;
  }

  async listLatestByScope(
    scope: Scope,
    type?: AnalysisType,
    limit = 25
  ): Promise<Analysis[]> {
    const q: Record<string, unknown> = {
      'scope.clusterId': scope.clusterId,
    };
    if (scope.namespace) q['scope.namespace'] = scope.namespace;
    if (type) q['type'] = type;
    const docs = await this.model
      .find(q)
      .sort({ completedAt: -1, requestedAt: -1 })
      .limit(limit)
      .lean<AnalysisPersistence[]>()
      .exec();
    return docs.map(d => Analysis.fromPersistence(d));
  }
}

export class InMemoryAnalysisRepository implements AnalysisRepository {
  private readonly rows = new Map<string, AnalysisPersistence>();

  async save(analysis: Analysis): Promise<void> {
    this.rows.set(analysis.id, analysis.toPersistence());
  }

  async findById(id: AnalysisId): Promise<Analysis | null> {
    const doc = this.rows.get(id);
    return doc ? Analysis.fromPersistence(doc) : null;
  }

  async listLatestByScope(
    scope: Scope,
    type?: AnalysisType,
    limit = 25
  ): Promise<Analysis[]> {
    const filtered = Array.from(this.rows.values()).filter(d => {
      if ((d.scope.clusterId as ClusterId) !== scope.clusterId) return false;
      if (scope.namespace && d.scope.namespace !== scope.namespace)
        return false;
      if (type && d.type !== type) return false;
      return true;
    });
    filtered.sort((a, b) => {
      const aT = a.completedAt ?? a.requestedAt;
      const bT = b.completedAt ?? b.requestedAt;
      return bT > aT ? 1 : bT < aT ? -1 : 0;
    });
    return filtered.slice(0, limit).map(d => Analysis.fromPersistence(d));
  }
}
