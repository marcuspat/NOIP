// Mongoose schema for `driftReports`.

import mongoose, { Schema, type Model } from 'mongoose';
import type { DriftReportPersistence } from '../../domain/drift-report';

const ResourceRefSchema = new Schema(
  {
    apiVersion: { type: String, required: true },
    kind: { type: String, required: true },
    namespace: { type: String },
    name: { type: String, required: true },
  },
  { _id: false }
);

const PatchOpSchema = new Schema(
  {
    op: { type: String, enum: ['add', 'remove', 'replace'], required: true },
    path: { type: String, required: true },
    value: { type: Schema.Types.Mixed },
  },
  { _id: false, minimize: false }
);

const ResourceChangeSchema = new Schema(
  {
    kind: {
      type: String,
      enum: ['created', 'updated', 'deleted'],
      required: true,
    },
    ref: { type: ResourceRefSchema, required: true },
    patch: { type: [PatchOpSchema], default: [] },
    severity: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      required: true,
    },
    rationale: { type: String },
  },
  { _id: false }
);

const DriftReportSchema = new Schema<DriftReportPersistence>(
  {
    id: { type: String, required: true, unique: true, index: true },
    clusterId: { type: String, required: true },
    previous: { type: String, required: true },
    current: { type: String, required: true },
    changes: { type: [ResourceChangeSchema], default: [] },
    highestSeverity: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      required: true,
    },
    detectedAt: { type: String, required: true },
  },
  {
    collection: 'driftReports',
    versionKey: false,
    timestamps: false,
    minimize: false,
  }
);

DriftReportSchema.index({ clusterId: 1, detectedAt: -1 });

export const DriftReportModel: Model<DriftReportPersistence> =
  (mongoose.models['DiscoveryDriftReport'] as Model<DriftReportPersistence>) ??
  mongoose.model<DriftReportPersistence>(
    'DiscoveryDriftReport',
    DriftReportSchema
  );
