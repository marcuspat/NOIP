// ScanOrchestrator — subscribes to discovery.* events and drives
// SecurityService.runScan in response. Owns the debounce against
// already-scanned `(clusterId, snapshotHash)` tuples.

import type { ClusterId, EventBus, Unsubscribe } from '../../../shared/kernel';
import type { Clock } from '../../../shared/kernel';
import type { SecurityService } from './security.service';
import type { SecurityScanRepository } from '../infrastructure/persistence/security-scan.repository';
import { Finding } from '../domain/finding';
import { asPolicyVersion } from '../domain/value-objects';
import type { ResourceRef, Scope, Severity } from '../domain/value-objects';
import type { FindingRepository } from '../infrastructure/persistence/finding.repository';
import { builtinPolicyId } from '../infrastructure/scanners/builtin-policy-scanner';
import type { PolicyId } from '../../../shared/kernel';

export interface ScanOrchestratorLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

const NOOP_LOGGER: ScanOrchestratorLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface ScanOrchestratorDeps {
  bus: EventBus;
  clock: Clock;
  security: SecurityService;
  scans: SecurityScanRepository;
  findings: FindingRepository;
  logger?: ScanOrchestratorLogger;
}

interface DiscoveryClusterScannedPayload {
  clusterId?: string;
  scanId?: string;
  snapshotId?: string;
  snapshotHash?: string;
  counts?: unknown;
  // Optional snapshot hash some producers include via inner payload.
  snapshot?: { hash?: string };
}

interface DiscoveryDriftDetectedPayload {
  clusterId?: string;
  driftId?: string;
  highestSeverity?: Severity;
  changeCount?: number;
  // Optional details so we can attach a resource ref to the promoted finding.
  changes?: Array<{
    ref?: ResourceRef;
    severity?: Severity;
    rationale?: string;
  }>;
}

export class ScanOrchestrator {
  private readonly bus: EventBus;
  private readonly clock: Clock;
  private readonly security: SecurityService;
  private readonly scans: SecurityScanRepository;
  private readonly findings: FindingRepository;
  private readonly logger: ScanOrchestratorLogger;
  private readonly handles: Unsubscribe[] = [];
  /** Local debounce window; bypassed in favour of the repo lookup,
   * but keeps in-flight duplicates from racing each other. */
  private readonly inflight = new Set<string>();

  constructor(deps: ScanOrchestratorDeps) {
    this.bus = deps.bus;
    this.clock = deps.clock;
    this.security = deps.security;
    this.scans = deps.scans;
    this.findings = deps.findings;
    this.logger = deps.logger ?? NOOP_LOGGER;
  }

  /** Wire subscriptions; returns the same Unsubscribe array stored
   * internally so callers can also tear down by storing the array. */
  install(): Unsubscribe[] {
    const h1 = this.bus.subscribe<DiscoveryClusterScannedPayload>(
      'discovery.cluster.scanned',
      async event => {
        try {
          await this.onClusterScanned(event.payload);
        } catch (err) {
          this.logger.error('orchestrator: cluster.scanned handler failed', {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    );
    const h2 = this.bus.subscribe<DiscoveryDriftDetectedPayload>(
      'discovery.drift.detected',
      async event => {
        try {
          await this.onDriftDetected(event.payload);
        } catch (err) {
          this.logger.error('orchestrator: drift.detected handler failed', {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    );
    this.handles.push(h1, h2);
    return [h1, h2];
  }

  uninstall(): void {
    while (this.handles.length > 0) {
      const h = this.handles.pop();
      if (h) h();
    }
  }

  /**
   * Public for tests so they can drive the orchestrator deterministically
   * without manufacturing an event envelope.
   */
  async onClusterScanned(
    payload: DiscoveryClusterScannedPayload
  ): Promise<{ skipped: boolean; reason?: string } | { skipped: false }> {
    const clusterId = payload.clusterId;
    if (typeof clusterId !== 'string' || clusterId.length === 0) {
      return { skipped: true, reason: 'no clusterId' };
    }
    const hash =
      typeof payload.snapshotHash === 'string'
        ? payload.snapshotHash
        : (payload.snapshot?.hash ?? '');
    if (hash !== '') {
      const existing = await this.scans.findLatestSucceededByHash(
        clusterId as ClusterId,
        hash
      );
      if (existing) {
        return { skipped: true, reason: 'debounced' };
      }
    }
    const debounceKey = `${clusterId}|${hash}`;
    if (this.inflight.has(debounceKey)) {
      return { skipped: true, reason: 'inflight' };
    }
    this.inflight.add(debounceKey);
    try {
      await this.security.runScan({ clusterId: clusterId as ClusterId });
      return { skipped: false };
    } finally {
      this.inflight.delete(debounceKey);
    }
  }

  /**
   * On HIGH/CRITICAL drift, promote each change to a Finding so the
   * SOC sees the drift via the same surface as a scan-derived finding.
   * MEDIUM/LOW drift is left to the next scheduled scan to absorb.
   */
  async onDriftDetected(
    payload: DiscoveryDriftDetectedPayload
  ): Promise<{ promoted: number }> {
    const clusterId = payload.clusterId;
    if (typeof clusterId !== 'string' || clusterId.length === 0) {
      return { promoted: 0 };
    }
    const severity = payload.highestSeverity;
    if (severity !== 'high' && severity !== 'critical') {
      return { promoted: 0 };
    }
    const scope: Scope = { clusterId: clusterId as ClusterId };
    const changes = (payload.changes ?? []).filter(
      c => c.severity === 'high' || c.severity === 'critical'
    );
    let promoted = 0;
    const driftPolicyId: PolicyId = builtinPolicyId(
      'drift.high-severity-change'
    );
    const driftFindings: Finding[] = [];
    const now = this.clock.nowInstant();
    for (const ch of changes) {
      if (!ch.ref) continue;
      const f = Finding.open(
        {
          scanId: '00000000-0000-4000-8000-000000000000' as never,
          scope,
          resource: ch.ref,
          policyId: driftPolicyId,
          policyVersion: asPolicyVersion(1),
          severity: ch.severity ?? 'high',
          description:
            ch.rationale ?? 'Drift detected against the prior snapshot.',
          recommendation:
            'Investigate the drift and reconcile the resource against its declared baseline.',
          evidence: {
            source: 'drift-orchestrator',
            summary: `drift severity=${ch.severity}`,
            data: { ref: ch.ref },
            capturedAt: now,
          },
        },
        this.clock
      );
      driftFindings.push(f);
      promoted++;
    }
    if (driftFindings.length > 0) {
      await this.findings.saveMany(driftFindings);
      for (const f of driftFindings) {
        this.bus.publishMany(f.drainEvents());
      }
    }
    return { promoted };
  }
}
