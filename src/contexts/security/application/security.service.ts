// SecurityService — application service for the Security & Compliance
// context (DDD-07).
//
// Responsibilities:
//   - Drive the runScan use-case: open a `SecurityScan` against the
//     latest snapshot from Discovery, dispatch the scanner client,
//     promote raw findings to `Finding` aggregates (with fingerprint
//     dedupe), persist, complete the scan, emit events.
//   - Manage finding lifecycle (acknowledge / suppress / resolve).
//   - Compute posture scores via the ScoringService.
//   - Provide back-compat shims for the legacy HTTP edge:
//     `scanResources`, `scanPodSecurity`, `scanNetworkPolicies`,
//     `getSecurityScore`, `getSecurityRecommendations`.

import type {
  ClusterId,
  Clock,
  EventBus,
  FindingId,
  PolicyId,
  ScanId,
  UserId,
  Instant,
} from '../../../shared/kernel';
import { NotFoundError, ValidationError } from '../../../shared/errors';
import {
  Finding,
  fingerprintFor,
  type FindingPersistence,
} from '../domain/finding';
import { SecurityScan } from '../domain/security-scan';
import {
  SecurityPolicy,
  type SecurityPolicyCreateSpec,
} from '../domain/security-policy';
import {
  emptyScanCounts,
  asPolicyVersion,
  type FindingFilter,
  type ScannerProfile,
  type Scope,
  type SecurityScanCounts,
  type SecurityScore,
  type Severity,
  type SnapshotRef,
  type PolicyConfig,
  DEFAULT_SCANNER_PROFILE,
} from '../domain/value-objects';
import type { SecurityScanRepository } from '../infrastructure/persistence/security-scan.repository';
import type { FindingRepository } from '../infrastructure/persistence/finding.repository';
import type { SecurityPolicyRepository } from '../infrastructure/persistence/security-policy.repository';
import type { RawFinding, ScannerClient } from '../domain/ports/scanner-client';
import {
  BUILTIN_POLICIES,
  builtinPolicyId,
} from '../infrastructure/scanners/builtin-policy-scanner';
import { ScoringService } from './scoring.service';
import type { SecurityScanResult } from '../../../types';

/**
 * Read-side projection from Discovery. We keep the dependency surface
 * narrow so the security context only consumes the public API.
 */
export interface SnapshotProvider {
  /** Returns the latest snapshot for the cluster. */
  getLatestSnapshot(scope: Scope): Promise<{
    id: string;
    clusterId: string;
    hash: string;
    takenAt: Instant;
    records: ReadonlyArray<{
      apiVersion: string;
      kind: string;
      namespace?: string;
      name: string;
      labels: Record<string, string>;
      annotations: Record<string, string>;
      spec: unknown;
      status: unknown;
    }>;
  }>;
}

export interface SecurityServiceLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

const NOOP_LOGGER: SecurityServiceLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface SecurityServiceDeps {
  scans: SecurityScanRepository;
  findings: FindingRepository;
  policies: SecurityPolicyRepository;
  scanner: ScannerClient;
  bus: EventBus;
  clock: Clock;
  /** Discovery's public API — `getLatestSnapshot` only. */
  snapshotProvider?: SnapshotProvider;
  scoring?: ScoringService;
  logger?: SecurityServiceLogger;
}

/** Result of `runScan`. */
export interface RunScanResult {
  scanId: ScanId;
  counts: SecurityScanCounts;
  score: number;
  findingsOpened: number;
  findingsReSeen: number;
  findingsResolved: number;
}

export class SecurityService {
  private readonly scans: SecurityScanRepository;
  private readonly findings: FindingRepository;
  private readonly policies: SecurityPolicyRepository;
  private readonly scanner: ScannerClient;
  private readonly bus: EventBus;
  private readonly clock: Clock;
  private readonly snapshotProvider: SnapshotProvider | undefined;
  private readonly scoring: ScoringService;
  private readonly logger: SecurityServiceLogger;

