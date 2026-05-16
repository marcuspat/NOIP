// Mongoose schema for the `slos` collection.

import mongoose, { Schema, type Model } from 'mongoose';
import type { SLOPersistence } from '../../domain/slo';

const SLOTargetSchema = new Schema(
  {
    kind: {
      type: String,
      enum: ['availability', 'latency_ms', 'error_rate'],
      required: true,
    },
    value: { type: Number, required: true },
  },
  { _id: false }
);

const WindowSchema = new Schema(
  {
    rollingDays: { type: Number, required: true },
  },
  { _id: false }
);

const IndicatorSchema = new Schema(
  {
    query: { type: String, required: true },
    label: { type: String, required: false },
  },
  { _id: false }
);

const SLOSchema = new Schema<SLOPersistence>(
  {
    id: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    target: { type: SLOTargetSchema, required: true },
    window: { type: WindowSchema, required: true },
    indicators: { type: [IndicatorSchema], default: [] },
    currentBurnRate: { type: Number, default: 0 },
    remainingBudget: { type: Number, default: 1 },
    breached: { type: Boolean, default: false, index: true },
    updatedAt: { type: String, required: true },
    createdAt: { type: String, required: true },
  },
  {
    collection: 'slos',
    versionKey: false,
    timestamps: false,
    minimize: false,
  }
);

export const SLOModel: Model<SLOPersistence> =
  (mongoose.models['PerformanceSLO'] as Model<SLOPersistence>) ??
  mongoose.model<SLOPersistence>('PerformanceSLO', SLOSchema);
