// SLO repository — Mongoose-backed + in-memory variant for tests.

import type { Model } from 'mongoose';
import type { SLOId } from '../../../../shared/kernel';
import { SLO } from '../../domain/slo';
import type { SLOPersistence } from '../../domain/slo';
import { SLOModel as DefaultModel } from './slo.schema';

export interface SLORepository {
  save(slo: SLO): Promise<void>;
  saveMany(slos: ReadonlyArray<SLO>): Promise<void>;
  findById(id: SLOId): Promise<SLO | null>;
  list(limit?: number): Promise<SLO[]>;
}

export class MongooseSLORepository implements SLORepository {
  constructor(private readonly model: Model<SLOPersistence> = DefaultModel) {}

  async save(slo: SLO): Promise<void> {
    const doc = slo.toPersistence();
    await this.model.updateOne({ id: doc.id }, { $set: doc }, { upsert: true });
  }

  /**
   * Bulk upsert. We use `bulkWrite` so the SLOComputer can flush a
   * whole batch of fresh observations in a single round-trip.
   */
  async saveMany(slos: ReadonlyArray<SLO>): Promise<void> {
    if (slos.length === 0) return;
    await this.model.bulkWrite(
      slos.map(s => {
        const doc = s.toPersistence();
        return {
          updateOne: {
            filter: { id: doc.id },
            update: { $set: doc },
            upsert: true,
          },
        };
      }),
      { ordered: false }
    );
  }

  async findById(id: SLOId): Promise<SLO | null> {
    const doc = await this.model.findOne({ id }).lean<SLOPersistence>().exec();
    return doc ? SLO.fromPersistence(doc) : null;
  }

  async list(limit = 100): Promise<SLO[]> {
    const docs = await this.model
      .find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean<SLOPersistence[]>()
      .exec();
    return docs.map(d => SLO.fromPersistence(d));
  }
}

/** In-memory implementation for tests. */
export class InMemorySLORepository implements SLORepository {
  private readonly slos = new Map<string, SLOPersistence>();

  async save(slo: SLO): Promise<void> {
    this.slos.set(slo.id, slo.toPersistence());
  }
  async saveMany(slos: ReadonlyArray<SLO>): Promise<void> {
    for (const s of slos) await this.save(s);
  }
  async findById(id: SLOId): Promise<SLO | null> {
    const doc = this.slos.get(id);
    return doc ? SLO.fromPersistence(doc) : null;
  }
  async list(limit = 100): Promise<SLO[]> {
    return Array.from(this.slos.values())
      .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1))
      .slice(0, limit)
      .map(d => SLO.fromPersistence(d));
  }
}
