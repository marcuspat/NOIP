// Mongoose schema for the `clusters` collection (DDD-14).
//
// Per ADR-0011, schemas live next to the repository that uses them and
// are NOT imported anywhere else. The repository wraps the model in a
// domain-friendly interface; the rest of the codebase only sees the
// `Cluster` aggregate.

import mongoose, { Schema, type Model } from 'mongoose';
import type { ClusterPersistence } from '../../domain/cluster';

const ClusterCredentialsRefSchema = new Schema(
  {
    ref: { type: String, required: true },
  },
  { _id: false }
);

const ClusterSchema = new Schema<ClusterPersistence>(
  {
    id: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    endpoint: { type: String, required: true },
    version: { type: String, default: '' },
    credentials: { type: ClusterCredentialsRefSchema, required: true },
    registeredAt: { type: String, required: true },
    lastScanAt: { type: String, default: null },
    enabled: { type: Boolean, default: true, index: true },
  },
  {
    collection: 'clusters',
    versionKey: false,
    timestamps: false,
  }
);

ClusterSchema.index({ enabled: 1, registeredAt: -1 });

// `mongoose.models` cache prevents OverwriteModelError when the schema
// loads twice in tests / hot-reload.
export const ClusterModel: Model<ClusterPersistence> =
  (mongoose.models['DiscoveryCluster'] as Model<ClusterPersistence>) ??
  mongoose.model<ClusterPersistence>('DiscoveryCluster', ClusterSchema);
