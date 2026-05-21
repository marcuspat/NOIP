import { Schema, model, Document, Model } from 'mongoose';

export type ControlStatus =
  | 'compliant'
  | 'non-compliant'
  | 'partially-compliant'
  | 'not-assessed';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type TestFrequency =
  | 'continuous'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'quarterly'
  | 'annually';

export interface IComplianceControl {
  frameworkSlug: string;
  controlId: string; // e.g. 'CC1.1'
  category: string;
  title: string;
  description: string;
  requirement: string;
  implementation: string;
  status: ControlStatus;
  riskLevel: RiskLevel;
  owner: string;
  automatedTesting: boolean;
  testFrequency: TestFrequency;
  lastAssessed: Date;
  nextAssessment: Date;
}

export interface IComplianceControlDocument
  extends Omit<IComplianceControl, '_id'>,
    Document {}

const ComplianceControlSchema = new Schema<IComplianceControlDocument>(
  {
    frameworkSlug: { type: String, required: true, index: true },
    controlId: { type: String, required: true },
    category: { type: String, required: true },
    title: { type: String, required: true },
    description: { type: String, required: true },
    requirement: { type: String, required: true },
    implementation: { type: String, required: true },
    status: {
      type: String,
      enum: ['compliant', 'non-compliant', 'partially-compliant', 'not-assessed'],
      default: 'not-assessed',
    },
    riskLevel: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      required: true,
    },
    owner: { type: String, required: true },
    automatedTesting: { type: Boolean, default: false },
    testFrequency: {
      type: String,
      enum: ['continuous', 'daily', 'weekly', 'monthly', 'quarterly', 'annually'],
      required: true,
    },
    lastAssessed: { type: Date, required: true, default: () => new Date() },
    nextAssessment: { type: Date, required: true },
  },
  { timestamps: false, toJSON: { virtuals: false } }
);

ComplianceControlSchema.index({ frameworkSlug: 1, controlId: 1 }, { unique: true });
ComplianceControlSchema.index({ status: 1 });
ComplianceControlSchema.index({ riskLevel: 1 });

export const ComplianceControlModel: Model<IComplianceControlDocument> =
  model<IComplianceControlDocument>('ComplianceControl', ComplianceControlSchema);
