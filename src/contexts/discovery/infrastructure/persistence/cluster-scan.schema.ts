// Mongoose schema for the `clusterScans` collection.
//
// Indexes match DDD-06: `(clusterId, startedAt: -1)` for the
// most-recent-scan-per-cluster query the service uses.

import mongoose, { Schema, type Model } from 'mongoose';
import type { ClusterScanPersistence } from '../../domain/cluster-scan';

const CountersSchema = new Schema(
  {
    total: { type: Number, default: 0 },
    nodeCount: { type: Number, default: 0 },
    namespaceCount: { type: Number, default: 0 },
    podCount: { type: Number, default: 0 },
    serviceCount: { type: Number, default: 0 },
    deploymentCount: { type: Number, default: 0 },
  },
  { _id: false }
);

const ScanErrorSchema = new Schema(
  {
    code: { type: String, required: true },
    message: { type: String, required: true },
  },
  { _id: false }
);

const ClusterScanSchema = new Schema<ClusterScanPersistence>(
  {
    id: { type: String, required: true, unique: true, index: true },
    clusterId: { type: String, required: true },
    startedAt: { type: String, required: true },
    completedAt: { type: String, default: null },
    status: {
      type: String,
      enum: ['pending', 'running', 'succeeded', 'failed', 'partial'],
      required: true,
    },
    error: { type: ScanErrorSchema, default: null },
    counts: { type: CountersSchema, required: true },
    snapshotId: { type: String, default: null },
  },
  {
    collection: 'clusterScans',
    versionKey: false,
    timestamps: false,
  }
);

ClusterScanSchema.index({ clusterId: 1, startedAt: -1 });

export const ClusterScanModel: Model<ClusterScanPersistence> =
  (mongoose.models['DiscoveryClusterScan'] as Model<ClusterScanPersistence>) ??
  mongoose.model<ClusterScanPersistence>(
    'DiscoveryClusterScan',
    ClusterScanSchema
  );
