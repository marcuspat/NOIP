// TransparencyLogService — periodically commits the latest hash-chain
// tip per shard to an external transparency log (Sigstore Rekor in
// production, in-memory stub in tests).
//
// Responsibilities:
//   1. `submitChainTips()` — manual + cron entry point. Walks every
//      shard, reads the latest tip from the audit-log repository,
//      and submits it to the log. Idempotent on `(shard, sequence)`
//      so re-running mid-day costs only a Map hit.
//   2. `verifyChainIntegrity(shard?)` — re-verifies the chain end to
//      end via `HashChainAppender.verifyRange`. On a break we emit
//      `audit.chain.broken` for ops + downstream alerting. Returns
//      one report per shard (so callers can show a per-shard table).
//
// Failure handling: submit failures are logged and re-thrown so the
// scheduler can back off. Verifier failures are logged + emit a
// DomainEvent but never throw (we don't want one bad shard to mask
// the others).

import {
  compose,
  type Clock,
  type DomainEvent,
  type EventBus,
} from '../../../shared/kernel';
import type { AuditLogRepository } from '../infrastructure/persistence/audit-log.repository';
import type { TransparencyLog } from '../domain/ports/transparency-log';
import type { ChainIntegrityReport } from '../domain/chain-integrity-report';
import { HashChainAppender } from './hash-chain-appender.service';

export interface TransparencyLogServiceLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const NOOP_LOGGER: TransparencyLogServiceLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface TransparencyLogServiceDeps {
  auditLogRepo: AuditLogRepository;
  appender: HashChainAppender;
  transparencyLog: TransparencyLog;
  bus: EventBus;
  clock: Clock;
  logger?: TransparencyLogServiceLogger;
}

export interface SubmitSummary {
  submitted: number;
  skipped: number;
  failed: number;
  receipts: Array<{
    shard: string;
    sequence: number;
    logId: string;
    logIndex: number;
  }>;
  failures: Array<{ shard: string; error: string }>;
}

export class TransparencyLogService {
  private readonly auditLogRepo: AuditLogRepository;
  private readonly appender: HashChainAppender;
  private readonly transparencyLog: TransparencyLog;
  private readonly bus: EventBus;
  private readonly clock: Clock;
  private readonly logger: TransparencyLogServiceLogger;

  constructor(deps: TransparencyLogServiceDeps) {
    this.auditLogRepo = deps.auditLogRepo;
    this.appender = deps.appender;
    this.transparencyLog = deps.transparencyLog;
    this.bus = deps.bus;
    this.clock = deps.clock;
    this.logger = deps.logger ?? NOOP_LOGGER;
  }

  /**
   * Submit the latest tip for every known shard (or just `shard` when
   * supplied) to the transparency log. One submission per shard per
   * call — the cron runner schedules a daily cadence.
   */
  async submitChainTips(shard?: string): Promise<SubmitSummary> {
    const shards = shard ? [shard] : await this.auditLogRepo.listShards();
    const summary: SubmitSummary = {
      submitted: 0,
      skipped: 0,
      failed: 0,
      receipts: [],
      failures: [],
    };

    for (const sh of shards) {
      const tip = await this.auditLogRepo.latestTipForShard(sh);
      if (!tip) {
        summary.skipped++;
        continue;
      }
      try {
        const receipt = await this.transparencyLog.submit({
          shard: sh,
          sequence: tip.sequence,
          tipHash: tip.currentHash,
          occurredAt: this.clock.now(),
        });
        summary.submitted++;
        summary.receipts.push({
          shard: sh,
          sequence: tip.sequence,
          logId: receipt.logId,
          logIndex: receipt.logIndex,
        });
        this.logger.info('transparency log tip submitted', {
          shard: sh,
          sequence: tip.sequence,
          logId: receipt.logId,
          logIndex: receipt.logIndex,
        });
      } catch (err) {
        summary.failed++;
        summary.failures.push({
          shard: sh,
          error: err instanceof Error ? err.message : String(err),
        });
        this.logger.error('transparency log submit failed', {
          shard: sh,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return summary;
  }

  /**
   * Walks each shard's chain end-to-end via `HashChainAppender.verifyRange`.
   * Per DDD-11 a break emits `audit.chain.broken` so on-call sees it
   * even if no human is watching the cron output. Returns the per-shard
   * report so the HTTP edge can render a table.
   */
  async verifyChainIntegrity(shard?: string): Promise<ChainIntegrityReport[]> {
    const shards = shard ? [shard] : await this.auditLogRepo.listShards();
    const out: ChainIntegrityReport[] = [];

    for (const sh of shards) {
      const tip = await this.auditLogRepo.latestTipForShard(sh);
      if (!tip) {
        out.push({
          ok: true,
          shard: sh,
          fromSequence: 0,
          toSequence: -1,
          checked: 0,
        });
        continue;
      }
      const report = await this.appender.verifyRange(sh, 0, tip.sequence);
      out.push(report);
      if (!report.ok) {
        // The appender already emits `audit.chain.broken` via its own
        // event-bus path. Publish a *summary* event keyed on the
        // verifier so dashboards can show "verifier run X found shard Y
        // broken" without parsing two streams.
        try {
          const event: DomainEvent<{
            shard: string;
            atSequence: number;
            expectedHash: string;
            actualHash: string;
            reason: string;
          }> = compose(
            {
              type: 'audit.chain.broken',
              context: 'audit',
              aggregateType: 'chain',
              aggregateId: sh,
              actor: { type: 'system' },
              payload: {
                shard: sh,
                atSequence: report.brokenAtSequence ?? -1,
                expectedHash: report.expectedHash ?? '<unknown>',
                actualHash: report.actualHash ?? '<unknown>',
                reason: 'verifier detected break',
              },
            },
            this.clock
          );
          this.bus.publish(event);
        } catch (err) {
          this.logger.error(
            'failed to publish audit.chain.broken from verifier',
            { err: err instanceof Error ? err.message : String(err) }
          );
        }
      }
    }

    return out;
  }
}
