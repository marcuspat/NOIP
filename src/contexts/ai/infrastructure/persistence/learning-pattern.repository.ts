// LearningPattern repository — Mongoose-backed + in-memory fallback.

import type { Model } from 'mongoose';
import type { PatternId } from '../../../../shared/kernel';
import {
  LearningPattern,
  type LearningPatternPersistence,
} from '../../domain/learning-pattern';
import { LearningPatternModel as DefaultModel } from './learning-pattern.schema';

export interface LearningPatternRepository {
  save(pattern: LearningPattern): Promise<void>;
  findById(id: PatternId): Promise<LearningPattern | null>;
  findBySignature(
    signature: string,
    type?: string
  ): Promise<LearningPattern | null>;
  listByType(type: string, limit?: number): Promise<LearningPattern[]>;
}

export class MongooseLearningPatternRepository
  implements LearningPatternRepository
{
  constructor(
    private readonly model: Model<LearningPatternPersistence> = DefaultModel
  ) {}

  async save(pattern: LearningPattern): Promise<void> {
    const doc = pattern.toPersistence();
    await this.model.updateOne({ id: doc.id }, { $set: doc }, { upsert: true });
  }

  async findById(id: PatternId): Promise<LearningPattern | null> {
    const doc = await this.model
      .findOne({ id })
      .lean<LearningPatternPersistence>()
      .exec();
    return doc ? LearningPattern.fromPersistence(doc) : null;
  }

  async findBySignature(
    signature: string,
    type?: string
  ): Promise<LearningPattern | null> {
    const q: Record<string, unknown> = { signature };
    if (type) q['type'] = type;
    const doc = await this.model
      .findOne(q)
      .lean<LearningPatternPersistence>()
      .exec();
    return doc ? LearningPattern.fromPersistence(doc) : null;
  }

  async listByType(type: string, limit = 50): Promise<LearningPattern[]> {
    const docs = await this.model
      .find({ type, deprecatedAt: null })
      .sort({ confidence: -1 })
      .limit(limit)
      .lean<LearningPatternPersistence[]>()
      .exec();
    return docs.map(d => LearningPattern.fromPersistence(d));
  }
}

export class InMemoryLearningPatternRepository
  implements LearningPatternRepository
{
  private readonly rows = new Map<string, LearningPatternPersistence>();

  async save(pattern: LearningPattern): Promise<void> {
    this.rows.set(pattern.id, pattern.toPersistence());
  }
  async findById(id: PatternId): Promise<LearningPattern | null> {
    const d = this.rows.get(id);
    return d ? LearningPattern.fromPersistence(d) : null;
  }
  async findBySignature(
    signature: string,
    type?: string
  ): Promise<LearningPattern | null> {
    for (const d of this.rows.values()) {
      if (d.signature !== signature) continue;
      if (type && d.type !== type) continue;
      return LearningPattern.fromPersistence(d);
    }
    return null;
  }
  async listByType(type: string, limit = 50): Promise<LearningPattern[]> {
    return Array.from(this.rows.values())
      .filter(d => d.type === type && d.deprecatedAt === null)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, limit)
      .map(d => LearningPattern.fromPersistence(d));
  }
}
