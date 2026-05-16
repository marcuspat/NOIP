// Mongoose schema for the `probeResults` collection.
//
// TTL: Mongoose `expires` honoured on the `at` field. We declare `at`
// as a Date with `expires: 30 days` (per DDD-09). The driver creates a
// background TTL index that drops documents whose `at + 30d < now`.

import mongoose, { Schema, type Model } from 'mongoose';
import type { ProbeResultPersistence } from '../../domain/probe-result';

const TTL_DAYS = 30;
const TTL_SECONDS = TTL_DAYS * 24 * 60 * 60;

const MeasurementsSchema = new Schema(
  {
    dnsMs: { type: Number, required: false },
    connectMs: { type: Number, required: false },
    ttfbMs: { type: Number, required: false },
    bytes: { type: Number, required: false },
    statusCode: { type: Number, required: false },
  },
  { _id: false }
);

// The Mongoose Schema generic is intentionally widened to `unknown` for
// the `at` field — the document stores a JS `Date` (so the TTL index
// fires correctly) but the domain `ProbeResultPersistence` declares it
// as an ISO string. The repository converts both ways.
const ProbeResultSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    probeId: { type: String, required: true, index: true },
    at: { type: Date, required: true, expires: TTL_SECONDS },
    latencyMs: { type: Number, required: true },
    success: { type: Boolean, required: true, index: true },
    failureReason: { type: String, default: null },
    measurements: { type: MeasurementsSchema, default: {} },
    sloId: { type: String, default: null, index: true },
    target: { type: String, required: true },
  },
  {
    collection: 'probeResults',
    versionKey: false,
    timestamps: false,
    minimize: false,
  }
);

ProbeResultSchema.index({ probeId: 1, at: -1 });

export const ProbeResultModel: Model<ProbeResultPersistence> =
  (mongoose.models['PerformanceProbeResult'] as
    | Model<ProbeResultPersistence>
    | undefined) ??
  (mongoose.model(
    'PerformanceProbeResult',
    ProbeResultSchema
  ) as unknown as Model<ProbeResultPersistence>);
