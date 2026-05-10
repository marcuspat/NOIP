import { Schema, Document, model } from 'mongoose';
import { AuditLog } from '../types/auth.types';

export interface AuditLogDocument extends Omit<AuditLog, '_id'>, Document {}

const AuditLogSchema = new Schema(
  {
    correlationId: { type: String, index: true },
    actor: {
      kind: { type: String, enum: ['user', 'system', 'service'] },
      id: { type: String, index: true },
      sessionId: String,
    },
    action: { type: String, index: true },
    targetKind: { type: String, index: true },
    targetId: { type: String, index: true },
    outcome: { type: String, enum: ['success', 'failure'], index: true },
    request: {
      method: String,
      path: String,
      ip: String,
      userAgent: String,
      status: Number,
      latencyMs: Number,
    },
    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
    errorClass: String,
    occurredAt: { type: Date, default: Date.now, index: true },
    severity: { type: String, default: 'info' },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        delete ret.__v;
        return ret;
      },
    },
  }
);

AuditLogSchema.index({ occurredAt: -1 });
AuditLogSchema.index({ 'actor.id': 1, occurredAt: -1 });
AuditLogSchema.index({ targetKind: 1, targetId: 1, occurredAt: -1 });

export const AuditLogModel = model<AuditLogDocument>('AuditLog', AuditLogSchema);
