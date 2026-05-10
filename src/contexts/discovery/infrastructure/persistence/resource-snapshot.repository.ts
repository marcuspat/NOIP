// ResourceSnapshot repository.
//
// Performance notes:
//   - Snapshot rows can be large (10s of MB). Find queries use `lean`
//     and project explicitly when the caller doesn't need full
//     records.
//   - The unique `(clusterId, hash)` index lets us treat the second
//     identical scan as a cheap no-op: `findByHash` first, then
//     reuse the existing snapshot id and skip the insert.

import type { Model } from 'mongoose';
import type { ClusterId, SnapshotId } from '../../../../shared/kernel';
import { ResourceSnapshot } from '../../domain/resource-snapshot';
import type { ResourceSnapshotPersistence } from '../../domain/resource-snapshot';
import type {
  ContentHash,
  KubernetesResourceRecord,
  ResourceRef,
  ResourceSnapshotRef,
  TimeRange,
} from '../../domain/value-objects';
import { ResourceSnapshotModel as DefaultModel } from './resource-snapshot.schema';

export interface ResourceSnapshotRepository {
  save(snapshot: ResourceSnapshot): Promise<void>;
  findById(id: SnapshotId): Promise<ResourceSnapshot | null>;
  findByHash(
    clusterId: ClusterId,
    hash: ContentHash
  ): Promise<ResourceSnapshot | null>;
  findLatest(clusterId: ClusterId): Promise<ResourceSnapshot | null>;
  list(
    clusterId: ClusterId,
    range?: TimeRange,
    limit?: number
  ): Promise<ResourceSnapshotRef[]>;
  findResource(
    clusterId: ClusterId,
    ref: ResourceRef,
    at?: Date
  ): Promise<KubernetesResourceRecord | null>;
}

export class MongooseResourceSnapshotRepository
  implements ResourceSnapshotRepository
{
  constructor(
    private readonly model: Model<ResourceSnapshotPersistence> = DefaultModel
  ) {}

  async save(snapshot: ResourceSnapshot): Promise<void> {
    const doc = snapshot.toPersistence();
    // We rely on the unique `(clusterId, hash)` index to swallow
    // duplicate inserts. The application service should call
    // `findByHash` first to avoid the round-trip, but this is a
    // safety net.
    try {
      await this.model.create(doc);
    } catch (err) {
      // Mongo duplicate-key error code is 11000.
      if (
        typeof err === 'object' &&
        err !== null &&
        (err as { code?: number }).code === 11000
      ) {
        return;
      }
      throw err;
    }
  }

  async findById(id: SnapshotId): Promise<ResourceSnapshot | null> {
    const doc = await this.model
      .findOne({ id })
      .lean<ResourceSnapshotPersistence>()
      .exec();
    return doc ? ResourceSnapshot.fromPersistence(doc) : null;
  }

  async findByHash(
    clusterId: ClusterId,
    hash: ContentHash
  ): Promise<ResourceSnapshot | null> {
    const doc = await this.model
      .findOne({ clusterId, hash })
      .lean<ResourceSnapshotPersistence>()
      .exec();
    return doc ? ResourceSnapshot.fromPersistence(doc) : null;
  }

  async findLatest(clusterId: ClusterId): Promise<ResourceSnapshot | null> {
    const doc = await this.model
      .findOne({ clusterId })
      .sort({ takenAt: -1 })
      .lean<ResourceSnapshotPersistence>()
      .exec();
    return doc ? ResourceSnapshot.fromPersistence(doc) : null;
  }

  async list(
    clusterId: ClusterId,
    range?: TimeRange,
    limit = 50
  ): Promise<ResourceSnapshotRef[]> {
    const filter: Record<string, unknown> = { clusterId };
    if (range?.from || range?.to) {
      const time: Record<string, string> = {};
      if (range.from) time['$gte'] = range.from.toISOString();
      if (range.to) time['$lte'] = range.to.toISOString();
      filter['takenAt'] = time;
    }
    const docs = await this.model
      .find(filter)
      .sort({ takenAt: -1 })
      .limit(limit)
      .select({ id: 1, clusterId: 1, takenAt: 1, hash: 1, counts: 1 })
      .lean<
        Array<
          Pick<
            ResourceSnapshotPersistence,
            'id' | 'clusterId' | 'takenAt' | 'hash' | 'counts'
          >
        >
      >()
      .exec();
    return docs.map(d => ({
      id: d.id as SnapshotId,
      clusterId: d.clusterId as ClusterId,
      takenAt: new Date(d.takenAt),
      hash: d.hash as ContentHash,
      counts: d.counts,
    }));
  }

  async findResource(
    clusterId: ClusterId,
    ref: ResourceRef,
    at?: Date
  ): Promise<KubernetesResourceRecord | null> {
    const filter: Record<string, unknown> = { clusterId };
    if (at) filter['takenAt'] = { $lte: at.toISOString() };
    const doc = await this.model
      .findOne(filter)
      .sort({ takenAt: -1 })
      .lean<ResourceSnapshotPersistence>()
      .exec();
    if (!doc) return null;
    for (const r of doc.records) {
      if (
        r.apiVersion === ref.apiVersion &&
        r.kind === ref.kind &&
        (r.namespace ?? '') === (ref.namespace ?? '') &&
        r.name === ref.name
      ) {
        return r;
      }
    }
    return null;
  }
}
