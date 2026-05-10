// AnalysisOrchestrator — subscribes to security.* / compliance.* /
// discovery.* events and triggers AI analyses in response.
//
// Idempotency: every trigger is keyed against a deterministic hash and
// stored in Redis with `SET NX EX <ttl>`. Duplicate publishes (e.g.
// the audit subscriber re-emitting an event) don't double-charge.

import { createHash } from 'node:crypto';
import type { ClusterId, EventBus, Unsubscribe } from '../../../shared/kernel';
import type { AIService } from './ai.service';
import type { Scope, Severity } from '../domain/value-objects';

export interface AnalysisOrchestratorRedis {
  /** Redis-style SET NX EX. Returns 'OK' (or 1) on success, null on already-set. */
  set(
    key: string,
    value: string,
    flag1: 'EX',
    seconds: number,
    flag2: 'NX'
  ): Promise<unknown>;
}

export interface AnalysisOrchestratorLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const NOOP_LOGGER: AnalysisOrchestratorLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface AnalysisOrchestratorOptions {
  bus: EventBus;
  ai: AIService;
  /** Optional Redis for distributed idempotency. Falls back to in-memory set. */
  redis?: AnalysisOrchestratorRedis | null;
  logger?: AnalysisOrchestratorLogger;
  /** Lock TTL in seconds; default 24h. */
  lockTtlSec?: number;
}

interface SecurityScanCompletedPayload {
  scanId?: string;
  scope?: { clusterId?: string; namespace?: string };
  counts?: { critical?: number; high?: number };
  score?: number;
}

interface SecurityFindingOpenedPayload {
  findingId?: string;
  scanId?: string;
  severity?: Severity;
  resource?: { kind?: string; name?: string; namespace?: string };
  policyId?: string;
}

interface ComplianceReportGeneratedPayload {
  reportId?: string;
  framework?: string;
  scope?: { clusterId?: string; namespace?: string };
  overall?: number;
}

interface DiscoveryClusterScannedPayload {
  clusterId?: string;
  scanId?: string;
  snapshotId?: string;
  counts?: unknown;
}

export class AnalysisOrchestrator {
  private readonly bus: EventBus;
  private readonly ai: AIService;
  private readonly redis: AnalysisOrchestratorRedis | null;
  private readonly logger: AnalysisOrchestratorLogger;
  private readonly lockTtlSec: number;
  private readonly localLocks = new Map<string, number>();
  private readonly handles: Unsubscribe[] = [];

  constructor(opts: AnalysisOrchestratorOptions) {
    this.bus = opts.bus;
    this.ai = opts.ai;
    this.redis = opts.redis ?? null;
    this.logger = opts.logger ?? NOOP_LOGGER;
    this.lockTtlSec = opts.lockTtlSec ?? 60 * 60 * 24;
  }

  install(): Unsubscribe[] {
    const h1 = this.bus.subscribe<SecurityScanCompletedPayload>(
      'security.scan.completed',
      async event => {
        try {
          await this.onSecurityScanCompleted(event.payload);
        } catch (err) {
          this.logger.warn('orchestrator: security.scan.completed failed', {
            err: errMsg(err),
          });
        }
      }
    );
    const h2 = this.bus.subscribe<SecurityFindingOpenedPayload>(
      'security.finding.opened',
      async event => {
        try {
          await this.onSecurityFindingOpened(event.payload);
        } catch (err) {
          this.logger.warn('orchestrator: security.finding.opened failed', {
            err: errMsg(err),
          });
        }
      }
    );
    const h3 = this.bus.subscribe<ComplianceReportGeneratedPayload>(
      'compliance.report.generated',
      async event => {
        try {
          await this.onComplianceReportGenerated(event.payload);
        } catch (err) {
          this.logger.warn('orchestrator: compliance.report.generated failed', {
            err: errMsg(err),
          });
        }
      }
    );
    const h4 = this.bus.subscribe<DiscoveryClusterScannedPayload>(
      'discovery.cluster.scanned',
      async event => {
        try {
          await this.onClusterScanned(event.payload);
        } catch (err) {
          this.logger.warn('orchestrator: discovery.cluster.scanned failed', {
            err: errMsg(err),
          });
        }
      }
    );
    this.handles.push(h1, h2, h3, h4);
    return [h1, h2, h3, h4];
  }

  uninstall(): void {
    while (this.handles.length > 0) {
      const h = this.handles.pop();
      if (h) h();
    }
  }

