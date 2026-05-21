import { Schema, model, Document, Model } from 'mongoose';

export interface IComplianceFrameworkDoc {
  slug: string; // e.g. 'soc2-type2'
  name: string;
  version: string;
  description: string;
  controlIds: string[];
  lastUpdated: Date;
  nextReview: Date;
}

export interface IComplianceFrameworkDocument
  extends Omit<IComplianceFrameworkDoc, '_id'>,
    Document {}

const ComplianceFrameworkSchema = new Schema<IComplianceFrameworkDocument>(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true },
    version: { type: String, required: true },
    description: { type: String, required: true },
    controlIds: { type: [String], default: [] },
    lastUpdated: { type: Date, required: true, default: () => new Date() },
    nextReview: { type: Date, required: true },
  },
  { timestamps: false, toJSON: { virtuals: false } }
);

export const ComplianceFrameworkModel: Model<IComplianceFrameworkDocument> =
  model<IComplianceFrameworkDocument>('ComplianceFramework', ComplianceFrameworkSchema);
