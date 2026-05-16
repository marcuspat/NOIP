// Repository for `RetentionPolicy` aggregates. Wraps the Mongoose
// schema with the domain-shaped read/write surface used by
// `ArchiveService` + ops tooling.

import type { Model } from 'mongoose';
import type { PolicyId } from '../../../../shared/kernel';
import {
  DEFAULT_RETENTION,
  RetentionPolicy,
  type RetentionCollection,
} from '../../domain/retention-policy';
import {
  RetentionPolicyModel as DefaultModel,
  type RetentionPolicyDoc,
} from './retention-policy.schema';

export interface RetentionPolicyRepository {
  findForCollection(collection: RetentionCollection): Promise<RetentionPolicy>;
  save(policy: RetentionPolicy): Promise<void>;
  list(): Promise<RetentionPolicy[]>;
}

export class MongooseRetentionPolicyRepository
  implements RetentionPolicyRepository
{
  constructor(
    private readonly model: Model<RetentionPolicyDoc> = DefaultModel
  ) {}

  async findForCollection(
    collection: RetentionCollection
  ): Promise<RetentionPolicy> {
    const doc = await this.model
      .findOne({ policyCollection: collection })
      .lean()
      .exec();
    if (doc) return this.fromDoc(doc);
    // Fall back to the conservative defaults declared in the
    // domain. The composition root never *needs* to seed Mongo for
    // the platform to behave safely.
    const fallback = DEFAULT_RETENTION[collection];
    return RetentionPolicy.create({
      id: `default-${collection}` as PolicyId,
      collection,
      retentionDays: fallback.retentionDays,
      archiveAfterDays: fallback.archiveAfterDays,
      immutable: false,
    });
  }

  async save(policy: RetentionPolicy): Promise<void> {
    const json = policy.toJSON();
    await this.model
      .updateOne(
        { id: json.id },
        {
          $set: {
            id: json.id,
            policyCollection: json.collection,
            retentionDays: json.retentionDays,
            archiveAfterDays: json.archiveAfterDays,
            immutable: json.immutable,
          },
        },
        { upsert: true }
      )
      .exec();
  }

  async list(): Promise<RetentionPolicy[]> {
    const docs = await this.model.find().lean().exec();
    return docs.map(d => this.fromDoc(d));
  }

  private fromDoc(
    doc: Pick<
      RetentionPolicyDoc,
      | 'id'
      | 'policyCollection'
      | 'retentionDays'
      | 'archiveAfterDays'
      | 'immutable'
    >
  ): RetentionPolicy {
    return RetentionPolicy.create({
      id: doc.id as PolicyId,
      collection: doc.policyCollection,
      retentionDays: doc.retentionDays,
      archiveAfterDays: doc.archiveAfterDays,
      immutable: doc.immutable,
    });
  }
}

export function defaultRetentionPolicyRepository(): RetentionPolicyRepository {
  return new MongooseRetentionPolicyRepository();
}
