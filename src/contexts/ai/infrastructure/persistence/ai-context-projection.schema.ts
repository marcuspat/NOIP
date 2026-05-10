// Mongoose schema for the `aiContexts` projection collection.

import mongoose, { Schema, type Model } from 'mongoose';
import type { AIContextPersistence } from '../../domain/ai-context';

const EmbeddingSchema = new Schema(
  {
    vector: { type: [Number], default: [] },
    modelId: { type: String, default: '' },
  },
  { _id: false }
);

const AIContextSchema = new Schema<AIContextPersistence>(
  {
    id: { type: String, required: true, unique: true, index: true },
    type: { type: String, required: true },
    content: { type: String, required: true },
    source: { type: String, default: 'unknown' },
    ingestedAt: { type: String, required: true },
    retiredAt: { type: String, default: null },
    confidence: { type: Number, default: 0.8 },
    embedding: { type: EmbeddingSchema, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { collection: 'aiContexts', versionKey: false, timestamps: false }
);

AIContextSchema.index({ type: 1, ingestedAt: -1 });

export const AIContextProjectionModel: Model<AIContextPersistence> =
  (mongoose.models['AIContextProjection'] as Model<AIContextPersistence>) ??
  mongoose.model<AIContextPersistence>('AIContextProjection', AIContextSchema);
