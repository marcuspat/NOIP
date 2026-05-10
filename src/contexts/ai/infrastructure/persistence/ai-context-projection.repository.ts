// AIContext projection repository — Mongoose-backed + in-memory fallback.

import type { Model } from 'mongoose';
import type { ContextId } from '../../../../shared/kernel';
import { AIContext, type AIContextPersistence } from '../../domain/ai-context';
import { AIContextProjectionModel as DefaultModel } from './ai-context-projection.schema';

export interface AIContextProjectionRepository {
  upsert(context: AIContext): Promise<void>;
  findById(id: ContextId): Promise<AIContext | null>;
  listByType(type: string, limit?: number): Promise<AIContext[]>;
}

export class MongooseAIContextProjectionRepository
  implements AIContextProjectionRepository
{
  constructor(
    private readonly model: Model<AIContextPersistence> = DefaultModel
  ) {}

  async upsert(context: AIContext): Promise<void> {
    const doc = context.toPersistence();
    await this.model.updateOne({ id: doc.id }, { $set: doc }, { upsert: true });
  }

  async findById(id: ContextId): Promise<AIContext | null> {
    const doc = await this.model
      .findOne({ id })
      .lean<AIContextPersistence>()
      .exec();
    return doc ? AIContext.fromPersistence(doc) : null;
  }

  async listByType(type: string, limit = 50): Promise<AIContext[]> {
    const docs = await this.model
      .find({ type })
      .sort({ ingestedAt: -1 })
      .limit(limit)
      .lean<AIContextPersistence[]>()
      .exec();
    return docs.map(d => AIContext.fromPersistence(d));
  }
}

export class InMemoryAIContextProjectionRepository
  implements AIContextProjectionRepository
{
  private readonly rows = new Map<string, AIContextPersistence>();

  async upsert(context: AIContext): Promise<void> {
    this.rows.set(context.id, context.toPersistence());
  }
  async findById(id: ContextId): Promise<AIContext | null> {
    const d = this.rows.get(id);
    return d ? AIContext.fromPersistence(d) : null;
  }
  async listByType(type: string, limit = 50): Promise<AIContext[]> {
    return Array.from(this.rows.values())
      .filter(d => d.type === type)
      .sort((a, b) => (b.ingestedAt > a.ingestedAt ? 1 : -1))
      .slice(0, limit)
      .map(d => AIContext.fromPersistence(d));
  }
}
