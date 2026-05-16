// AuditLogRepository — Mongoose-backed wrapper over `AuditLogModel`.
//
// The model itself lives at `src/models/audit-log.model.ts` (kept in
// place to minimise churn — DDD-14 will relocate it). This repo
// exposes the audit-context-shaped read surface used by `AuditService`
// + `ArchiveService` so the service files don't have to know about
// Mongoose. It also exposes a `cursor` factory for the streaming
// archive write path.

import type { Model, SortOrder } from 'mongoose';
import {
  AuditLogModel as DefaultModel,
  type AuditLogDocument,
  type AuditLogEntry,
} from '../../../../models/audit-log.model';
import type {
  AuditEntryCursor,
  AuditFilter,
  AuditPage,
  TimeRange,
} from '../../domain/value-objects';
import type { AuditId } from '../../../../shared/kernel';

export interface AuditLogRepository {
  query(filter: AuditFilter): Promise<AuditPage>;
  findById(id: AuditId | string): Promise<AuditLogEntry | null>;
  countOlderThan(cutoff: Date, shard?: string): Promise<number>;
  /**
   * Hard-deletes entries with `timestamp <= cutoff` (and optionally
   * matching the supplied shard). Returns the number of rows actually
   * removed. We intentionally route through the underlying `collection`
   * driver so the model's append-only `pre('deleteMany')` hook is
   * bypassed — only the archive service has the authority to delete.
   */
  hardDeleteOlderThan(cutoff: Date, shard?: string): Promise<number>;
  /**
   * Open a streaming cursor over `[from, to]` (inclusive of from,
   * exclusive of to). The archive service consumes this directly
   * without materialising the full result set in memory.
   */
  streamRange(opts: {
    from?: Date;
    to: Date;
    shard?: string;
  }): AuditEntryCursor;
  /**
   * Latest chain tip per shard. Returns `null` when the shard has no
   * entries yet (genesis state).
   */
  latestTipForShard(shard: string): Promise<{
    sequence: number;
    currentHash: string;
    timestamp: Date;
  } | null>;
  /** Distinct shard ids present in the collection. */
  listShards(): Promise<string[]>;
}

const MAX_PAGE = 1000;

export class MongooseAuditLogRepository implements AuditLogRepository {
  constructor(private readonly model: Model<AuditLogDocument> = DefaultModel) {}

  async query(filter: AuditFilter): Promise<AuditPage> {
    const mongoFilter = this.toMongoFilter(filter);
    const offset = Math.max(0, filter.offset ?? 0);
    const limit = Math.min(MAX_PAGE, Math.max(1, filter.limit ?? 50));
    const sort: { [k: string]: SortOrder } = { timestamp: -1 };

    const [docs, total] = await Promise.all([
      this.model
        .find(mongoFilter)
        .sort(sort)
        .skip(offset)
        .limit(limit)
        .lean<AuditLogEntry[]>()
        .exec(),
      this.model.countDocuments(mongoFilter).exec(),
    ]);

    return {
      items: docs.map(d => this.toPublicItem(d)),
      total,
      offset,
      limit,
    };
  }

  async findById(id: AuditId | string): Promise<AuditLogEntry | null> {
    const doc = await this.model
      .findById(id as string)
      .lean<AuditLogEntry>()
      .exec();
    return doc ?? null;
  }

  async countOlderThan(cutoff: Date, shard?: string): Promise<number> {
    const filter: Record<string, unknown> = { timestamp: { $lte: cutoff } };
    if (shard !== undefined) filter['chain.shard'] = shard;
    return this.model.countDocuments(filter).exec();
  }

  async hardDeleteOlderThan(cutoff: Date, shard?: string): Promise<number> {
    const filter: Record<string, unknown> = { timestamp: { $lte: cutoff } };
    if (shard !== undefined) filter['chain.shard'] = shard;
    // Bypass the append-only `pre('deleteMany')` hook by reaching
    // through `collection`. Only the archive service holds the
    // authority to call this — everything else hits the model's
    // refusal middleware.
    const out = await this.model.collection.deleteMany(filter);
    return out.deletedCount ?? 0;
  }

  streamRange(opts: {
    from?: Date;
    to: Date;
    shard?: string;
  }): AuditEntryCursor {
    const filter: Record<string, unknown> = {};
    if (opts.from !== undefined) {
      filter['timestamp'] = { $gte: opts.from, $lte: opts.to };
    } else {
      filter['timestamp'] = { $lte: opts.to };
    }
    if (opts.shard !== undefined) filter['chain.shard'] = opts.shard;
    const cursor = this.model
      .find(filter)
      .sort({ 'chain.shard': 1, 'chain.sequence': 1 })
      .lean<AuditLogEntry>()
      .cursor();
    return {
      next: async () => {
        const doc = (await cursor.next()) as AuditLogEntry | null;
        return doc;
      },
      close: async () => {
        await cursor.close();
      },
    };
  }

  async latestTipForShard(shard: string): Promise<{
    sequence: number;
    currentHash: string;
    timestamp: Date;
  } | null> {
    const doc = await this.model
      .findOne({ 'chain.shard': shard })
      .sort({ 'chain.sequence': -1 })
      .lean<AuditLogEntry>()
      .exec();
    if (!doc) return null;
    return {
      sequence: doc.chain.sequence,
      currentHash: doc.chain.currentHash,
      timestamp: doc.timestamp,
    };
  }

  async listShards(): Promise<string[]> {
    const out = (await this.model.distinct('chain.shard').exec()) as string[];
    return out.sort();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private toMongoFilter(filter: AuditFilter): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (filter.actor?.userId !== undefined) {
      out['actor.userId'] = filter.actor.userId;
    }
    if (filter.actor?.serviceAccountId !== undefined) {
      out['actor.serviceAccountId'] = filter.actor.serviceAccountId;
    }
    if (filter.action !== undefined) out['action'] = filter.action;
    if (filter.resource !== undefined) out['resource'] = filter.resource;
    if (filter.resourceId !== undefined) out['resourceId'] = filter.resourceId;
    if (filter.shard !== undefined) out['chain.shard'] = filter.shard;
    if (filter.from !== undefined || filter.to !== undefined) {
      const ts: Record<string, Date> = {};
      if (filter.from !== undefined) ts['$gte'] = filter.from;
      if (filter.to !== undefined) ts['$lte'] = filter.to;
      out['timestamp'] = ts;
    }
    return out;
  }

  private toPublicItem(doc: AuditLogEntry): AuditPage['items'][number] {
    const item: AuditPage['items'][number] = {
      id: String(doc._id) as AuditId,
      actor: doc.actor,
      action: doc.action,
      resource: doc.resource,
      details: doc.details,
      ipAddress: doc.ipAddress,
      userAgent: doc.userAgent,
      timestamp: doc.timestamp,
      chain: doc.chain,
    };
    if (doc.resourceId !== undefined) item.resourceId = doc.resourceId;
    if (doc.sessionId !== undefined) {
      // Brand-cast onto SessionId per the kernel.
      (item as { sessionId?: string }).sessionId = doc.sessionId;
    }
    return item;
  }

  /** Subset of `TimeRange` used by `AuditService.verifyChainIntegrity`. */
  static rangeToFilter(range: TimeRange): { from: Date; to: Date } {
    return { from: range.from, to: range.to };
  }
}

/** Construct the default repository against the canonical model. */
export function defaultAuditLogRepository(): AuditLogRepository {
  return new MongooseAuditLogRepository();
}
