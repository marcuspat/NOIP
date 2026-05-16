// Mongoose schema for the `probes` collection.

import mongoose, { Schema, type Model } from 'mongoose';
import type { ProbePersistence } from '../../domain/probe';

const ScheduleSchema = new Schema(
  {
    intervalMs: { type: Number, required: true },
    timeoutMs: { type: Number, required: false },
  },
  { _id: false }
);

const ProbeSchema = new Schema<ProbePersistence>(
  {
    id: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    kind: {
      type: String,
      enum: ['http', 'tcp', 'dns', 'grpc'],
      required: true,
    },
    target: { type: String, required: true },
    labels: { type: Schema.Types.Mixed, default: {} },
    config: { type: Schema.Types.Mixed, default: {} },
    schedule: { type: ScheduleSchema, required: true },
    enabled: { type: Boolean, default: true, index: true },
    sloId: { type: String, default: null },
    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
  },
  {
    collection: 'probes',
    versionKey: false,
    timestamps: false,
    minimize: false,
  }
);

ProbeSchema.index({ enabled: 1, sloId: 1 });

export const ProbeModel: Model<ProbePersistence> =
  (mongoose.models['PerformanceProbe'] as Model<ProbePersistence>) ??
  mongoose.model<ProbePersistence>('PerformanceProbe', ProbeSchema);
