// Mongoose schema for the `securityScans` collection.

import mongoose, { Schema, type Model } from 'mongoose';
import type { SecurityScanPersistence } from '../../domain/security-scan';

const ScopeSchema = new Schema(
  {
    clusterId: { type: String, required: true },
    namespace: { type: String, required: false },
    kind: { type: String, required: false },
  },
  { _id: false }
);

const SnapshotRefSchema = new Schema(
  {
    id: { type: String, required: true },
    clusterId: { type: String, required: true },
    hash: { type: String, required: true },
    takenAt: { type: String, required: true },
  },
  { _id: false }
);

const ScannerProfileSchema = new Schema(
  {
    id: { type: String, required: true },
    enabledCheckIds: { type: [String], default: [] },
    severityFloor: { type: String, required: false },
  },
  { _id: false }
);

const SecurityScanCountsSchema = new Schema(
  {
    total: { type: Number, default: 0 },
    critical: { type: Number, default: 0 },
    high: { type: Number, default: 0 },
    medium: { type: Number, default: 0 },
    low: { type: Number, default: 0 },
  },
  { _id: false }
);

const SecurityScanErrorSchema = new Schema(
  {
    code: { type: String, required: true },
    message: { type: String, required: true },
  },
  { _id: false }
);

const SecurityScanSchema = new Schema<SecurityScanPersistence>(
  {
    id: { type: String, required: true, unique: true, index: true },
    scope: { type: ScopeSchema, required: true },
    snapshot: { type: SnapshotRefSchema, required: true },
    policyVersion: { type: Number, required: true },
    profile: { type: ScannerProfileSchema, required: true },
    status: {
      type: String,
      enum: ['pending', 'running', 'succeeded', 'failed'],
      required: true,
    },
    startedAt: { type: String, required: true },
    completedAt: { type: String, default: null },
    counts: { type: SecurityScanCountsSchema, required: true },
    score: { type: Number, default: null },
    error: { type: SecurityScanErrorSchema, default: null },
  },
  {
    collection: 'securityScans',
    versionKey: false,
    timestamps: false,
  }
);

SecurityScanSchema.index({ 'scope.clusterId': 1, startedAt: -1 });

export const SecurityScanModel: Model<SecurityScanPersistence> =
  (mongoose.models['SecuritySecurityScan'] as Model<SecurityScanPersistence>) ??
  mongoose.model<SecurityScanPersistence>(
    'SecuritySecurityScan',
    SecurityScanSchema
  );
