import { Schema, model, Document, Model } from 'mongoose';

export type AssessmentResult = 'pass' | 'fail' | 'warning';

export interface IComplianceAssessment {
  frameworkSlug: string;
  controlId: string;
  assessedAt: Date;
  type: 'automated' | 'manual';
  result: AssessmentResult;
  score: number; // 0-100
  findings: string[];
  evidenceIds: string[];
  assessor: string;
  notes?: string;
}

export interface IComplianceAssessmentDocument
  extends Omit<IComplianceAssessment, '_id'>,
    Document {}

const ComplianceAssessmentSchema = new Schema<IComplianceAssessmentDocument>(
  {
    frameworkSlug: { type: String, required: true, index: true },
    controlId: { type: String, required: true, index: true },
    assessedAt: { type: Date, required: true, default: () => new Date() },
    type: { type: String, enum: ['automated', 'manual'], required: true },
    result: { type: String, enum: ['pass', 'fail', 'warning'], required: true },
    score: { type: Number, required: true, min: 0, max: 100 },
    findings: { type: [String], default: [] },
    evidenceIds: { type: [String], default: [] },
    assessor: { type: String, required: true },
    notes: { type: String },
  },
  { timestamps: false, toJSON: { virtuals: false } }
);

ComplianceAssessmentSchema.index({ frameworkSlug: 1, controlId: 1, assessedAt: -1 });
ComplianceAssessmentSchema.index({ result: 1 });

export const ComplianceAssessmentModel: Model<IComplianceAssessmentDocument> =
  model<IComplianceAssessmentDocument>('ComplianceAssessment', ComplianceAssessmentSchema);
