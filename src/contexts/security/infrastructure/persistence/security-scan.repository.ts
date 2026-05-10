// SecurityScan repository — Mongoose-backed.

import type { Model } from 'mongoose';
import type { ClusterId, ScanId } from '../../../../shared/kernel';
import { SecurityScan } from '../../domain/security-scan';
import type { SecurityScanPersistence } from '../../domain/security-scan';
import { SecurityScanModel as DefaultModel } from './security-scan.schema';

export interface SecurityScanRepository {
  save(scan: SecurityScan): Promise<void>;
  findById(id: ScanId): Promise<SecurityScan | null>;
  listByCluster(clusterId: ClusterId, limit?: number): Promise<SecurityScan[]>;
  findLatestSucceededByHash(
    clusterId: ClusterId,
    hash: string
  ): Promise<SecurityScan | null>;
}

export class MongooseSecurityScanRepository implements SecurityScanRepository {
  constructor(
    private readonly model: Model<SecurityScanPersistence> = DefaultModel
  ) {}

  async save(scan: SecurityScan): Promise<void> {
    const doc = scan.toPersistence();
    await this.model.updateOne({ id: doc.id }, { $set: doc }, { upsert: true });
  }

  async findById(id: ScanId): Promise<SecurityScan | null> {
    const doc = await this.model
      .findOne({ id })
      .lean<SecurityScanPersistence>()
      .exec();
    return doc ? SecurityScan.fromPersistence(doc) : null;
  }

  async listByCluster(
    clusterId: ClusterId,
    limit = 50
  ): Promise<SecurityScan[]> {
    const docs = await this.model
      .find({ 'scope.clusterId': clusterId })
      .sort({ startedAt: -1 })
      .limit(limit)
      .lean<SecurityScanPersistence[]>()
      .exec();
    return docs.map(d => SecurityScan.fromPersistence(d));
  }

  /**
   * Used by the orchestrator's debounce: a SecurityScan keyed against
   * the same `(clusterId, snapshotHash)` already exists, so we skip a
   * redundant rescan.
   */
  async findLatestSucceededByHash(
    clusterId: ClusterId,
    hash: string
  ): Promise<SecurityScan | null> {
    const doc = await this.model
      .findOne({
        'scope.clusterId': clusterId,
        'snapshot.hash': hash,
        status: 'succeeded',
      })
      .sort({ startedAt: -1 })
      .lean<SecurityScanPersistence>()
      .exec();
    return doc ? SecurityScan.fromPersistence(doc) : null;
  }
}

/** In-memory implementation for tests. */
export class InMemorySecurityScanRepository implements SecurityScanRepository {
  private readonly scans = new Map<string, SecurityScanPersistence>();

  async save(scan: SecurityScan): Promise<void> {
    this.scans.set(scan.id, scan.toPersistence());
  }
  async findById(id: ScanId): Promise<SecurityScan | null> {
    const doc = this.scans.get(id);
    return doc ? SecurityScan.fromPersistence(doc) : null;
  }
  async listByCluster(
    clusterId: ClusterId,
    limit = 50
  ): Promise<SecurityScan[]> {
    return Array.from(this.scans.values())
      .filter(d => d.scope.clusterId === clusterId)
      .sort((a, b) => (a.startedAt > b.startedAt ? -1 : 1))
      .slice(0, limit)
      .map(d => SecurityScan.fromPersistence(d));
  }
  async findLatestSucceededByHash(
    clusterId: ClusterId,
    hash: string
  ): Promise<SecurityScan | null> {
    const matches = Array.from(this.scans.values())
      .filter(
        d =>
          d.scope.clusterId === clusterId &&
          d.snapshot.hash === hash &&
          d.status === 'succeeded'
      )
      .sort((a, b) => (a.startedAt > b.startedAt ? -1 : 1));
    return matches[0] ? SecurityScan.fromPersistence(matches[0]) : null;
  }
}
