// ProbeResult repository — Mongoose-backed + in-memory variant.
//
// Bulk writes go through `insertMany` per the DDD-09 performance
// optimisation (avoid N round-trips when the runner records a batch).

import type { Model } from 'mongoose';
import type { ProbeId } from '../../../../shared/kernel';
import { ProbeResult } from '../../domain/probe-result';
import type { ProbeResultPersistence } from '../../domain/probe-result';
import { ProbeResultModel as DefaultModel } from './probe-result.schema';

export interface ProbeResultListFilter {
  from?: Date;
  to?: Date;
  limit?: number;
}

export interface ProbeResultRepository {
  saveMany(results: ReadonlyArray<ProbeResult>): Promise<void>;
  save(result: ProbeResult): Promise<void>;
  listByProbe(
    probeId: ProbeId,
    filter?: ProbeResultListFilter
  ): Promise<ProbeResult[]>;
}

export class MongooseProbeResultRepository implements ProbeResultRepository {
  constructor(
    private readonly model: Model<ProbeResultPersistence> = DefaultModel
  ) {}

  async saveMany(results: ReadonlyArray<ProbeResult>): Promise<void> {
    if (results.length === 0) return;
    const docs = results.map(r => toDoc(r));
    // ordered: false — failures on individual docs don't abort the batch.
    await this.model.insertMany(docs, { ordered: false });
  }

  async save(result: ProbeResult): Promise<void> {
    const doc = toDoc(result);
    await this.model.updateOne({ id: doc.id }, { $set: doc }, { upsert: true });
  }

  async listByProbe(
    probeId: ProbeId,
    filter: ProbeResultListFilter = {}
  ): Promise<ProbeResult[]> {
    const q: Record<string, unknown> = { probeId };
    if (filter.from || filter.to) {
      const r: Record<string, Date> = {};
      if (filter.from) r['$gte'] = filter.from;
      if (filter.to) r['$lte'] = filter.to;
      q['at'] = r;
    }
    const docs = await this.model
      .find(q)
      .sort({ at: -1 })
      .limit(filter.limit ?? 1000)
      .lean<ProbeResultPersistence[]>()
      .exec();
    return docs.map(d => ProbeResult.fromPersistence(fromMongo(d)));
  }
}

function toDoc(
  r: ProbeResult
): Omit<ProbeResultPersistence, 'at'> & { at: Date } {
  const p = r.toPersistence();
  return { ...p, at: new Date(p.at) };
}

function fromMongo(
  d: ProbeResultPersistence & { at: string | Date }
): ProbeResultPersistence {
  const at: unknown = d.at;
  return {
    ...d,
    at: at instanceof Date ? (at as Date).toISOString() : (at as string),
  };
}

/** In-memory implementation for tests. */
export class InMemoryProbeResultRepository implements ProbeResultRepository {
  private readonly results: ProbeResultPersistence[] = [];

  async saveMany(results: ReadonlyArray<ProbeResult>): Promise<void> {
    for (const r of results) this.results.push(r.toPersistence());
  }
  async save(result: ProbeResult): Promise<void> {
    this.results.push(result.toPersistence());
  }
  async listByProbe(
    probeId: ProbeId,
    filter: ProbeResultListFilter = {}
  ): Promise<ProbeResult[]> {
    const all = this.results
      .filter(d => d.probeId === probeId)
      .filter(d => {
        if (filter.from && new Date(d.at) < filter.from) return false;
        if (filter.to && new Date(d.at) > filter.to) return false;
        return true;
      })
      .sort((a, b) => (a.at > b.at ? -1 : 1))
      .slice(0, filter.limit ?? 1000);
    return all.map(d => ProbeResult.fromPersistence(d));
  }

  /** Test helper: how many rows we've stored. */
  size(): number {
    return this.results.length;
  }
}
