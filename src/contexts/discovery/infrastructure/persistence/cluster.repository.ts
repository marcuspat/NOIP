// Cluster repository — Mongoose-backed.
//
// Wraps `ClusterModel` with the domain-friendly contract the
// application service consumes. The contract sits next to the
// implementation because the discovery context is the only consumer.

import type { Model } from 'mongoose';
import type { ClusterId } from '../../../../shared/kernel';
import { Cluster } from '../../domain/cluster';
import type { ClusterPersistence } from '../../domain/cluster';
import { ClusterModel as DefaultModel } from './cluster.schema';

export interface ClusterRepository {
  save(cluster: Cluster): Promise<void>;
  findById(id: ClusterId): Promise<Cluster | null>;
  findAll(): Promise<Cluster[]>;
  findEnabled(): Promise<Cluster[]>;
  delete(id: ClusterId): Promise<boolean>;
}

export class MongooseClusterRepository implements ClusterRepository {
  constructor(
    private readonly model: Model<ClusterPersistence> = DefaultModel
  ) {}

  async save(cluster: Cluster): Promise<void> {
    const doc = cluster.toPersistence();
    // Upsert by branded id. We never re-use the Mongo `_id` so callers
    // operate purely on `id`.
    await this.model.updateOne({ id: doc.id }, { $set: doc }, { upsert: true });
  }

  async findById(id: ClusterId): Promise<Cluster | null> {
    const doc = await this.model.findOne({ id }).lean<ClusterPersistence>().exec();
    return doc ? Cluster.fromPersistence(doc) : null;
  }

  async findAll(): Promise<Cluster[]> {
    const docs = await this.model
      .find({})
      .sort({ registeredAt: -1 })
      .lean<ClusterPersistence[]>()
      .exec();
    return docs.map((d) => Cluster.fromPersistence(d));
  }

  async findEnabled(): Promise<Cluster[]> {
    const docs = await this.model
      .find({ enabled: true })
      .sort({ registeredAt: -1 })
      .lean<ClusterPersistence[]>()
      .exec();
    return docs.map((d) => Cluster.fromPersistence(d));
  }

  async delete(id: ClusterId): Promise<boolean> {
    const r = await this.model.deleteOne({ id }).exec();
    return r.deletedCount > 0;
  }
}
