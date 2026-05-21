import { Schema, model, Document, Model } from 'mongoose';

export type EvidenceType =
  | 'automated'
  | 'manual'
  | 'document'
  | 'screenshot'
  | 'log'
  | 'configuration';

export interface IComplianceEvidence {
  frameworkSlug: string;
  controlId: string;
  assessmentId?: string;
  type: EvidenceType;
  description: string;
  source: string;
  collectedAt: Date;
  data?: Record<string, unknown>;
  fileRef?: string;
  verified: boolean;
  verifiedAt?: Date;
  verifiedBy?: string;
  expiresAt?: Date;
}

export interface IComplianceEvidenceDocument
  extends Omit<IComplianceEvidence, '_id'>,
    Document {}

const ComplianceEvidenceSchema = new Schema<IComplianceEvidenceDocument>(
  {
    frameworkSlug: { type: String, required: true, index: true },
    controlId: { type: String, required: true, index: true },
    assessmentId: { type: String },
    type: {
      type: String,
      enum: ['automated', 'manual', 'document', 'screenshot', 'log', 'configuration'],
      required: true,
    },
    description: { type: String, required: true },
    source: { type: String, required: true },
    collectedAt: { type: Date, required: true, default: () => new Date() },
    data: { type: Schema.Types.Mixed },
    fileRef: { type: String },
    verified: { type: Boolean, default: false },
    verifiedAt: { type: Date },
    verifiedBy: { type: String },
    expiresAt: { type: Date },
  },
  { timestamps: false, toJSON: { virtuals: false } }
);

ComplianceEvidenceSchema.index({ frameworkSlug: 1, controlId: 1 });
ComplianceEvidenceSchema.index({ verified: 1 });
ComplianceEvidenceSchema.index({ expiresAt: 1 }, { sparse: true });

export const ComplianceEvidenceModel: Model<IComplianceEvidenceDocument> =
  model<IComplianceEvidenceDocument>('ComplianceEvidence', ComplianceEvidenceSchema);
