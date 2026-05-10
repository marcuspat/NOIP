// SecurityPolicy repository — Mongoose-backed.

import type { Model } from 'mongoose';
import type { PolicyId } from '../../../../shared/kernel';
import { SecurityPolicy } from '../../domain/security-policy';
import type { SecurityPolicyPersistence } from '../../domain/security-policy';
import { SecurityPolicyModel as DefaultModel } from './security-policy.schema';
import type { SecurityPolicyVersionRepository } from './security-policy-version.repository';

export interface SecurityPolicyRepository {
  save(policy: SecurityPolicy): Promise<void>;
  findById(id: PolicyId): Promise<SecurityPolicy | null>;
  findByName(name: string): Promise<SecurityPolicy | null>;
  listEnabled(): Promise<SecurityPolicy[]>;
  listAll(): Promise<SecurityPolicy[]>;
}

export class MongooseSecurityPolicyRepository
  implements SecurityPolicyRepository
{
  constructor(
    private readonly model: Model<SecurityPolicyPersistence> = DefaultModel,
    private readonly versions?: SecurityPolicyVersionRepository
  ) {}

  async save(policy: SecurityPolicy): Promise<void> {
    const doc = policy.toPersistence();
    await this.model.updateOne({ id: doc.id }, { $set: doc }, { upsert: true });
    // Drain archived versions and let the version repo persist them.
    const archived = policy.drainArchivedVersions();
    if (archived.length > 0 && this.versions) {
      await this.versions.saveMany(archived);
    }
  }
  async findById(id: PolicyId): Promise<SecurityPolicy | null> {
    const doc = await this.model
      .findOne({ id })
      .lean<SecurityPolicyPersistence>()
      .exec();
    return doc ? SecurityPolicy.fromPersistence(doc) : null;
  }
  async findByName(name: string): Promise<SecurityPolicy | null> {
    const doc = await this.model
      .findOne({ name })
      .lean<SecurityPolicyPersistence>()
      .exec();
    return doc ? SecurityPolicy.fromPersistence(doc) : null;
  }
  async listEnabled(): Promise<SecurityPolicy[]> {
    const docs = await this.model
      .find({ enabled: true })
      .sort({ priority: 1 })
      .lean<SecurityPolicyPersistence[]>()
      .exec();
    return docs.map(d => SecurityPolicy.fromPersistence(d));
  }
  async listAll(): Promise<SecurityPolicy[]> {
    const docs = await this.model
      .find({})
      .sort({ priority: 1 })
      .lean<SecurityPolicyPersistence[]>()
      .exec();
    return docs.map(d => SecurityPolicy.fromPersistence(d));
  }
}

export class InMemorySecurityPolicyRepository
  implements SecurityPolicyRepository
{
  private readonly policies = new Map<string, SecurityPolicyPersistence>();
  constructor(private readonly versions?: SecurityPolicyVersionRepository) {}

  async save(policy: SecurityPolicy): Promise<void> {
    this.policies.set(policy.id, policy.toPersistence());
    const archived = policy.drainArchivedVersions();
    if (archived.length > 0 && this.versions) {
      await this.versions.saveMany(archived);
    }
  }
  async findById(id: PolicyId): Promise<SecurityPolicy | null> {
    const doc = this.policies.get(id);
    return doc ? SecurityPolicy.fromPersistence(doc) : null;
  }
  async findByName(name: string): Promise<SecurityPolicy | null> {
    for (const doc of this.policies.values()) {
      if (doc.name === name) return SecurityPolicy.fromPersistence(doc);
    }
    return null;
  }
  async listEnabled(): Promise<SecurityPolicy[]> {
    return Array.from(this.policies.values())
      .filter(d => d.enabled)
      .sort((a, b) => a.priority - b.priority)
      .map(d => SecurityPolicy.fromPersistence(d));
  }
  async listAll(): Promise<SecurityPolicy[]> {
    return Array.from(this.policies.values())
      .sort((a, b) => a.priority - b.priority)
      .map(d => SecurityPolicy.fromPersistence(d));
  }
}
