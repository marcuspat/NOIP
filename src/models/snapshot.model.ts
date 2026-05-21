import { Schema, model, Document, Model } from 'mongoose';

export interface ResourceRecord {
  apiVersion: string;
  kind: string;
  namespace?: string;
  name: string;
  fingerprint: string; // SHA-256 of canonical JSON
  rawSpec: Record<string, unknown>;
}

export interface ISnapshot {
  clusterId: string;
  takenAt: Date;
  resourceCount: number;
  resources: ResourceRecord[];
  triggeredBy: 'scheduled' | 'manual' | 'drift-alert';
}

export interface ISnapshotDocument extends Omit<ISnapshot, '_id'>, Document {}

const ResourceRecordSchema = new Schema<ResourceRecord>(
  {
    apiVersion: { type: String, required: true },
    kind: { type: String, required: true },
    namespace: { type: String },
    name: { type: String, required: true },
    fingerprint: { type: String, required: true },
    rawSpec: { type: Schema.Types.Mixed, required: true },
  },
  { _id: false }
);

const SnapshotSchema = new Schema<ISnapshotDocument>(
  {
    clusterId: { type: String, required: true, index: true },
    takenAt: { type: Date, required: true, default: () => new Date() },
    resourceCount: { type: Number, required: true, default: 0 },
    resources: { type: [ResourceRecordSchema], default: [] },
    triggeredBy: {
      type: String,
      enum: ['scheduled', 'manual', 'drift-alert'],
      required: true,
      default: 'scheduled',
    },
  },
  {
    timestamps: false,
    toJSON: { virtuals: false },
  }
);

// Snapshots are immutable — prevent updates after creation
SnapshotSchema.pre('findOneAndUpdate', function () {
  throw new Error('Snapshots are immutable');
});
SnapshotSchema.pre('updateOne', function () {
  throw new Error('Snapshots are immutable');
});

SnapshotSchema.index({ clusterId: 1, takenAt: -1 });

export const SnapshotModel: Model<ISnapshotDocument> = model<ISnapshotDocument>(
  'Snapshot',
  SnapshotSchema
);
