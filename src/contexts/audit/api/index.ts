// Public API barrel for the Audit & Observability context.
// Per ADR-0011 / DDD-11 cross-context code MUST only import from this
// module.
//
// What we expose:
//   - The `AuditPublicApi` interface (DDD-11).
//   - The aggregate / value types other contexts compose with
//     (`AuditFilter`, `AuditPage`, `ChainIntegrityReport`, …).
//   - The `composeAudit` factory that wires the application service,
//     archive service, and transparency-log service for the composition
//     root and tests.
//   - The HTTP router factory.
//   - The middleware factory and back-compat class (so route files can
//     keep importing through this barrel rather than the legacy
//     middleware path).
//
// Anything not re-exported here is private to the context.

import type {
  AuditId,
  Clock,
  DomainEvent,
  EventBus,
  Unsubscribe,
} from '../../../shared/kernel';
import { AuditService } from '../application/audit.service';
import type { AuditServiceLogger } from '../application/audit.service';
import {
  HashChainAppender,
  type AuditLogger,
} from '../application/hash-chain-appender.service';
import { SecurityEventService } from '../application/security-event.service';
import { installAuditSubscribers } from '../application/event-subscribers';
import { ArchiveService } from '../application/archive.service';
import type { ArchiveServiceLogger } from '../application/archive.service';
import { TransparencyLogService } from '../application/transparency-log.service';
import type { TransparencyLogServiceLogger } from '../application/transparency-log.service';
import {
  MongooseAuditLogRepository,
  type AuditLogRepository,
} from '../infrastructure/persistence/audit-log.repository';
import {
  MongooseSecurityEventRepository,
  type SecurityEventRepository,
} from '../infrastructure/persistence/security-event.repository';
import {
  MongooseRetentionPolicyRepository,
  type RetentionPolicyRepository,
} from '../infrastructure/persistence/retention-policy.repository';
import { TransparencyLogStub } from '../infrastructure/transparency/transparency-log-stub';
import type { AuditArchiveStore } from '../domain/ports/archive-store';
import type { TransparencyLog } from '../domain/ports/transparency-log';
import type { SecurityEventStore } from '../application/security-event.service';
import type {
  AuditFilter,
  AuditPage,
  SecurityEventFilter,
  TimeRange,
} from '../domain/value-objects';
import type { ChainIntegrityReport } from '../domain/chain-integrity-report';
import type { SecurityEvent } from '../../../types/auth.types';
import type { AuditLogEntry } from '../../../models/audit-log.model';
import { AuditLogModel } from '../../../models/audit-log.model';
import { createAuditRouter } from '../http/routes';

// ---------------------------------------------------------------------------
// Re-exports (public domain types + middleware)
// ---------------------------------------------------------------------------

export type {
  AuditFilter,
  AuditPage,
  SecurityEventFilter,
  TimeRange,
  HashChain,
  ActorRef,
} from '../domain/value-objects';
export type { ChainIntegrityReport } from '../domain/chain-integrity-report';
export {
  RetentionPolicy,
  DEFAULT_RETENTION,
  type RetentionCollection,
} from '../domain/retention-policy';
export type {
  AuditArchiveStore,
  AuditArchiveUploadOpts,
  AuditArchiveUploadResult,
} from '../domain/ports/archive-store';
export { buildAuditArchiveKey } from '../domain/ports/archive-store';
export type {
  TransparencyLog,
  TransparencyLogReceipt,
  TransparencyLogSubmission,
} from '../domain/ports/transparency-log';

export {
  HashChainAppender,
  DEFAULT_SHARD,
  canonicalJson,
  computeEntryHash,
} from '../application/hash-chain-appender.service';
export type {
  AuditCollection,
  AuditEntryInput,
  AuditLogger,
} from '../application/hash-chain-appender.service';

export {
  SecurityEventService,
  defaultSeverityFor,
} from '../application/security-event.service';
export type {
  SecurityEventInput,
  SecurityEventPersistShape,
  SecurityEventStore,
} from '../application/security-event.service';

export {
  installAuditSubscribers,
  toSecurityEventInput,
} from '../application/event-subscribers';
export type {
  AuditSubscribersLogger,
  InstallAuditSubscribersDeps,
} from '../application/event-subscribers';

export { ArchiveService } from '../application/archive.service';
export type {
  ArchiveServiceDeps,
  ArchiveServiceLogger,
  ArchiveSweepSummary,
  AuditArchiveCompletedPayload,
} from '../application/archive.service';

export { TransparencyLogService } from '../application/transparency-log.service';
export type {
  SubmitSummary,
  TransparencyLogServiceDeps,
  TransparencyLogServiceLogger,
} from '../application/transparency-log.service';

