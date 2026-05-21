import { Schema, model, Document, Model } from 'mongoose';

export type DriftChangeType = 'added' | 'removed' | 'modified';
export type DriftSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface DriftItem {
  resourceKind: string;
  resourceName: string;
  namespace?: string;
  changeType: DriftChangeType;
  severity: DriftSeverity;
  previousFingerprint?: string;
  currentFingerprint?: string;
  diff: Record<string, unknown>;
}

export interface IDriftReport {
  clusterId: string;
  baselineSnapshotId: string;
  currentSnapshotId: string;
  detectedAt: Date;
  driftCount: number;
  items: DriftItem[];
  acknowledged: boolean;
  acknowledgedAt?: Date;
  acknowledgedBy?: string;
}

export interface IDriftReportDocument extends Omit<IDriftReport, '_id'>, Document {}

const DriftItemSchema = new Schema<DriftItem>(
  {
    resourceKind: { type: String, required: true },
    resourceName: { type: String, required: true },
    namespace: { type: String },
    changeType: {
      type: String,
      enum: ['added', 'removed', 'modified'],
      required: true,
    },
    severity: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      required: true,
    },
    previousFingerprint: { type: String },
    currentFingerprint: { type: String },
    diff: { type: Schema.Types.Mixed, required: true, default: {} },
  },
  { _id: false }
);

const DriftReportSchema = new Schema<IDriftReportDocument>(
  {
    clusterId: { type: String, required: true, index: true },
    baselineSnapshotId: { type: String, required: true },
    currentSnapshotId: { type: String, required: true },
    detectedAt: { type: Date, required: true, default: () => new Date() },
    driftCount: { type: Number, required: true, default: 0 },
    items: { type: [DriftItemSchema], default: [] },
    acknowledged: { type: Boolean, default: false },
    acknowledgedAt: { type: Date },
    acknowledgedBy: { type: String },
  },
  {
    timestamps: false,
    toJSON: { virtuals: false },
  }
);

DriftReportSchema.index({ clusterId: 1, detectedAt: -1 });
DriftReportSchema.index({ acknowledged: 1 });

export const DriftReportModel: Model<IDriftReportDocument> = model<IDriftReportDocument>(
  'DriftReport',
  DriftReportSchema
);
