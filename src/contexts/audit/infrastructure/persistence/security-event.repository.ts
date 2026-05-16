// SecurityEventRepository — Mongoose-backed wrapper over
// `SecurityEventModel`. Exposes the audit-context-shaped read/update
// surface used by `AuditService`.

import type { Model } from 'mongoose';
import {
  SecurityEventModel as DefaultModel,
  type SecurityEventDocument,
} from '../../../../models/security-event.model';
import type { SecurityEvent } from '../../../../types/auth.types';
import type { SecurityEventFilter } from '../../domain/value-objects';

export interface SecurityEventRepository {
  query(filter: SecurityEventFilter): Promise<SecurityEvent[]>;
  findById(id: string): Promise<SecurityEvent | null>;
  /**
   * Mark an event resolved. Returns the updated event, or `null` when
   * the id does not exist. Idempotent — a second resolve preserves the
   * original `resolvedAt`/`resolvedBy`.
   */
  resolve(id: string, by: string, note?: string): Promise<SecurityEvent | null>;
  /** Hard-deletes events older than `cutoff`. */
  hardDeleteOlderThan(cutoff: Date): Promise<number>;
}

const MAX_LIMIT = 1000;

export class MongooseSecurityEventRepository
  implements SecurityEventRepository
{
  constructor(
    private readonly model: Model<SecurityEventDocument> = DefaultModel as unknown as Model<SecurityEventDocument>
  ) {}

  async query(filter: SecurityEventFilter): Promise<SecurityEvent[]> {
    const mongoFilter = this.toMongoFilter(filter);
    const limit = Math.min(MAX_LIMIT, Math.max(1, filter.limit ?? 100));
    const docs = (await this.model
      .find(mongoFilter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec()) as unknown as SecurityEvent[];
    return docs;
  }

  async findById(id: string): Promise<SecurityEvent | null> {
    const doc = (await this.model
      .findById(id)
      .lean()
      .exec()) as SecurityEvent | null;
    return doc ?? null;
  }

  async resolve(
    id: string,
    by: string,
    note?: string
  ): Promise<SecurityEvent | null> {
    const update: Record<string, unknown> = {
      resolved: true,
      resolvedAt: new Date(),
      resolvedBy: by,
    };
    if (note !== undefined) update['resolutionNotes'] = note;
    const out = (await this.model
      .findByIdAndUpdate(id, { $set: update }, { new: true })
      .lean()
      .exec()) as SecurityEvent | null;
    return out ?? null;
  }

  async hardDeleteOlderThan(cutoff: Date): Promise<number> {
    // Use the collection driver to bypass the Mongoose-level
    // safety nets that some test suites stub out; matches the
    // pattern used by the audit-log archive path.
    const out = await this.model.collection.deleteMany({
      createdAt: { $lte: cutoff },
    });
    return out.deletedCount ?? 0;
  }

  private toMongoFilter(filter: SecurityEventFilter): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (filter.userId !== undefined) out['userId'] = filter.userId;
    if (filter.type !== undefined) out['type'] = filter.type;
    if (filter.severity !== undefined) out['severity'] = filter.severity;
    if (filter.resolved !== undefined) out['resolved'] = filter.resolved;
    if (filter.from !== undefined || filter.to !== undefined) {
      const ts: Record<string, Date> = {};
      if (filter.from !== undefined) ts['$gte'] = filter.from;
      if (filter.to !== undefined) ts['$lte'] = filter.to;
      out['createdAt'] = ts;
    }
    return out;
  }
}

export function defaultSecurityEventRepository(): SecurityEventRepository {
  return new MongooseSecurityEventRepository();
}
