// SecurityPolicyVersion repository — Mongoose-backed.

import type { Model } from 'mongoose';
import type { SecurityPolicyVersionPersistence } from '../../domain/security-policy';
import { SecurityPolicyVersionModel as DefaultModel } from './security-policy-version.schema';

export interface SecurityPolicyVersionRepository {
  saveMany(
    rows: ReadonlyArray<SecurityPolicyVersionPersistence>
  ): Promise<void>;
  list(policyId: string): Promise<SecurityPolicyVersionPersistence[]>;
}

export class MongooseSecurityPolicyVersionRepository
  implements SecurityPolicyVersionRepository
{
  constructor(
    private readonly model: Model<SecurityPolicyVersionPersistence> = DefaultModel
  ) {}
  async saveMany(
    rows: ReadonlyArray<SecurityPolicyVersionPersistence>
  ): Promise<void> {
    if (rows.length === 0) return;
    const ops = rows.map(r => ({
      updateOne: {
        filter: { policyId: r.policyId, version: r.version },
        update: { $setOnInsert: r },
        upsert: true,
      },
    }));
    await this.model.bulkWrite(ops);
  }
  async list(policyId: string): Promise<SecurityPolicyVersionPersistence[]> {
    return this.model
      .find({ policyId })
      .sort({ version: 1 })
      .lean<SecurityPolicyVersionPersistence[]>()
      .exec();
  }
}

export class InMemorySecurityPolicyVersionRepository
  implements SecurityPolicyVersionRepository
{
  private readonly rows: SecurityPolicyVersionPersistence[] = [];
  async saveMany(
    rows: ReadonlyArray<SecurityPolicyVersionPersistence>
  ): Promise<void> {
    for (const r of rows) {
      const exists = this.rows.some(
        x => x.policyId === r.policyId && x.version === r.version
      );
      if (!exists) this.rows.push(r);
    }
  }
  async list(policyId: string): Promise<SecurityPolicyVersionPersistence[]> {
    return this.rows
      .filter(r => r.policyId === policyId)
      .sort((a, b) => a.version - b.version);
  }
}