export {
  MongooseAuditLogRepository,
  defaultAuditLogRepository,
} from '../infrastructure/persistence/audit-log.repository';
export type { AuditLogRepository } from '../infrastructure/persistence/audit-log.repository';

export {
  MongooseSecurityEventRepository,
  defaultSecurityEventRepository,
} from '../infrastructure/persistence/security-event.repository';
export type { SecurityEventRepository } from '../infrastructure/persistence/security-event.repository';

export {
  MongooseRetentionPolicyRepository,
  defaultRetentionPolicyRepository,
} from '../infrastructure/persistence/retention-policy.repository';
export type { RetentionPolicyRepository } from '../infrastructure/persistence/retention-policy.repository';

export { LocalFsAuditArchiveStore } from '../infrastructure/archive/local-fs-archive-store';
export type { LocalFsAuditArchiveStoreOpts } from '../infrastructure/archive/local-fs-archive-store';
export {
  S3AuditArchiveStore,
  defaultS3Factory,
} from '../infrastructure/archive/s3-archive-store';
export type {
  S3AuditArchiveStoreOpts,
  S3AuditArchiveStoreEnv,
  S3ClientFactory,
  S3ClientLike,
} from '../infrastructure/archive/s3-archive-store';

export { TransparencyLogStub } from '../infrastructure/transparency/transparency-log-stub';
export {
  RekorTransparencyLog,
  createRekorIfConfigured,
} from '../infrastructure/transparency/rekor-transparency-log';
export type {
  RekorTransparencyLogEnv,
  RekorTransparencyLogOpts,
} from '../infrastructure/transparency/rekor-transparency-log';

export { AuditService } from '../application/audit.service';
export type {
  AuditServiceLogger,
  AuditServiceDeps,
} from '../application/audit.service';

export {
  NON_AUDITED_PATHS,
  auditMiddleware,
  AuditMiddleware,
  setAuditAppender,
  addRequestTiming,
} from '../http/audit-middleware';
export type { AuditMiddlewareOptions } from '../http/audit-middleware';

export { createAuditRouter } from '../http/routes';

// ---------------------------------------------------------------------------
// Public API contract per DDD-11
// ---------------------------------------------------------------------------

