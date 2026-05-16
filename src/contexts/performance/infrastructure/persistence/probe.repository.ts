// Probe repository — Mongoose-backed + in-memory variant for tests.

import type { Model } from 'mongoose';
import type { ProbeId } from '../../../../shared/kernel';
import { Probe } from '../../domain/probe';
import type { ProbePersistence } from '../../domain/probe';
import { ProbeModel as DefaultModel } from './probe.schema';

export interface ProbeRepository {
  save(probe: Probe): Promise<void>;
  findById(id: ProbeId): Promise<Probe | null>;
  list(limit?: number): Promise<Probe[]>;
  listEnabled(): Promise<Probe[]>;
  delete(id: ProbeId): Promise<boolean>;
}

export class MongooseProbeRepository implements ProbeRepository {
  constructor(private readonly model: Model<ProbePersistence> = DefaultModel) {}

  async save(probe: Probe): Promise<void> {
    const doc = probe.toPersistence();
    await this.model.updateOne({ id: doc.id }, { $set: doc }, { upsert: true });
  }

  async findById(id: ProbeId): Promise<Probe | null> {
    const doc = await this.model
      .findOne({ id })
      .lean<ProbePersistence>()
      .exec();
    return doc ? Probe.fromPersistence(doc) : null;
  }

  async list(limit = 100): Promise<Probe[]> {
    const docs = await this.model
      .find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean<ProbePersistence[]>()
      .exec();
    return docs.map(d => Probe.fromPersistence(d));
  }

  async listEnabled(): Promise<Probe[]> {
    const docs = await this.model
      .find({ enabled: true })
      .lean<ProbePersistence[]>()
      .exec();
    return docs.map(d => Probe.fromPersistence(d));
  }

  async delete(id: ProbeId): Promise<boolean> {
    const r = await this.model.deleteOne({ id }).exec();
    return r.deletedCount === 1;
  }
}

/** In-memory implementation for tests. */
export class InMemoryProbeRepository implements ProbeRepository {
  private readonly probes = new Map<string, ProbePersistence>();

  async save(probe: Probe): Promise<void> {
    this.probes.set(probe.id, probe.toPersistence());
  }
  async findById(id: ProbeId): Promise<Probe | null> {
    const doc = this.probes.get(id);
    return doc ? Probe.fromPersistence(doc) : null;
  }
  async list(limit = 100): Promise<Probe[]> {
    return Array.from(this.probes.values())
      .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1))
      .slice(0, limit)
      .map(d => Probe.fromPersistence(d));
  }
  async listEnabled(): Promise<Probe[]> {
    return Array.from(this.probes.values())
      .filter(d => d.enabled)
      .map(d => Probe.fromPersistence(d));
  }
  async delete(id: ProbeId): Promise<boolean> {
    return this.probes.delete(id);
  }
}
