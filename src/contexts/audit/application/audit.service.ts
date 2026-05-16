// AuditService — application service that exposes the read surface of
// the Audit & Observability context (DDD-11 §"Application Services").
//
// All write paths land via the `HashChainAppender` + `installAuditSubscribers`
// pipeline; this service is read-only over those persisted entries plus
// the `SecurityEvent` store.
//
// Responsibilities:
//   - `query(filter)` — paged audit-log search (actor/action/resource/time).
//   - `getEntry(id)` — single audit entry by id.
//   - `verifyChainIntegrity(range)` — recompute the chain over a time
//     window. Routes through `HashChainAppender.verifyRange` so the
//     hashing logic stays in one place.
//   - `listSecurityEvents(filter)` — paged security-event search.
//   - `resolveSecurityEvent(id, by, note)` — analyst close-out.
//   - `streamEvents(handler)` — subscribe to live `iam.*` / `security.*` /
//     `audit.*` events on the in-process EventBus. Returns an
//     `Unsubscribe` handle so the caller can detach.

import type {
  DomainEvent,
  EventBus,
  Unsubscribe,
  AuditId,
} from '../../../shared/kernel';
import type { SecurityEvent } from '../../../types/auth.types';
import type { AuditLogEntry } from '../../../models/audit-log.model';
import type {
  AuditFilter,
  AuditPage,
  ChainIntegrityReport,
  SecurityEventFilter,
  TimeRange,
} from '../domain';
import type { AuditLogRepository } from '../infrastructure/persistence/audit-log.repository';
import type { SecurityEventRepository } from '../infrastructure/persistence/security-event.repository';
import { HashChainAppender } from './hash-chain-appender.service';

export interface AuditServiceLogger {
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const NOOP_LOGGER: AuditServiceLogger = {
  warn: () => undefined,
  error: () => undefined,
};

export interface AuditServiceDeps {
  auditLogRepo: AuditLogRepository;
  securityEventRepo: SecurityEventRepository;
  appender: HashChainAppender;
  bus: EventBus;
  logger?: AuditServiceLogger;
}

const ALL_DOMAIN_PREFIXES: ReadonlyArray<string> = [
  'iam.',
  'security.',
  'compliance.',
  'discovery.',
  'ai.',
  'performance.',
  'dashboard.',
  'audit.',
];

export class AuditService {
  private readonly auditLogRepo: AuditLogRepository;
  private readonly securityEventRepo: SecurityEventRepository;
  private readonly appender: HashChainAppender;
  private readonly bus: EventBus;
  private readonly logger: AuditServiceLogger;

  constructor(deps: AuditServiceDeps) {
    this.auditLogRepo = deps.auditLogRepo;
    this.securityEventRepo = deps.securityEventRepo;
    this.appender = deps.appender;
    this.bus = deps.bus;
    this.logger = deps.logger ?? NOOP_LOGGER;
  }

  query(filter: AuditFilter): Promise<AuditPage> {
    return this.auditLogRepo.query(filter);
  }

  async getEntry(id: AuditId | string): Promise<AuditLogEntry | null> {
    return this.auditLogRepo.findById(id);
  }

  /**
   * Verifies the chain across `range`. We translate the time window to
   * `(shard, sequence)` ranges by reading the first/last entry whose
   * `timestamp` falls inside the window, then defer to
   * `HashChainAppender.verifyRange`.
   *
   * When `range.shard` is absent we walk every known shard; the
   * returned report covers the *first* failure encountered (callers
   * typically want one-shot pass/fail). Per-shard reports are
   * available via `TransparencyLogService.verifyChainIntegrity`.
   */
  async verifyChainIntegrity(
    range: TimeRange & { shard?: string }
  ): Promise<ChainIntegrityReport> {
    const shards = range.shard
      ? [range.shard]
      : await this.auditLogRepo.listShards();
    let lastReport: ChainIntegrityReport = {
      ok: true,
      shard: range.shard ?? 'global',
      fromSequence: 0,
      toSequence: -1,
      checked: 0,
    };
    for (const shard of shards) {
      const tip = await this.auditLogRepo.latestTipForShard(shard);
      if (!tip) {
        lastReport = {
          ok: true,
          shard,
          fromSequence: 0,
          toSequence: -1,
          checked: 0,
        };
        continue;
      }
      // `verifyRange` walks from genesis; cheap enough at audit
      // volumes today and correct under the chain invariant. A later
      // optimisation can index `timestamp → sequence` to limit the
      // walk to the requested window.
      const report = await this.appender.verifyRange(shard, 0, tip.sequence);
      lastReport = report;
      if (!report.ok) return report;
    }
    return lastReport;
  }

  listSecurityEvents(filter: SecurityEventFilter): Promise<SecurityEvent[]> {
    return this.securityEventRepo.query(filter);
  }

  getSecurityEvent(id: string): Promise<SecurityEvent | null> {
    return this.securityEventRepo.findById(id);
  }

  resolveSecurityEvent(
    id: string,
    by: string,
    note?: string
  ): Promise<SecurityEvent | null> {
    return this.securityEventRepo.resolve(id, by, note);
  }

  /**
   * Live stream of every cross-context DomainEvent the audit context
   * cares about. Returns the bus' `Unsubscribe` so the caller can
   * detach without leaking subscriptions.
   *
   * The handler is invoked synchronously by the in-process bus per
   * ADR-0018; errors thrown inside `handler` are caught and logged so
   * one bad consumer can't poison the stream.
   */
  streamEvents(handler: (evt: DomainEvent<unknown>) => void): Unsubscribe {
    const handles: Unsubscribe[] = [];
    for (const prefix of ALL_DOMAIN_PREFIXES) {
      const off = this.bus.subscribe(
        `${prefix}*`,
        (evt: DomainEvent<unknown>) => {
          try {
            handler(evt);
          } catch (err) {
            this.logger.error('audit.streamEvents handler threw', {
              eventType: evt.type,
              eventId: evt.id,
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
      );
      handles.push(off);
    }
    return () => {
      for (const off of handles) {
        try {
          off();
        } catch (err) {
          this.logger.warn('failed to detach stream subscription', {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };
  }
}
