// Mongoose schema for the `dashboards` collection (DDD-10 / DDD-14).
//
// Per ADR-0011, schemas live next to the repository that uses them and
// are NOT imported anywhere else. The repository wraps the model in a
// domain-friendly interface; the rest of the codebase only sees the
// `Dashboard` aggregate.

import mongoose, { Schema, type Model } from 'mongoose';
import type { DashboardPersistence } from '../../domain/dashboard';

const ActorRefSchema = new Schema(
  {
    userId: { type: String, required: true },
  },
  { _id: false }
);

const SharePolicySchema = new Schema(
  {
    visibility: {
      type: String,
      enum: ['private', 'role-scoped', 'organisation'],
      required: true,
    },
    roles: { type: [String], default: undefined },
  },
  { _id: false }
);

const PositionSchema = new Schema(
  {
    x: { type: Number, required: true },
    y: { type: Number, required: true },
    w: { type: Number, required: true },
    h: { type: Number, required: true },
  },
  { _id: false }
);

const DatasourceSchema = new Schema(
  {
    contextRef: { type: String, required: true },
    query: { type: String, required: true },
    parameters: { type: Schema.Types.Mixed, default: undefined },
  },
  { _id: false }
);

const WidgetSchema = new Schema(
  {
    id: { type: String, required: true },
    type: {
      type: String,
      enum: ['chart', 'metric', 'table', 'alert'],
      required: true,
    },
    title: { type: String, required: true },
    datasource: { type: DatasourceSchema, required: true },
    config: { type: Schema.Types.Mixed, default: {} },
    position: { type: PositionSchema, required: true },
    refreshIntervalSec: { type: Number, required: false },
  },
  { _id: false }
);

const DashboardSchema = new Schema<DashboardPersistence>(
  {
    id: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    description: { type: String, default: '' },
    layout: {
      type: String,
      enum: ['grid', 'flex'],
      required: true,
    },
    refreshIntervalSec: { type: Number, required: true },
    widgets: { type: [WidgetSchema], default: [] },
    ownedBy: { type: ActorRefSchema, required: true },
    share: { type: SharePolicySchema, required: true },
    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
  },
  {
    collection: 'dashboards',
    versionKey: false,
    timestamps: false,
  }
);

DashboardSchema.index({ 'ownedBy.userId': 1, updatedAt: -1 });
DashboardSchema.index({ 'share.visibility': 1 });

export const DashboardModel: Model<DashboardPersistence> =
  (mongoose.models['DashboardDashboard'] as Model<DashboardPersistence>) ??
  mongoose.model<DashboardPersistence>('DashboardDashboard', DashboardSchema);