  // ---------------------------------------------------------------------------
  // Handlers (public for tests).
  // ---------------------------------------------------------------------------
  async onSecurityScanCompleted(
    payload: SecurityScanCompletedPayload
  ): Promise<{ skipped: boolean; reason?: string } | { skipped: false }> {
    const cluster = payload.scope?.clusterId;
    if (typeof cluster !== 'string' || cluster.length === 0) {
      return { skipped: true, reason: 'no clusterId' };
    }
    const score = typeof payload.score === 'number' ? payload.score : 100;
    const critical = payload.counts?.critical ?? 0;
    if (score >= 70 && critical === 0) {
      return { skipped: true, reason: 'within_thresholds' };
    }
    const scope: Scope = { clusterId: cluster as ClusterId };
    if (payload.scope?.namespace) scope.namespace = payload.scope.namespace;
    const lockKey = this.lockKey(
      'security_scan',
      cluster,
      payload.scanId ?? ''
    );
    if (!(await this.acquireLock(lockKey))) {
      return { skipped: true, reason: 'idempotent_lock' };
    }
    await this.ai.analyzeSecurity({
      scope,
      payload: { scanId: payload.scanId, counts: payload.counts, score },
    });
    return { skipped: false };
  }

  async onSecurityFindingOpened(
    payload: SecurityFindingOpenedPayload
  ): Promise<{ skipped: boolean; reason?: string } | { skipped: false }> {
    const sev = payload.severity;
    if (sev !== 'high' && sev !== 'critical') {
      return { skipped: true, reason: 'severity_below_threshold' };
    }
    const findingId = payload.findingId ?? '';
    const lockKey = this.lockKey('security_finding', findingId);
    if (!(await this.acquireLock(lockKey))) {
      return { skipped: true, reason: 'idempotent_lock' };
    }
    const cluster =
      typeof payload.resource?.namespace === 'string' ? 'unknown' : 'unknown';
    void cluster;
    // We don't have the cluster id directly on the event; the ScanOrchestrator
    // already includes it on the originating scan, so we pull a placeholder
    // scope here. Tests pass an explicit `scope` via direct calls.
    const scope: Scope = {
      clusterId: ((payload as { clusterId?: string }).clusterId ??
        'unknown') as ClusterId,
    };
    await this.ai.analyzeSecurity({
      scope,
      payload,
    });
    return { skipped: false };
  }

  async onComplianceReportGenerated(
    payload: ComplianceReportGeneratedPayload
  ): Promise<{ skipped: boolean; reason?: string } | { skipped: false }> {
    const cluster = payload.scope?.clusterId;
    if (typeof cluster !== 'string' || cluster.length === 0) {
      return { skipped: true, reason: 'no clusterId' };
    }
    const lockKey = this.lockKey(
      'compliance_report',
      payload.reportId ?? cluster
    );
    if (!(await this.acquireLock(lockKey))) {
      return { skipped: true, reason: 'idempotent_lock' };
    }
    const scope: Scope = { clusterId: cluster as ClusterId };
    if (payload.scope?.namespace) scope.namespace = payload.scope.namespace;
    await this.ai.analyzeCompliance({
      scope,
      payload,
    });
    return { skipped: false };
  }

  async onClusterScanned(
    payload: DiscoveryClusterScannedPayload
  ): Promise<{ skipped: boolean; reason?: string } | { skipped: false }> {
    const cluster = payload.clusterId;
    if (typeof cluster !== 'string' || cluster.length === 0) {
      return { skipped: true, reason: 'no clusterId' };
    }
    // Debounce: one comprehensive analysis per cluster per 24h.
    const lockKey = this.lockKey('discovery_cluster', cluster);
    if (!(await this.acquireLock(lockKey))) {
      return { skipped: true, reason: 'debounced_24h' };
    }
    const scope: Scope = { clusterId: cluster as ClusterId };
    await this.ai.analyzeInfrastructure({
      scope,
      payload,
    });
    return { skipped: false };
  }

  // ---------------------------------------------------------------------------
  // Idempotency helpers
  // ---------------------------------------------------------------------------
  private lockKey(...parts: string[]): string {
    const raw = parts.join('|');
    const h = createHash('sha1').update(raw).digest('hex').slice(0, 16);
    return `ai:lock:${h}`;
  }

  private async acquireLock(key: string): Promise<boolean> {
    if (this.redis) {
      try {
        const result = await this.redis.set(
          key,
          '1',
          'EX',
          this.lockTtlSec,
          'NX'
        );
        return result === 'OK' || result === 1;
      } catch (err) {
        this.logger.warn('orchestrator: redis lock failed; falling back', {
          err: errMsg(err),
        });
      }
    }
    const now = Date.now();
    const expires = this.localLocks.get(key);
    if (expires !== undefined && expires > now) return false;
    this.localLocks.set(key, now + this.lockTtlSec * 1000);
    return true;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
