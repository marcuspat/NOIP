// ClusterScan repository — Mongoose-backed.

import type { Model } from 'mongoose';
import type { ClusterId, ScanId } from '../../../../shared/kernel';
import { ClusterScan } from '../../domain/cluster-scan';
import type { ClusterScanPersistence } from '../../domain/cluster-scan';
import { ClusterScanModel as DefaultModel } from './cluster-scan.schema';

export interface ClusterScanRepository {
  save(scan: ClusterScan): Promise<void>;
  findById(id: ScanId): Promise<ClusterScan | null>;
  listByCluster(clusterId: ClusterId, limit?: number): Promise<ClusterScan[]>;
  findLatest(clusterId: ClusterId): Promise<ClusterScan | null>;
}

export class MongooseClusterScanRepository implements ClusterScanRepository {
  constructor(
    private readonly model: Model<ClusterScanPersistence> = DefaultModel
  ) {}

  async save(scan: ClusterScan): Promise<void> {
    const doc = scan.toPersistence();
    await this.model.updateOne({ id: doc.id }, { $set: doc }, { upsert: true });
  }

  async findById(id: ScanId): Promise<ClusterScan | null> {
    const doc = await this.model
      .findOne({ id })
      .lean<ClusterScanPersistence>()
      .exec();
    return doc ? ClusterScan.fromPersistence(doc) : null;
  }

  async listByCluster(
    clusterId: ClusterId,
    limit = 50
  ): Promise<ClusterScan[]> {
    const docs = await this.model
      .find({ clusterId })
      .sort({ startedAt: -1 })
      .limit(limit)
      .lean<ClusterScanPersistence[]>()
      .exec();
    return docs.map(d => ClusterScan.fromPersistence(d));
  }

  async findLatest(clusterId: ClusterId): Promise<ClusterScan | null> {
    const doc = await this.model
      .findOne({ clusterId })
      .sort({ startedAt: -1 })
      .lean<ClusterScanPersistence>()
      .exec();
    return doc ? ClusterScan.fromPersistence(doc) : null;
  }
}
