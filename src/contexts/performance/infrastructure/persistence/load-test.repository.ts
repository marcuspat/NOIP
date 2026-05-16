// LoadTest repository — Mongoose-backed + in-memory variant for tests.

import type { Model } from 'mongoose';
import type { LoadTestId } from '../../../../shared/kernel';
import { LoadTest } from '../../domain/load-test';
import type { LoadTestPersistence } from '../../domain/load-test';
import { LoadTestModel as DefaultModel } from './load-test.schema';

export interface LoadTestRepository {
  save(test: LoadTest): Promise<void>;
  findById(id: LoadTestId): Promise<LoadTest | null>;
  listRecent(limit?: number): Promise<LoadTest[]>;
}

export class MongooseLoadTestRepository implements LoadTestRepository {
  constructor(
    private readonly model: Model<LoadTestPersistence> = DefaultModel
  ) {}

  async save(test: LoadTest): Promise<void> {
    const doc = test.toPersistence();
    await this.model.updateOne({ id: doc.id }, { $set: doc }, { upsert: true });
  }

  async findById(id: LoadTestId): Promise<LoadTest | null> {
    const doc = await this.model
      .findOne({ id })
      .lean<LoadTestPersistence>()
      .exec();
    return doc ? LoadTest.fromPersistence(doc) : null;
  }

  async listRecent(limit = 50): Promise<LoadTest[]> {
    const docs = await this.model
      .find({})
      .sort({ startedAt: -1 })
      .limit(limit)
      .lean<LoadTestPersistence[]>()
      .exec();
    return docs.map(d => LoadTest.fromPersistence(d));
  }
}

/** In-memory implementation for tests. */
export class InMemoryLoadTestRepository implements LoadTestRepository {
  private readonly tests = new Map<string, LoadTestPersistence>();

  async save(test: LoadTest): Promise<void> {
    this.tests.set(test.id, test.toPersistence());
  }
  async findById(id: LoadTestId): Promise<LoadTest | null> {
    const doc = this.tests.get(id);
    return doc ? LoadTest.fromPersistence(doc) : null;
  }
  async listRecent(limit = 50): Promise<LoadTest[]> {
    return Array.from(this.tests.values())
      .sort((a, b) => (a.startedAt > b.startedAt ? -1 : 1))
      .slice(0, limit)
      .map(d => LoadTest.fromPersistence(d));
  }
}