  constructor(deps: SecurityServiceDeps) {
    this.scans = deps.scans;
    this.findings = deps.findings;
    this.policies = deps.policies;
    this.scanner = deps.scanner;
    this.bus = deps.bus;
    this.clock = deps.clock;
    this.snapshotProvider = deps.snapshotProvider;
    this.scoring = deps.scoring ?? new ScoringService();
    this.logger = deps.logger ?? NOOP_LOGGER;
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------

  /**
   * Ensure a SecurityPolicy exists for every builtin check. Idempotent;
   * existing rows are not modified. Used by the composition root on
   * boot so the policy collection has stable rows for the engine.
   */
  async seedBuiltinPolicies(): Promise<void> {
    for (const def of BUILTIN_POLICIES) {
      const id = builtinPolicyId(def.checkId);
      const existing = await this.policies.findById(id);
      if (existing) continue;
      const policy = SecurityPolicy.create(
        {
          id,
          name: def.name,
          type: 'k8s',
          config: {
            checkId: def.checkId,
            description: def.description,
            recommendation: def.recommendation,
            severity: def.severity,
          },
          priority: 100,
          enabled: true,
        },
        this.clock
      );
      await this.policies.save(policy);
      this.bus.publishMany(policy.drainEvents());
    }
  }

  // ---------------------------------------------------------------------------
  // Core use-case: runScan
  // ---------------------------------------------------------------------------

  /**
   * Run a security scan against the latest snapshot for `scope`.
   * Steps:
   *   1. Fetch the snapshot via Discovery's public API.
   *   2. Open a SecurityScan (binding the snapshot + policy version).
   *   3. Dispatch the scanner; get RawFindings.
   *   4. Promote each RawFinding to a `Finding` aggregate, deduping
   *      against existing findings by fingerprint.
   *   5. Persist Findings + complete the scan + emit events.
   */
  async runScan(
    scope: Scope,
    profile: ScannerProfile = DEFAULT_SCANNER_PROFILE
  ): Promise<RunScanResult> {
    if (!this.snapshotProvider) {
      throw new ValidationError(
        'no snapshot provider configured; cannot run scan'
      );
    }
    const snapshot = await this.snapshotProvider.getLatestSnapshot(scope);

    // Determine the active policy version. We use the highest
    // version across enabled policies; the scan as a whole references
    // that version for reproducibility.
    const policiesEnabled = await this.policies.listEnabled();
    let maxVersion = 1;
    for (const p of policiesEnabled) {
      const v = p.version as number;
      if (v > maxVersion) maxVersion = v;
    }

    const snapRef: SnapshotRef = {
      id: snapshot.id as SnapshotRef['id'],
      clusterId: snapshot.clusterId as ClusterId,
      hash: snapshot.hash,
      takenAt: snapshot.takenAt,
    };
    const scan = SecurityScan.start(
      {
        scope,
        snapshot: snapRef,
        policyVersion: asPolicyVersion(maxVersion),
        profile,
      },
      this.clock
    );
    await this.scans.save(scan);
    this.bus.publishMany(scan.drainEvents());

    // Run the scanner.
    const raw = await this.scanner.scan({ records: snapshot.records });
    const filtered = filterByProfile(raw, profile);

    // Dedupe by fingerprint. For each unique fingerprint, either
    // re-touch the existing finding or open a new one.
    const counts: SecurityScanCounts = emptyScanCounts();
    let opened = 0;
    let reSeen = 0;
    const seenFingerprints = new Set<string>();

    const toSave: Finding[] = [];

    for (const rf of filtered) {
      const fp = fingerprintFor(rf.policyId, rf.resource);
      if (seenFingerprints.has(fp)) continue;
      seenFingerprints.add(fp);

      const existing = await this.findings.findByFingerprint(
        scope.clusterId,
        fp
      );
      if (existing && existing.status !== 'resolved') {
        existing.touch(scan.id, this.clock);
        toSave.push(existing);
        reSeen++;
      } else {
        const finding = Finding.open(
          {
            scanId: scan.id,
            scope,
            resource: rf.resource,
            policyId: rf.policyId,
            policyVersion: asPolicyVersion(maxVersion),
            severity: rf.severity,
            description: rf.description,
            ...(rf.recommendation !== undefined
              ? { recommendation: rf.recommendation }
              : {}),
            evidence: rf.evidence,
          },
          this.clock
        );
        toSave.push(finding);
        opened++;
      }
      // Counts are by severity for the scan summary.
      counts.total++;
      switch (rf.severity) {
        case 'critical':
          counts.critical++;
          break;
        case 'high':
          counts.high++;
          break;
        case 'medium':
          counts.medium++;
          break;
        case 'low':
          counts.low++;
          break;
      }
    }

    // Auto-resolve findings whose fingerprint did not re-appear in
    // the new scan. This is the DDD-07 "open finding whose pattern
    // still matches must not be re-opened" rule applied in reverse.
    const open = await this.findings.listOpenByScope(scope);
    let autoResolved = 0;
    for (const f of open) {
      if (!seenFingerprints.has(f.fingerprint)) {
        f.resolve(null, this.clock);
        toSave.push(f);
        autoResolved++;
      }
    }

    // Persist all touched findings in one bulk write.
    await this.findings.saveMany(toSave);
    for (const f of toSave) {
      this.bus.publishMany(f.drainEvents());
    }

    // Compute the score for the scan summary.
    const allOpenAfter = await this.findings.listOpenByScope(scope);
    const scoreResult = await this.scoring.getScoreForCluster(
      scope.clusterId,
      async () => allOpenAfter
    );

    scan.complete(counts, scoreResult.score, this.clock);
    await this.scans.save(scan);
    this.bus.publishMany(scan.drainEvents());

    return {
      scanId: scan.id,
      counts,
      score: scoreResult.score,
      findingsOpened: opened,
      findingsReSeen: reSeen,
      findingsResolved: autoResolved,
    };
  }

  // ---------------------------------------------------------------------------
  // Score / list / lifecycle
  // ---------------------------------------------------------------------------

  async getScore(scope: Scope): Promise<SecurityScore> {
    const open = await this.findings.listOpenByScope(scope);
    const result = await this.scoring.getScoreForCluster(
      scope.clusterId,
      async () => open
    );
    return {
      scope,
      score: result.score,
      breakdown: result.breakdown,
      computedAt: this.clock.nowInstant(),
    };
  }

  async listFindings(scope: Scope, filter?: FindingFilter): Promise<Finding[]> {
    return this.findings.list(scope, filter ?? {});
  }

  async acknowledgeFinding(
    id: FindingId,
    by: UserId,
    note?: string
  ): Promise<Finding> {
    const f = await this.findings.findById(id);
    if (!f) throw new NotFoundError('Finding', id);
    f.acknowledge(by, note, this.clock);
    await this.findings.save(f);
    this.bus.publishMany(f.drainEvents());
    return f;
  }

  async suppressFinding(
    id: FindingId,
    by: UserId,
    until: Instant,
    justification: string
  ): Promise<Finding> {
    const f = await this.findings.findById(id);
    if (!f) throw new NotFoundError('Finding', id);
    f.suppress(by, until, justification, this.clock);
    await this.findings.save(f);
    this.bus.publishMany(f.drainEvents());
    return f;
  }

  async resolveFinding(id: FindingId, by: UserId): Promise<Finding> {
    const f = await this.findings.findById(id);
    if (!f) throw new NotFoundError('Finding', id);
    f.resolve(by, this.clock);
    await this.findings.save(f);
    this.bus.publishMany(f.drainEvents());
    return f;
  }

  // ---------------------------------------------------------------------------
  // Recommendations / policies
  // ---------------------------------------------------------------------------

  async getRecommendations(scope: Scope): Promise<string[]> {
    const findings = await this.findings.list(scope, {
      status: ['open', 'acknowledged'],
      limit: 100,
    });
    const seen = new Set<string>();
    const out: string[] = [];
    for (const f of findings) {
      if (!f.recommendation) continue;
      if (seen.has(f.recommendation)) continue;
      seen.add(f.recommendation);
      out.push(f.recommendation);
    }
    return out;
  }

  async listPolicies(): Promise<SecurityPolicy[]> {
    return this.policies.listAll();
  }

  async createPolicy(spec: SecurityPolicyCreateSpec): Promise<SecurityPolicy> {
    const policy = SecurityPolicy.create(spec, this.clock);
    await this.policies.save(policy);
    this.bus.publishMany(policy.drainEvents());
    return policy;
  }

  async updatePolicy(
    id: PolicyId,
    changes: {
      name?: string;
      config?: PolicyConfig;
      priority?: number;
      enabled?: boolean;
    }
  ): Promise<SecurityPolicy> {
    const policy = await this.policies.findById(id);
    if (!policy) throw new NotFoundError('SecurityPolicy', id);
    policy.update(changes, this.clock);
    await this.policies.save(policy);
    this.bus.publishMany(policy.drainEvents());
    return policy;
  }

  // ---------------------------------------------------------------------------
  // Legacy back-compat surface (HTTP edge keeps the existing routes)
  // ---------------------------------------------------------------------------

  /**
   * Legacy: scan an arbitrary list of resources passed in directly.
   * Used by the historical `POST /api/security/scan` route. Returns
   * the legacy `SecurityScanResult[]` shape.
   */
  async scanResources(
    resources: Array<{
      apiVersion?: string;
      kind?: string;
      metadata?: { name?: string; namespace?: string };
      spec?: unknown;
      status?: unknown;
    }>
  ): Promise<SecurityScanResult[]> {
    const records = resources.map(r => ({
      apiVersion: r.apiVersion ?? 'v1',
      kind: r.kind ?? 'Unknown',
      ...(r.metadata?.namespace !== undefined
        ? { namespace: r.metadata.namespace }
        : {}),
      name: r.metadata?.name ?? '',
      labels: {},
      annotations: {},
      spec: r.spec ?? {},
      status: r.status ?? {},
    }));
    const raw = await this.scanner.scan({ records });
    return raw.map(rf => toLegacyResult(rf, this.clock.now()));
  }

  async scanPodSecurity(): Promise<SecurityScanResult[]> {
    if (!this.snapshotProvider) return [];
    // Legacy contract: scan a default scope. We assume a single
    // legacy cluster id ("legacy") used by the back-compat code path.
    const scope: Scope = { clusterId: 'legacy' as ClusterId };
    const findings = await this.findings.list(scope, {
      status: ['open', 'acknowledged'],
      resourceKind: 'Pod',
      limit: 100,
    });
    return findings.map(f => findingToLegacyResult(f));
  }

  async scanNetworkPolicies(): Promise<SecurityScanResult[]> {
    const scope: Scope = { clusterId: 'legacy' as ClusterId };
    const findings = await this.findings.list(scope, {
      status: ['open', 'acknowledged'],
      policyId: builtinPolicyId('k8s.missingNetworkPolicy'),
      limit: 100,
    });
    return findings.map(f => findingToLegacyResult(f));
  }

  async getSecurityScore(): Promise<number> {
    const scope: Scope = { clusterId: 'legacy' as ClusterId };
    const open = await this.findings.listOpenByScope(scope);
    const result = await this.scoring.getScoreForCluster(
      scope.clusterId,
      async () => open
    );
    return result.score;
  }

  async getSecurityRecommendations(): Promise<string[]> {
    const scope: Scope = { clusterId: 'legacy' as ClusterId };
    return this.getRecommendations(scope);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle hooks (legacy compat)
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    this.logger.info('SecurityService initialised');
  }

  async stop(): Promise<void> {
    this.logger.info('SecurityService stopped');
  }

  async healthCheck(): Promise<{
    status: string;
    lastScan?: Date;
    score?: number;
  }> {
    return {
      status: 'healthy',
      lastScan: this.clock.now(),
      score: 0,
    };
  }
}

/**
 * Apply the scanner profile to the raw findings. `enabledCheckIds`
 * empty → keep all. `severityFloor` drops anything below the floor.
 */
function filterByProfile(
  raw: ReadonlyArray<RawFinding>,
  profile: ScannerProfile
): RawFinding[] {
  const enabled = new Set(profile.enabledCheckIds);
  const floor = profile.severityFloor;
  const floorRank = floor ? severityRankNum(floor) : 0;
  return raw.filter(rf => {
    if (enabled.size > 0) {
      // We expect callers to use builtinPolicyId in the profile too.
      if (!enabled.has(rf.policyId)) return false;
    }
    if (floorRank > 0 && severityRankNum(rf.severity) < floorRank) {
      return false;
    }
    return true;
  });
}

function severityRankNum(s: Severity): number {
  switch (s) {
    case 'low':
      return 1;
    case 'medium':
      return 2;
    case 'high':
      return 3;
    case 'critical':
      return 4;
  }
}

function toLegacyResult(rf: RawFinding, now: Date): SecurityScanResult {
  const result: SecurityScanResult = {
    scanId: 'scan-' + now.getTime(),
    timestamp: now,
    severity: rf.severity,
    category: rf.evidence.source,
    description: rf.description,
    affectedResources: [
      `${rf.resource.kind}/${rf.resource.name}` +
        (rf.resource.namespace ? `@${rf.resource.namespace}` : ''),
    ],
  };
  if (rf.recommendation !== undefined) {
    result.recommendation = rf.recommendation;
  }
  return result;
}

function findingToLegacyResult(f: Finding): SecurityScanResult {
  const result: SecurityScanResult = {
    scanId: f.scanId,
    timestamp: new Date(f.detectedAt as unknown as string),
    severity: f.severity,
    category: f.evidence.source,
    description: f.description,
    affectedResources: [
      `${f.resource.kind}/${f.resource.name}` +
        (f.resource.namespace ? `@${f.resource.namespace}` : ''),
    ],
  };
  if (f.recommendation !== undefined) {
    result.recommendation = f.recommendation;
  }
  return result;
}

// Re-export the persistence type just so consumers that depend on the
// service implementation don't have to reach into infrastructure.
export type { FindingPersistence };
