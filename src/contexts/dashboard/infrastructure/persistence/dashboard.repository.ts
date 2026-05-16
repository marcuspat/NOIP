// Dashboard repository — Mongoose-backed, with an in-memory fallback
// for tests. The in-memory repo is the same one the unit suite uses
// for the application service so the wiring stays trivial.

import type { Model } from 'mongoose';
import type { DashboardId, UserId } from '../../../../shared/kernel';
import { Dashboard, type DashboardPersistence } from '../../domain/dashboard';
import { DashboardModel as DefaultModel } from './dashboard.schema';

export interface DashboardRepository {
  save(dashboard: Dashboard): Promise<void>;
  findById(id: DashboardId): Promise<Dashboard | null>;
  findAll(): Promise<Dashboard[]>;
  findByOwner(ownerId: UserId): Promise<Dashboard[]>;
  delete(id: DashboardId): Promise<boolean>;
}

export class MongooseDashboardRepository implements DashboardRepository {
  constructor(
    private readonly model: Model<DashboardPersistence> = DefaultModel
  ) {}

  async save(dashboard: Dashboard): Promise<void> {
    const doc = dashboard.toPersistence();
    await this.model.updateOne({ id: doc.id }, { $set: doc }, { upsert: true });
  }

  async findById(id: DashboardId): Promise<Dashboard | null> {
    const doc = await this.model
      .findOne({ id })
      .lean<DashboardPersistence>()
      .exec();
    return doc ? Dashboard.fromPersistence(doc) : null;
  }

  async findAll(): Promise<Dashboard[]> {
    const docs = await this.model
      .find({})
      .sort({ updatedAt: -1 })
      .lean<DashboardPersistence[]>()
      .exec();
    return docs.map(d => Dashboard.fromPersistence(d));
  }

  async findByOwner(ownerId: UserId): Promise<Dashboard[]> {
    const docs = await this.model
      .find({ 'ownedBy.userId': ownerId })
      .sort({ updatedAt: -1 })
      .lean<DashboardPersistence[]>()
      .exec();
    return docs.map(d => Dashboard.fromPersistence(d));
  }

  async delete(id: DashboardId): Promise<boolean> {
    const r = await this.model.deleteOne({ id }).exec();
    return r.deletedCount > 0;
  }
}

/**
 * Pure in-memory implementation used by the unit suite and by
 * developers running without Mongo. Behaves identically to the
 * Mongoose variant from the aggregate's point of view.
 */
export class InMemoryDashboardRepository implements DashboardRepository {
  private readonly store = new Map<string, DashboardPersistence>();

  async save(dashboard: Dashboard): Promise<void> {
    this.store.set(dashboard.id, dashboard.toPersistence());
  }

  async findById(id: DashboardId): Promise<Dashboard | null> {
    const doc = this.store.get(id);
    return doc ? Dashboard.fromPersistence(doc) : null;
  }

  async findAll(): Promise<Dashboard[]> {
    return Array.from(this.store.values())
      .sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1))
      .map(d => Dashboard.fromPersistence(d));
  }

  async findByOwner(ownerId: UserId): Promise<Dashboard[]> {
    return Array.from(this.store.values())
      .filter(d => d.ownedBy.userId === ownerId)
      .sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1))
      .map(d => Dashboard.fromPersistence(d));
  }

  async delete(id: DashboardId): Promise<boolean> {
    return this.store.delete(id);
  }
}
