// Mongoose schema for the `complianceReports` collection.

import mongoose, { Schema, type Model } from 'mongoose';
import type { ComplianceReportPersistence } from '../../domain/compliance-report';

const ScopeSchema = new Schema(
  {
    clusterId: { type: String, required: true },
    namespace: { type: String, required: false },
    kind: { type: String, required: false },
  },
  { _id: false }
);

const ControlAssessmentSchema = new Schema(
  {
    controlId: { type: String, required: true },
    framework: { type: String, required: true },
    title: { type: String, required: true },
    category: { type: String, required: true },
    status: { type: String, required: true },
    supportingFindings: { type: [String], default: [] },
    rationale: { type: String, required: false },
  },
  { _id: false }
);

const CoverageScoreSchema = new Schema(
  {
    score: { type: Number, default: 0 },
    pass: { type: Number, default: 0 },
    fail: { type: Number, default: 0 },
    partial: { type: Number, default: 0 },
    na: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
  },
  { _id: false }
);

const SignedBySchema = new Schema(
  {
    userId: { type: String, required: true },
    signedAt: { type: String, required: true },
  },
  { _id: false }
);

const ComplianceReportSchema = new Schema<ComplianceReportPersistence>(
  {
    id: { type: String, required: true, unique: true, index: true },
    framework: {
      type: String,
      enum: ['SOC2', 'ISO27001', 'HIPAA', 'PCI-DSS', 'GDPR'],
      required: true,
    },
    scope: { type: ScopeSchema, required: true },
    generatedAt: { type: String, required: true },
    controls: { type: [ControlAssessmentSchema], default: [] },
    overall: { type: CoverageScoreSchema, required: true },
    status: {
      type: String,
      enum: ['draft', 'signed', 'expired'],
      required: true,
    },
    signedBy: { type: SignedBySchema, default: null },
    expiresAt: { type: String, default: null },
  },
  {
    collection: 'complianceReports',
    versionKey: false,
    timestamps: false,
  }
);

ComplianceReportSchema.index({ framework: 1, generatedAt: -1 });

export const ComplianceReportModel: Model<ComplianceReportPersistence> =
  (mongoose.models['ComplianceReport'] as Model<ComplianceReportPersistence>) ??
  mongoose.model<ComplianceReportPersistence>(
    'ComplianceReport',
    ComplianceReportSchema
  );