export interface AuditPublicApi {
  query(filter: AuditFilter): Promise<AuditPage>;
  getEntry(id: AuditId | string): Promise<AuditLogEntry | null>;
  verifyChainIntegrity(
    range: TimeRange & { shard?: string }
  ): Promise<ChainIntegrityReport>;
  listSecurityEvents(filter: SecurityEventFilter): Promise<SecurityEvent[]>;
  streamEvents(handler: (evt: DomainEvent<unknown>) => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface ComposeAuditDeps {
  /** Connected mongoose instance is implicit. */
  bus: EventBus;
  clock: Clock;
  logger: AuditLogger;
  /**
   * Mongoose model for the `securityEvents` collection. The composition
   * root already imports `SecurityEventModel`; passing it in lets the
   * factory stay model-free for tests.
   */
  securityEventStore: SecurityEventStore;
  /** Optional repository overrides (tests use in-memory stubs). */
  auditLogRepository?: AuditLogRepository;
  securityEventRepository?: SecurityEventRepository;
  retentionRepository?: RetentionPolicyRepository;
  /** Optional cold-tier object store. */
  archiveStore?: AuditArchiveStore;
  /** Optional transparency log. Defaults to the in-memory stub. */
  transparencyLog?: TransparencyLog;
  /** Loggers (default to the appender logger). */
  archiveLogger?: ArchiveServiceLogger;
  transparencyLogger?: TransparencyLogServiceLogger;
  auditLogger?: AuditServiceLogger;
}

export interface ComposedAudit {
  service: AuditService;
  appender: HashChainAppender;
  securityEvents: SecurityEventService;
  subscriberHandles: Unsubscribe[];
  archive: ArchiveService;
  transparency: TransparencyLogService;
  publicApi: AuditPublicApi;
  router: ReturnType<typeof createAuditRouter>;
}

/**
 * Wires the audit context. The composition root in `src/app.ts` calls
 * this exactly once per pod.
 *
 * Construction order matters: the appender + security-event service
 * are built first so the subscribers can pick them up, and the
 * archive + transparency services are built last so they hold
 * references to the live repositories.
 */
export function composeAudit(deps: ComposeAuditDeps): ComposedAudit {
  const auditLogRepo =
    deps.auditLogRepository ?? new MongooseAuditLogRepository();
  const securityEventRepo =
    deps.securityEventRepository ?? new MongooseSecurityEventRepository();
  const retentionRepo =
    deps.retentionRepository ?? new MongooseRetentionPolicyRepository();

  const appender = new HashChainAppender({
    collection: buildAppenderCollection(auditLogRepo),
    clock: deps.clock,
    logger: deps.logger,
    eventBus: deps.bus,
  });

  const securityEvents = new SecurityEventService({
    store: deps.securityEventStore,
    logger: deps.logger,
  });

  const subscriberHandles = installAuditSubscribers({
    bus: deps.bus,
    securityEvents,
    appender,
    logger: deps.logger,
  });

  const archive = new ArchiveService({
    auditLogRepo,
    retentionRepo,
    store: deps.archiveStore ?? new InMemoryArchiveStoreFallback(),
    bus: deps.bus,
    clock: deps.clock,
    ...(deps.archiveLogger ? { logger: deps.archiveLogger } : {}),
  });

  const transparency = new TransparencyLogService({
    auditLogRepo,
    appender,
    transparencyLog: deps.transparencyLog ?? new TransparencyLogStub(),
    bus: deps.bus,
    clock: deps.clock,
    ...(deps.transparencyLogger ? { logger: deps.transparencyLogger } : {}),
  });

  const service = new AuditService({
    auditLogRepo,
    securityEventRepo,
    appender,
    bus: deps.bus,
    ...(deps.auditLogger ? { logger: deps.auditLogger } : {}),
  });

  const publicApi: AuditPublicApi = {
    query: filter => service.query(filter),
    getEntry: id => service.getEntry(id),
    verifyChainIntegrity: range => service.verifyChainIntegrity(range),
    listSecurityEvents: filter => service.listSecurityEvents(filter),
    streamEvents: handler => service.streamEvents(handler),
  };

  const router = createAuditRouter({ service });

  return {
    service,
    appender,
    securityEvents,
    subscriberHandles,
    archive,
    transparency,
    publicApi,
    router,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Bridge the `AuditCollection` shape (used by `HashChainAppender`)
 * onto the new `AuditLogRepository`. The appender reads the latest
 * tip via `findOne({'chain.shard': X}, {sort:{'chain.sequence':-1}})`
 * which `latestTipForShard` covers; `findRange` is its own method;
 * `insertOne` writes via the Mongoose model. We keep the appender
 * agnostic to the repository shape so existing tests don't break.
 */
function buildAppenderCollection(
  repo: AuditLogRepository
): import('../application/hash-chain-appender.service').AuditCollection {
  return {
    async findOne(filter, options) {
      // Optimise the common "latest tip per shard" query that the
      // appender issues on every write via the repository's
      // `latestTipForShard`. Otherwise fall through to the model.
      if (
        options?.sort &&
        options.sort['chain.sequence'] === -1 &&
        typeof filter['chain.shard'] === 'string'
      ) {
        const tip = await repo.latestTipForShard(filter['chain.shard']);
        if (!tip) return null;
        // The appender only inspects `chain.sequence` + `chain.currentHash`,
        // so we can return a minimal projection cast to AuditLogEntry.
        return {
          chain: {
            shard: filter['chain.shard'],
            sequence: tip.sequence,
            previousHash: '',
            currentHash: tip.currentHash,
          },
        } as unknown as AuditLogEntry;
      }
      // For predecessor lookup (sequence: fromSeq-1) just hit the model.
      const q = AuditLogModel.findOne(filter as Record<string, unknown>);
      if (options?.sort) q.sort(options.sort);
      return (await q.lean<unknown>().exec()) as AuditLogEntry | null;
    },
    async insertOne(entry) {
      const created = await AuditLogModel.create(entry);
      return { insertedId: created._id };
    },
    async findRange(shard, fromSeq, toSeq) {
      const docs = await AuditLogModel.find({
        'chain.shard': shard,
        'chain.sequence': { $gte: fromSeq, $lte: toSeq },
      })
        .sort({ 'chain.sequence': 1 })
        .lean<unknown[]>()
        .exec();
      return docs as AuditLogEntry[];
    },
  };
}

/**
 * Safety-net store used when the composition root forgets to wire
 * one. Throws on every method so the misconfiguration surfaces at
 * the first archive sweep instead of dropping data silently.
 */
class InMemoryArchiveStoreFallback implements AuditArchiveStore {
  async upload(): Promise<never> {
    throw new Error(
      'composeAudit: no archiveStore wired — pass one via deps.archiveStore'
    );
  }
  async exists(): Promise<never> {
    throw new Error(
      'composeAudit: no archiveStore wired — pass one via deps.archiveStore'
    );
  }
  async download(): Promise<never> {
    throw new Error(
      'composeAudit: no archiveStore wired — pass one via deps.archiveStore'
    );
  }
  async list(): Promise<never> {
    throw new Error(
      'composeAudit: no archiveStore wired — pass one via deps.archiveStore'
    );
  }
}
