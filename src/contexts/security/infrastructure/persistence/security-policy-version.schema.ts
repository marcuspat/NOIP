// Mongoose schema for the `securityPolicyVersions` collection.
// Each row is an immutable historical snapshot of a SecurityPolicy.

import mongoose, { Schema, type Model } from 'mongoose';
import type { SecurityPolicyVersionPersistence } from '../../domain/security-policy';

const PolicyConfigSchema = new Schema(
  {
    checkId: { type: String, required: false },
    parameters: { type: Schema.Types.Mixed, required: false },
    description: { type: String, required: false },
    recommendation: { type: String, required: false },
    severity: { type: String, required: false },
  },
  { _id: false }
);

const SecurityPolicyVersionSchema =
  new Schema<SecurityPolicyVersionPersistence>(
    {
      policyId: { type: String, required: true, index: true },
      version: { type: Number, required: true },
      name: { type: String, required: true },
      type: { type: String, required: true },
      config: { type: PolicyConfigSchema, required: true },
      enabled: { type: Boolean, default: true },
      priority: { type: Number, default: 100 },
      archivedAt: { type: String, required: true },
    },
    {
      collection: 'securityPolicyVersions',
      versionKey: false,
      timestamps: false,
    }
  );

SecurityPolicyVersionSchema.index(
  { policyId: 1, version: 1 },
  { unique: true }
);

export const SecurityPolicyVersionModel: Model<SecurityPolicyVersionPersistence> =
  (mongoose.models[
    'SecuritySecurityPolicyVersion'
  ] as Model<SecurityPolicyVersionPersistence>) ??
  mongoose.model<SecurityPolicyVersionPersistence>(
    'SecuritySecurityPolicyVersion',
    SecurityPolicyVersionSchema
  );
