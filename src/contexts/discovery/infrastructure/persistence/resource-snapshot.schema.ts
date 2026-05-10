// Mongoose schema for `resourceSnapshots`.
//
// Indexes per DDD-06 / DDD-14:
//   - `(clusterId, takenAt: -1)` — chronological listing.
//   - `(clusterId, hash: 1)` UNIQUE — collapses no-change scans.
//
// Records embedded as a sub-doc array. We use `Schema.Types.Mixed`
// for `spec`/`status` because the kube apiserver returns arbitrarily
// nested JSON we do not want Mongoose to validate.

import mongoose, { Schema, type Model } from 'mongoose';
import type { ResourceSnapshotPersistence } from '../../domain/resource-snapshot';

const RecordSchema = new Schema(
  {
    apiVersion: { type: String, required: true },
    kind: { type: String, required: true },
    namespace: { type: String },
    name: { type: String, required: true },
    labels: { type: Schema.Types.Mixed, default: {} },
    annotations: { type: Schema.Types.Mixed, default: {} },
    spec: { type: Schema.Types.Mixed },
    status: { type: Schema.Types.Mixed },
  },
  { _id: false, minimize: false }
);

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

const ResourceSnapshotSchema = new Schema<ResourceSnapshotPersistence>(
  {
    id: { type: String, required: true, unique: true, index: true },
    clusterId: { type: String, required: true },
    scanId: { type: String, required: true },
    takenAt: { type: String, required: true },
    hash: { type: String, required: true },
    counts: { type: CountersSchema, required: true },
    records: { type: [RecordSchema], default: [] },
  },
  {
    collection: 'resourceSnapshots',
    versionKey: false,
    timestamps: false,
    minimize: false,
  }
);

ResourceSnapshotSchema.index({ clusterId: 1, takenAt: -1 });
ResourceSnapshotSchema.index({ clusterId: 1, hash: 1 }, { unique: true });

export const ResourceSnapshotModel: Model<ResourceSnapshotPersistence> =
  (mongoose.models[
    'DiscoveryResourceSnapshot'
  ] as Model<ResourceSnapshotPersistence>) ??
  mongoose.model<ResourceSnapshotPersistence>(
    'DiscoveryResourceSnapshot',
    ResourceSnapshotSchema
  );
