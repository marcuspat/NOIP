import { Schema, model, Document, Model } from 'mongoose';

export type ClusterStatus = 'active' | 'unreachable' | 'decommissioned';

export interface ICluster {
  name: string;
  endpoint: string;
  credentialRef: string; // reference to a secret/credential store key
  addedAt: Date;
  lastScanAt?: Date;
  status: ClusterStatus;
  metadata?: Record<string, string>;
}

export interface IClusterDocument extends Omit<ICluster, '_id'>, Document {}

const ClusterSchema = new Schema<IClusterDocument>(
  {
    name: { type: String, required: true, unique: true, trim: true },
    endpoint: { type: String, required: true, trim: true },
    credentialRef: { type: String, required: true },
    addedAt: { type: Date, required: true, default: () => new Date() },
    lastScanAt: { type: Date },
    status: {
      type: String,
      enum: ['active', 'unreachable', 'decommissioned'],
      default: 'active',
    },
    metadata: { type: Map, of: String },
  },
  {
    timestamps: false,
    toJSON: { virtuals: false },
  }
);

ClusterSchema.index({ status: 1 });
ClusterSchema.index({ lastScanAt: 1 });

export const ClusterModel: Model<IClusterDocument> = model<IClusterDocument>(
  'Cluster',
  ClusterSchema
);
