// Mongoose schema for the `securityPolicies` collection.

import mongoose, { Schema, type Model } from 'mongoose';
import type { SecurityPolicyPersistence } from '../../domain/security-policy';

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

const SecurityPolicySchema = new Schema<SecurityPolicyPersistence>(
  {
    id: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    type: {
      type: String,
      enum: [
        'password',
        'account_lockout',
        'session',
        'mfa',
        'access',
        'k8s',
        'secrets',
        'cve',
      ],
      required: true,
    },
    config: { type: PolicyConfigSchema, required: true },
    enabled: { type: Boolean, default: true },
    priority: { type: Number, default: 100 },
    version: { type: Number, required: true },
    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
  },
  {
    collection: 'securityPolicies',
    versionKey: false,
    timestamps: false,
  }
);

SecurityPolicySchema.index({ name: 1 }, { unique: true });
SecurityPolicySchema.index({ enabled: 1, priority: 1 });

export const SecurityPolicyModel: Model<SecurityPolicyPersistence> =
  (mongoose.models[
    'SecuritySecurityPolicy'
  ] as Model<SecurityPolicyPersistence>) ??
  mongoose.model<SecurityPolicyPersistence>(
    'SecuritySecurityPolicy',
    SecurityPolicySchema
  );
