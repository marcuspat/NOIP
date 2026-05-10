// Mongoose schema for the `findings` collection. Indexes per DDD-14.

import mongoose, { Schema, type Model } from 'mongoose';
import type { FindingPersistence } from '../../domain/finding';

const ResourceRefSchema = new Schema(
  {
    apiVersion: { type: String, required: true },
    kind: { type: String, required: true },
    namespace: { type: String, required: false },
    name: { type: String, required: true },
  },
  { _id: false }
);

const EvidenceSchema = new Schema(
  {
    source: { type: String, required: true },
    summary: { type: String, required: true },
    data: { type: Schema.Types.Mixed, required: false },
    capturedAt: { type: String, required: true },
  },
  { _id: false }
);

const ScopeSchema = new Schema(
  {
    clusterId: { type: String, required: true },
    namespace: { type: String, required: false },
    kind: { type: String, required: false },
  },
  { _id: false }
);

const FindingSchema = new Schema<FindingPersistence>(
  {
    id: { type: String, required: true, unique: true, index: true },
    scanId: { type: String, required: true },
    scope: { type: ScopeSchema, required: true },
    resource: { type: ResourceRefSchema, required: true },
    policyId: { type: String, required: true },
    policyVersion: { type: Number, required: true },
    severity: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      required: true,
    },
    description: { type: String, required: true },
    recommendation: { type: String, required: false },
    evidence: { type: EvidenceSchema, required: true },
    status: {
      type: String,
      enum: ['open', 'acknowledged', 'suppressed', 'resolved'],
      required: true,
    },
    fingerprint: { type: String, required: true },
    detectedAt: { type: String, required: true },
    lastSeenAt: { type: String, required: true },
    acknowledgedAt: { type: String, default: null },
    acknowledgedBy: { type: String, default: null },
    acknowledgementNote: { type: String, default: null },
    suppressedAt: { type: String, default: null },
    suppressedBy: { type: String, default: null },
    suppressedUntil: { type: String, default: null },
    suppressionJustification: { type: String, default: null },
    resolvedAt: { type: String, default: null },
    resolvedBy: { type: String, default: null },
  },
  {
    collection: 'findings',
    versionKey: false,
    timestamps: false,
  }
);

// DDD-14 indexes.
FindingSchema.index(
  { 'scope.clusterId': 1, severity: 1, status: 1 },
  { name: 'cluster_severity_status' }
);
FindingSchema.index({ scanId: 1 });
FindingSchema.index({ detectedAt: -1 });
FindingSchema.index({ 'resource.kind': 1, 'resource.name': 1 });
// Fingerprint dedupe lookup (Phase 3 optimisation).
FindingSchema.index(
  { 'scope.clusterId': 1, fingerprint: 1 },
  { name: 'cluster_fingerprint' }
);

export const FindingModel: Model<FindingPersistence> =
  (mongoose.models['SecurityFinding'] as Model<FindingPersistence>) ??
  mongoose.model<FindingPersistence>('SecurityFinding', FindingSchema);
