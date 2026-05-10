// Mongoose schema for the `learningPatterns` collection.

import mongoose, { Schema, type Model } from 'mongoose';
import type { LearningPatternPersistence } from '../../domain/learning-pattern';

const EmbeddingSchema = new Schema(
  {
    vector: { type: [Number], default: [] },
    modelId: { type: String, default: '' },
  },
  { _id: false }
);

const LearningPatternSchema = new Schema<LearningPatternPersistence>(
  {
    id: { type: String, required: true, unique: true, index: true },
    type: { type: String, required: true },
    pattern: { type: String, required: true },
    signature: { type: String, required: true, index: true },
    confidence: { type: Number, default: 0 },
    successRate: { type: Number, default: 0 },
    embedding: { type: EmbeddingSchema, default: null },
    context: { type: Schema.Types.Mixed, default: {} },
    createdAt: { type: String, required: true },
    lastUsed: { type: String, required: true },
    usageCount: { type: Number, default: 0 },
    reinforcementCount: { type: Number, default: 0 },
    weakeningCount: { type: Number, default: 0 },
    deprecatedAt: { type: String, default: null },
  },
  { collection: 'learningPatterns', versionKey: false, timestamps: false }
);

LearningPatternSchema.index({ type: 1, confidence: -1 });

export const LearningPatternModel: Model<LearningPatternPersistence> =
  (mongoose.models['AILearningPattern'] as Model<LearningPatternPersistence>) ??
  mongoose.model<LearningPatternPersistence>(
    'AILearningPattern',
    LearningPatternSchema
  );
