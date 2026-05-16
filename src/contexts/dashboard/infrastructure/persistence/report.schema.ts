// Mongoose schema for the `reports` collection (DDD-10 / DDD-14).
// Stores metadata only — the artifact bytes live in object storage and
// the row carries the URI back.

import mongoose, { Schema, type Model } from 'mongoose';
import type { ReportPersistence } from '../../domain/report';

const ActorRefSchema = new Schema(
  {
    userId: { type: String, required: true },
  },
  { _id: false }
);

const ScopeSchema = new Schema(
  {
    clusterId: { type: String, required: false },
    namespace: { type: String, required: false },
    framework: { type: String, required: false },
    windowDays: { type: Number, required: false },
  },
  { _id: false }
);

const ReportSchema = new Schema<ReportPersistence>(
  {
    id: { type: String, required: true, unique: true, index: true },
    kind: {
      type: String,
      enum: ['executive_summary', 'posture', 'compliance', 'incident'],
      required: true,
    },
    scope: { type: ScopeSchema, required: true },
    format: {
      type: String,
      enum: ['pdf', 'html', 'json', 'csv'],
      required: true,
    },
    status: {
      type: String,
      enum: ['queued', 'generated', 'failed'],
      required: true,
    },
    generatedAt: { type: String, default: null },
    generatedBy: { type: ActorRefSchema, required: true },
    artifactUri: { type: String, default: null },
    artifactKey: { type: String, default: null },
    artifactSize: { type: Number, default: null },
    failureReason: { type: String, default: null },
  },
  {
    collection: 'reports',
    versionKey: false,
    timestamps: false,
  }
);

ReportSchema.index({ kind: 1, generatedAt: -1 });
ReportSchema.index({ 'generatedBy.userId': 1, generatedAt: -1 });

export const ReportModel: Model<ReportPersistence> =
  (mongoose.models['DashboardReport'] as Model<ReportPersistence>) ??
  mongoose.model<ReportPersistence>('DashboardReport', ReportSchema);
