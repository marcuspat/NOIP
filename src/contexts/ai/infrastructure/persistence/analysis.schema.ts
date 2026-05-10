// Mongoose schema for the `aiAnalyses` collection.

import mongoose, { Schema, type Model } from 'mongoose';
import type { AnalysisPersistence } from '../../domain/analysis';

const ScopeSchema = new Schema(
  {
    clusterId: { type: String, required: true },
    namespace: { type: String, required: false },
    kind: { type: String, required: false },
  },
  { _id: false }
);

const StrategySchema = new Schema(
  {
    modelId: { type: String, required: true },
    promptTemplateHash: { type: String, required: true },
    retrievalPolicy: {
      topK: { type: Number, required: true },
      filter: { type: Schema.Types.Mixed, required: false },
      collections: { type: [String], required: false },
    },
  },
  { _id: false }
);

const TokenUsageSchema = new Schema(
  {
    input: { type: Number, default: 0 },
    output: { type: Number, default: 0 },
    cacheRead: { type: Number, default: 0 },
    cacheWrite: { type: Number, default: 0 },
  },
  { _id: false }
);

const MoneySchema = new Schema(
  {
    amount: { type: Number, default: 0 },
    currency: { type: String, default: 'USD' },
  },
  { _id: false }
);

const RedactionReportSchema = new Schema(
  {
    secretsRedacted: { type: Number, default: 0 },
    piiPseudonymised: { type: Number, default: 0 },
    idsOpaqued: { type: Number, default: 0 },
    bytesScrubbed: { type: Number, default: 0 },
  },
  { _id: false }
);

const ActorRefSchema = new Schema(
  {
    type: { type: String, enum: ['user', 'system', 'service'], required: true },
    userId: { type: String, required: false },
    serviceAccountId: { type: String, required: false },
  },
  { _id: false }
);

const ErrorSchema = new Schema(
  {
    code: { type: String, required: true },
    message: { type: String, required: true },
  },
  { _id: false }
);

const AnalysisSchema = new Schema<AnalysisPersistence>(
  {
    id: { type: String, required: true, unique: true, index: true },
    type: { type: String, required: true },
    scope: { type: ScopeSchema, required: true },
    strategy: { type: StrategySchema, required: true },
    status: {
      type: String,
      enum: ['requested', 'running', 'succeeded', 'failed'],
      required: true,
    },
    retrieved: { type: Schema.Types.Mixed, default: [] },
    insights: { type: Schema.Types.Mixed, default: [] },
    recommendations: { type: Schema.Types.Mixed, default: [] },
    predictions: { type: Schema.Types.Mixed, default: [] },
    confidence: { type: Number, default: 0 },
    tokens: { type: TokenUsageSchema, required: true },
    costEstimate: { type: MoneySchema, required: true },
    redaction: { type: RedactionReportSchema, required: true },
    processingTimeMs: { type: Number, default: 0 },
    requestedAt: { type: String, required: true },
    completedAt: { type: String, default: null },
    requestedBy: { type: ActorRefSchema, required: true },
    error: { type: ErrorSchema, default: null },
  },
  { collection: 'aiAnalyses', versionKey: false, timestamps: false }
);

AnalysisSchema.index({ 'scope.clusterId': 1, type: 1, completedAt: -1 });

export const AnalysisModel: Model<AnalysisPersistence> =
  (mongoose.models['AIAnalysis'] as Model<AnalysisPersistence>) ??
  mongoose.model<AnalysisPersistence>('AIAnalysis', AnalysisSchema);
