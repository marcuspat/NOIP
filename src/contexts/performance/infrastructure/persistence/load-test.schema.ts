// Mongoose schema for the `loadTests` collection.

import mongoose, { Schema, type Model } from 'mongoose';
import type { LoadTestPersistence } from '../../domain/load-test';

const ProfileSchema = new Schema(
  {
    rps: { type: Number, required: true },
    vus: { type: Number, required: true },
    durationSec: { type: Number, required: true },
    rampUpSec: { type: Number, required: false },
  },
  { _id: false }
);

const LoadTestSummarySchema = new Schema(
  {
    totalRequests: { type: Number, default: 0 },
    successfulRequests: { type: Number, default: 0 },
    failedRequests: { type: Number, default: 0 },
    errorRate: { type: Number, default: 0 },
    rps: { type: Number, default: 0 },
    p50Ms: { type: Number, default: 0 },
    p95Ms: { type: Number, default: 0 },
    p99Ms: { type: Number, default: 0 },
    raw: { type: Schema.Types.Mixed },
  },
  { _id: false, minimize: false }
);

const LoadTestErrorSchema = new Schema(
  {
    code: { type: String, required: true },
    message: { type: String, required: true },
  },
  { _id: false }
);

const LoadTestSchema = new Schema<LoadTestPersistence>(
  {
    id: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    script: { type: String, required: true },
    profile: { type: ProfileSchema, required: true },
    status: {
      type: String,
      enum: ['pending', 'running', 'succeeded', 'failed'],
      required: true,
    },
    startedAt: { type: String, required: true },
    completedAt: { type: String, default: null },
    summary: { type: LoadTestSummarySchema, required: true },
    error: { type: LoadTestErrorSchema, default: null },
    engine: { type: String, required: true },
    target: { type: String, required: true },
  },
  {
    collection: 'loadTests',
    versionKey: false,
    timestamps: false,
    minimize: false,
  }
);

LoadTestSchema.index({ startedAt: -1 });

export const LoadTestModel: Model<LoadTestPersistence> =
  (mongoose.models['PerformanceLoadTest'] as Model<LoadTestPersistence>) ??
  mongoose.model<LoadTestPersistence>('PerformanceLoadTest', LoadTestSchema);
