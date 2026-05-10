// Mongoose model for audit log entries with append-only / hash-chain
// invariants enforced at the schema level.
//
// Persistence target for ADR-0017 (Audit Logging Strategy) and DDD-11.
//
// IMPORTANT: This collection is append-only. The schema refuses
// `updateOne`, `updateMany`, `findOneAndUpdate`, `deleteOne`, `deleteMany`,
// and `findOneAndDelete` so audit immutability holds even against a buggy
// caller. Retention is enforced *out-of-band* by the archive job (see
// ADR-0017 §"Indexing"); it must operate via a privileged path that
// bypasses the model layer.

import mongoose, { Schema, Document, Query, Types } from 'mongoose';

/**
 * Reference to the actor responsible for the request being audited.
 * Exactly one of `userId` / `serviceAccountId` should be populated for
 * non-system actions; `system: true` is reserved for unauthenticated
 * paths (e.g. health probes) and scheduled jobs.
 */
export interface ActorRef {
  userId?: string;
  serviceAccountId?: string;
  system?: boolean;
}

/**
 * Tamper-evidence chain stamped onto every entry.
 *
 * `currentHash = sha256( canonical_json(entryWithoutChain) || previousHash )`.
 * `previousHash` is `'0'.repeat(64)` for the genesis entry of a shard.
 */
export interface HashChain {
  shard: string;
  sequence: number;
  previousHash: string;
  currentHash: string;
}

export interface AuditLogEntry {
  _id: Types.ObjectId;
  actor: ActorRef;
  action: string;
  resource: string;
  resourceId?: string;
  details: Record<string, unknown>;
  ipAddress: string;
  userAgent: string;
  sessionId?: string;
  timestamp: Date;
  chain: HashChain;
}

export type AuditLogDocument = AuditLogEntry & Document;

const ActorRefSchema = new Schema<ActorRef>(
  {
    userId: { type: String, index: true },
    serviceAccountId: { type: String },
    system: { type: Boolean },
  },
  { _id: false }
);

const HashChainSchema = new Schema<HashChain>(
  {
    shard: { type: String, required: true },
    sequence: { type: Number, required: true },
    previousHash: { type: String, required: true },
    currentHash: { type: String, required: true },
  },
  { _id: false }
);

const AuditLogSchema = new Schema<AuditLogDocument>(
  {
    actor: { type: ActorRefSchema, required: true },
    action: { type: String, required: true, index: true },
    resource: { type: String, required: true },
    resourceId: { type: String },
    details: { type: Schema.Types.Mixed, default: {} },
    ipAddress: { type: String, required: true },
    userAgent: { type: String, required: true, default: 'unknown' },
    sessionId: { type: String },
    timestamp: { type: Date, required: true, default: Date.now, index: true },
    chain: { type: HashChainSchema, required: true },
  },
  {
    // We manage `timestamp` ourselves; auto-`createdAt`/`updatedAt` would
    // be redundant and `updatedAt` actively contradicts append-only.
    timestamps: false,
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        delete ret['__v'];
        return ret;
      },
    },
  }
);

// Indexes per DDD-11 §Persistence and DDD-14.
AuditLogSchema.index({ timestamp: -1 });
AuditLogSchema.index({ 'actor.userId': 1, timestamp: -1 });
AuditLogSchema.index({ action: 1, timestamp: -1 });
AuditLogSchema.index({ resource: 1, resourceId: 1, timestamp: -1 });
// Unique chain ordering per shard. This is a backstop for the single-writer
// invariant in `HashChainAppender`: two writers racing on the same shard
// will collide here and the loser must retry.
AuditLogSchema.index(
  { 'chain.shard': 1, 'chain.sequence': 1 },
  { unique: true }
);

// --- Append-only enforcement ---------------------------------------------
//
// Mongoose pre-hooks fire before the underlying driver call, which gives us
// a single chokepoint to refuse mutating operations. We reject *both*
// `Query.prototype.updateOne` and the document-level `save` path when the
// document is not new (covers `doc.save()` after `findOne` -> mutate).

const REFUSE_MESSAGE = 'auditLogs is append-only';

function refuseUpdate(
  this: Query<unknown, unknown>,
  next: (err?: Error) => void
): void {
  next(new Error(`${REFUSE_MESSAGE}: update blocked`));
}

function refuseDelete(
  this: Query<unknown, unknown>,
  next: (err?: Error) => void
): void {
  next(new Error(`${REFUSE_MESSAGE}: delete blocked`));
}

// Note: `pre('updateOne'|'updateMany'|...)` registers TWO middleware in
// Mongoose — one for queries, one for documents. We only want the query
// path; the document path for `updateOne` would also fire on `save()` of a
// modified doc but we already cover that via `pre('save')` below.
AuditLogSchema.pre('updateOne', { query: true, document: false }, refuseUpdate);
AuditLogSchema.pre('updateMany', refuseUpdate);
AuditLogSchema.pre('findOneAndUpdate', refuseUpdate);
AuditLogSchema.pre('replaceOne', refuseUpdate);
AuditLogSchema.pre('deleteOne', { query: true, document: false }, refuseDelete);
AuditLogSchema.pre('deleteMany', refuseDelete);
AuditLogSchema.pre('findOneAndDelete', refuseDelete);
AuditLogSchema.pre('findOneAndReplace', refuseUpdate);

// Refuse `save` on a non-new document (i.e. an in-place mutation).
AuditLogSchema.pre('save', function (next) {
  if (!this.isNew) {
    next(new Error(`${REFUSE_MESSAGE}: in-place save blocked`));
    return;
  }
  next();
});

// Tag the schema so callers (and tests) can detect the immutability mode.
(AuditLogSchema as unknown as { __appendOnly: boolean }).__appendOnly = true;

export const AuditLogModel = mongoose.model<AuditLogDocument>(
  'AuditLog',
  AuditLogSchema,
  'auditLogs'
);

export { AuditLogSchema };
