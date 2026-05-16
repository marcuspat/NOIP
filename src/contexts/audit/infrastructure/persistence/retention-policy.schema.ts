// Mongoose schema for the `retentionPolicies` collection.
//
// Per DDD-11 the audit context owns the retention policy for every
// collection that flows through it. Schema is intentionally tiny — the
// invariants live in `RetentionPolicy.create()` so we get a single
// chokepoint regardless of whether the document was loaded from Mongo
// or constructed in memory.

import mongoose, { Schema, type Document } from 'mongoose';
import type { RetentionCollection } from '../../domain/retention-policy';

export interface RetentionPolicyDoc extends Document {
  id: string;
  /** Renamed from `collection` to avoid colliding with `Document.collection`. */
  policyCollection: RetentionCollection;
  retentionDays: number;
  archiveAfterDays: number;
  immutable: boolean;
}

const RetentionPolicySchema = new Schema<RetentionPolicyDoc>(
  {
    id: { type: String, required: true, unique: true },
    policyCollection: { type: String, required: true, index: true },
    retentionDays: { type: Number, required: true },
    archiveAfterDays: { type: Number, required: true },
    immutable: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    collection: 'retentionPolicies',
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret['__v'];
        return ret;
      },
    },
  }
);

RetentionPolicySchema.index({ policyCollection: 1 }, { unique: true });

export const RetentionPolicyModel = mongoose.model<RetentionPolicyDoc>(
  'AuditRetentionPolicy',
  RetentionPolicySchema
);
