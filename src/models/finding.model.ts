import { Schema, model, Document, Model } from 'mongoose';

export type FindingSeverity = 'low' | 'medium' | 'high' | 'critical';
export type FindingStatus = 'open' | 'acknowledged' | 'resolved' | 'suppressed';
export type FindingCategory =
  | 'security'
  | 'configuration'
  | 'compliance'
  | 'performance'
  | 'availability';

export interface IFinding {
  clusterId: string;
  fingerprint: string; // SHA-256 of (clusterId+kind+name+ruleId) for dedup
  ruleId: string;
  title: string;
  description: string;
  category: FindingCategory;
  severity: FindingSeverity;
  status: FindingStatus;
  affectedResource: {
    apiVersion: string;
    kind: string;
    namespace?: string;
    name: string;
  };
  evidence: string[];
  recommendation?: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedAt?: Date;
  suppressedUntil?: Date;
  suppressedBy?: string;
  snapshotId: string;
}

export interface IFindingDocument extends Omit<IFinding, '_id'>, Document {}

const AffectedResourceSchema = new Schema(
  {
    apiVersion: { type: String, required: true },
    kind: { type: String, required: true },
    namespace: { type: String },
    name: { type: String, required: true },
  },
  { _id: false }
);

const FindingSchema = new Schema<IFindingDocument>(
  {
    clusterId: { type: String, required: true, index: true },
    fingerprint: { type: String, required: true },
    ruleId: { type: String, required: true },
    title: { type: String, required: true },
    description: { type: String, required: true },
    category: {
      type: String,
      enum: ['security', 'configuration', 'compliance', 'performance', 'availability'],
      required: true,
    },
    severity: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      required: true,
    },
    status: {
      type: String,
      enum: ['open', 'acknowledged', 'resolved', 'suppressed'],
      default: 'open',
    },
    affectedResource: { type: AffectedResourceSchema, required: true },
    evidence: { type: [String], default: [] },
    recommendation: { type: String },
    firstSeenAt: { type: Date, required: true, default: () => new Date() },
    lastSeenAt: { type: Date, required: true, default: () => new Date() },
    resolvedAt: { type: Date },
    suppressedUntil: { type: Date },
    suppressedBy: { type: String },
    snapshotId: { type: String, required: true },
  },
  {
    timestamps: false,
    toJSON: { virtuals: false },
  }
);

// Unique per cluster+fingerprint for deduplication
FindingSchema.index({ clusterId: 1, fingerprint: 1 }, { unique: true });
FindingSchema.index({ status: 1, severity: 1 });
FindingSchema.index({ clusterId: 1, status: 1 });
FindingSchema.index({ ruleId: 1 });

export const FindingModel: Model<IFindingDocument> = model<IFindingDocument>(
  'Finding',
  FindingSchema
);
