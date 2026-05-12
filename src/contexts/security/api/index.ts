// Public API barrel for the Security & Compliance context.
// Per ADR-0011 cross-context callers MUST only import from this module.
//
// What we expose:
//   - The `SecurityPublicApi` and `CompliancePublicApi` interfaces.
//   - Aggregate types and value objects (as `import type`) needed by
//     downstream contexts (AI, Dashboard).
//   - The `composeSecurity` factory that wires everything for the
//     composition root and tests.
//   - The HTTP router factories.
//
// Anything not re-exported here is private to the context.

import type {
  ClusterId,
  Clock,
  EventBus,
  ReportId,
  Unsubscribe,
} from '../../../shared/kernel';
import { SecurityService } from '../application/security.service';
import { ComplianceService } from '../application/compliance.service';
import { ScanOrchestrator } from '../application/scan-orchestrator';
import { ScoringService } from '../application/scoring.service';
import {
  MongooseSecurityScanRepository,
  type SecurityScanRepository,
} from '../infrastructure/persistence/security-scan.repository';
import {
  MongooseFindingRepository,
  type FindingRepository,
} from '../infrastructure/persistence/finding.repository';
import {
  MongooseSecurityPolicyRepository,
  type SecurityPolicyRepository,
} from '../infrastructure/persistence/security-policy.repository';
import {
  MongooseSecurityPolicyVersionRepository,
  type SecurityPolicyVersionRepository,
} from '../infrastructure/persistence/security-policy-version.repository';
import {
  MongooseComplianceReportRepository,
  type ComplianceReportRepository,
} from '../infrastructure/persistence/compliance-report.repository';
import { BuiltinPolicyScanner } from '../infrastructure/scanners/builtin-policy-scanner';
import { CompositeScanner } from '../infrastructure/scanners/composite-scanner';
import { TrivyAdapter } from '../infrastructure/scanners/trivy-adapter';
import { KubeBenchAdapter } from '../infrastructure/scanners/kube-bench-adapter';
import { KubeLinterAdapter } from '../infrastructure/scanners/kube-linter-adapter';
import { SecretsScannerAdapter } from '../infrastructure/scanners/secrets-scanner-adapter';
import { VulnerabilityFeedAdapter } from '../infrastructure/scanners/vulnerability-feed-adapter';
import type { SubprocessRunner } from '../infrastructure/scanners/_subprocess';
import type { HttpClient } from '../infrastructure/scanners/vulnerability-feed-adapter';
import type { ScannerClient } from '../domain/ports/scanner-client';
import type { Finding } from '../domain/finding';
import type { ComplianceReport } from '../domain/compliance-report';
import securityRoutesFactory from '../http/security.routes';
import complianceRoutesFactory from '../http/compliance.routes';
import type { Router } from 'express';
import type {
  ComplianceFramework,
  FindingFilter,
  Scope,
  SecurityScore,
} from '../domain/value-objects';
import type { SnapshotProvider } from '../application/security.service';

// ---------------------------------------------------------------------------
// Re-exports (public domain types)
// ---------------------------------------------------------------------------
export { SecurityScan } from '../domain/security-scan';
export { Finding } from '../domain/finding';
export { SecurityPolicy } from '../domain/security-policy';
export { ComplianceReport } from '../domain/compliance-report';
export type {
  ComplianceFramework,
  ComplianceReportStatus,
  ControlAssessment,
  ControlStatus,
  CoverageScore,
  Evidence,
  FindingFilter,
  FindingStatus,
  PolicyConfig,
  PolicyType,
  PolicyVersion,
  ResourceRef,
  ScannerProfile,
  Scope,
  SecurityScanCounts,
  SecurityScore,
  Severity,
  SnapshotRef,
  FindingFingerprint,
} from '../domain/value-objects';
export type { ScannerClient, RawFinding } from '../domain/ports/scanner-client';
export { SecurityService } from '../application/security.service';
export { ComplianceService } from '../application/compliance.service';
export { ScanOrchestrator } from '../application/scan-orchestrator';
export { ScoringService } from '../application/scoring.service';
export { PostureScorer } from '../domain/posture-scorer';
export { ComplianceMapper } from '../domain/compliance-mapper';
export {
  SeverityClassifier,
  severityFromCvss,
  severityForK8sCategory,
} from '../domain/severity-classifier';
export {
  BuiltinPolicyScanner,
  BUILTIN_POLICIES,
  builtinPolicyId,
} from '../infrastructure/scanners/builtin-policy-scanner';
export { CompositeScanner } from '../infrastructure/scanners/composite-scanner';
export type {
  CompositeScannerOpts,
  CompositeScannerLogger,
  SecurityScanPartialPayload,
} from '../infrastructure/scanners/composite-scanner';
export { TrivyAdapter } from '../infrastructure/scanners/trivy-adapter';
export { KubeBenchAdapter } from '../infrastructure/scanners/kube-bench-adapter';
export { KubeLinterAdapter } from '../infrastructure/scanners/kube-linter-adapter';
export { SecretsScannerAdapter } from '../infrastructure/scanners/secrets-scanner-adapter';
export {
  VulnerabilityFeedAdapter,
  NodeFetchHttpClient,
} from '../infrastructure/scanners/vulnerability-feed-adapter';
export type { HttpClient } from '../infrastructure/scanners/vulnerability-feed-adapter';
export {
  NodeSubprocessRunner,
  StubSubprocessRunner,
} from '../infrastructure/scanners/_subprocess';
export type {
  SubprocessRunner,
  SubprocessResult,
  SubprocessRunOpts,
} from '../infrastructure/scanners/_subprocess';

// ---------------------------------------------------------------------------
// Public API contracts per DDD-07
// ---------------------------------------------------------------------------

export interface SecurityPublicApi {
  getScore(scope: Scope): Promise<SecurityScore>;
  listFindings(scope: Scope, filter?: FindingFilter): Promise<Finding[]>;
  /**
   * Subscribe to `security.*` events. Returns an unsubscribe handle.
   * Implementation defers to the provided `EventBus`.
   */
  streamEvents(
    handler: (eventType: string, payload: unknown) => void
  ): Unsubscribe;
}

export interface CompliancePublicApi {
  generateComplianceReport(
    framework: ComplianceFramework,
    scope: Scope
  ): Promise<ComplianceReport>;
  listFrameworks(): ComplianceFramework[];
  getReport(id: ReportId): Promise<ComplianceReport>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface ComposeSecurityLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface ComposeSecurityDeps {
  bus: EventBus;
  clock: Clock;
  logger: ComposeSecurityLogger;
  /**
   * Discovery's read API; the security context only consumes
   * `getLatestSnapshot` to bind a scan to an immutable snapshot.
   * When omitted (e.g. tests), `runScan` becomes a no-op.
   */
  discovery?: {
    getLatestSnapshot: (scope: Scope) => Promise<{
      id: string;
      clusterId: ClusterId;
      hash: string;
      takenAt: ReturnType<Clock['nowInstant']>;
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
  };
  /** Scanner override; defaults to BuiltinPolicyScanner. */
  scanner?: ScannerClient;
  /** Optional repository overrides for tests. */
  repos?: {
    scans?: SecurityScanRepository;
    findings?: FindingRepository;
    policies?: SecurityPolicyRepository;
    policyVersions?: SecurityPolicyVersionRepository;
    reports?: ComplianceReportRepository;
  };
  /** Optional cache override for the ScoringService. */
  scoring?: ScoringService;
}

export interface ComposedSecurity {
  service: SecurityService;
  compliance: ComplianceService;
  orchestrator: ScanOrchestrator;
  scoring: ScoringService;
  publicApi: SecurityPublicApi;
  compliancePublicApi: CompliancePublicApi;
  routers: {
    security: Router;
    compliance: Router;
  };
  /**
   * Subscriptions installed by `compose`. The composition root is
   * responsible for tearing them down on SIGTERM/SIGINT.
   */
  subscriptions: Unsubscribe[];
}

export function composeSecurity(deps: ComposeSecurityDeps): ComposedSecurity {
  const policyVersions =
    deps.repos?.policyVersions ?? new MongooseSecurityPolicyVersionRepository();
  const policies =
    deps.repos?.policies ??
    new MongooseSecurityPolicyRepository(undefined, policyVersions);
  const scans = deps.repos?.scans ?? new MongooseSecurityScanRepository();
  const findings = deps.repos?.findings ?? new MongooseFindingRepository();
  const reports =
    deps.repos?.reports ?? new MongooseComplianceReportRepository();
  const scanner =
    deps.scanner ??
    new CompositeScanner([new BuiltinPolicyScanner(deps.clock)]);
  const scoring = deps.scoring ?? new ScoringService();

  const snapshotProvider: SnapshotProvider | undefined = deps.discovery
    ? {
        getLatestSnapshot: scope => deps.discovery!.getLatestSnapshot(scope),
      }
    : undefined;

  const service = new SecurityService({
    scans,
    findings,
    policies,
    scanner,
    bus: deps.bus,
    clock: deps.clock,
    ...(snapshotProvider !== undefined ? { snapshotProvider } : {}),
    scoring,
    logger: deps.logger,
  });

  const compliance = new ComplianceService({
    findings,
    policies,
    reports,
    bus: deps.bus,
    clock: deps.clock,
    logger: deps.logger,
  });

  const orchestrator = new ScanOrchestrator({
    bus: deps.bus,
    clock: deps.clock,
    security: service,
    scans,
    findings,
    logger: deps.logger,
  });

  const subscriptions: Unsubscribe[] = [];
  subscriptions.push(scoring.installInvalidation(deps.bus));
  for (const h of orchestrator.install()) subscriptions.push(h);

  const publicApi: SecurityPublicApi = {
    getScore: scope => service.getScore(scope),
    listFindings: (scope, filter) => service.listFindings(scope, filter),
    streamEvents: handler => {
      const h = deps.bus.subscribe('security.*', evt =>
        handler(evt.type, evt.payload)
      );
      return h;
    },
  };

  const compliancePublicApi: CompliancePublicApi = {
    generateComplianceReport: (framework, scope) =>
      compliance.generateReport(framework, scope),
    listFrameworks: () => compliance.listFrameworks(),
    getReport: id => compliance.getReport(id),
  };

  return {
    service,
    compliance,
    orchestrator,
    scoring,
    publicApi,
    compliancePublicApi,
    routers: {
      security: securityRoutesFactory(service),
      compliance: complianceRoutesFactory(compliance),
    },
    subscriptions,
  };
}

// ---------------------------------------------------------------------------
// Real-CLI composite factory
// ---------------------------------------------------------------------------

/**
 * Options for `createCompositeScannerWithRealAdapters`. Every adapter
 * can be individually disabled even when the master flag is on.
 */
export interface RealAdaptersOptions {
  bus?: EventBus;
  clock?: Clock;
  clusterId?: ClusterId;
  logger?: ComposeSecurityLogger;
  /** Override the subprocess runner; tests pass a `StubSubprocessRunner`. */
  runner?: SubprocessRunner;
  /** Override the vuln-feed HTTP client; tests pass a fake. */
  http?: HttpClient;
  /** Optional per-adapter timeout override (ms). */
  timeoutMs?: number;
  /**
   * Force-disable individual adapters even if env says otherwise. Used
   * by tests; leave undefined to honour env toggles.
   */
  enabled?: Partial<{
    builtin: boolean;
    trivy: boolean;
    kubeBench: boolean;
    kubeLinter: boolean;
    secrets: boolean;
    vulnFeed: boolean;
  }>;
  /**
   * Override for `process.env` read at construction time. Tests use
   * this to avoid mutating global env.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Builds a `CompositeScanner` containing the builtin policy scanner
 * plus any real adapters enabled by env toggles.
 *
 * Env contract:
 *   SECURITY_REAL_SCANNERS=true     master switch
 *   SECURITY_REAL_TRIVY=false       opt out of Trivy
 *   SECURITY_REAL_KUBE_BENCH=false  opt out of kube-bench
 *   SECURITY_REAL_KUBE_LINTER=false opt out of kube-linter
 *   SECURITY_REAL_SECRETS=false     opt out of gitleaks
 *   SECURITY_REAL_VULN_FEED=false   opt out of NVD pull
 *   SCANNER_TIMEOUT_MS=<int>        per-adapter timeout (default 60000)
 *   SCANNER_VERBOSE=1               per-adapter timing logs
 *
 * The builtin scanner is always included so the composite returns
 * something useful even with all real adapters off — which is the
 * existing Phase 3 behaviour.
 */
export function createCompositeScannerWithRealAdapters(
  opts: RealAdaptersOptions = {}
): CompositeScanner {
  const env = opts.env ?? process.env;
  const masterOn = env['SECURITY_REAL_SCANNERS'] === 'true';
  const timeoutMs =
    opts.timeoutMs ??
    (env['SCANNER_TIMEOUT_MS'] !== undefined
      ? Number(env['SCANNER_TIMEOUT_MS'])
      : 60_000);
  // SystemClock default for the adapters' evidence timestamps; safe to
  // create cheaply. We import it lazily via the deps clock if provided.
  const clock = opts.clock;

  const enabled = (key: string, defaultOn: boolean): boolean => {
    if (opts.enabled !== undefined) {
      const slug = ((): keyof NonNullable<RealAdaptersOptions['enabled']> => {
        switch (key) {
          case 'SECURITY_REAL_TRIVY':
            return 'trivy';
          case 'SECURITY_REAL_KUBE_BENCH':
            return 'kubeBench';
          case 'SECURITY_REAL_KUBE_LINTER':
            return 'kubeLinter';
          case 'SECURITY_REAL_SECRETS':
            return 'secrets';
          case 'SECURITY_REAL_VULN_FEED':
            return 'vulnFeed';
          default:
            return 'builtin';
        }
      })();
      const explicit = opts.enabled[slug];
      if (explicit !== undefined) return explicit;
    }
    if (!masterOn) return false;
    return env[key] !== 'false' && defaultOn;
  };

  const scanners: ScannerClient[] = [];

  // Builtin always-on unless explicitly disabled in `enabled.builtin`.
  const builtinOn = opts.enabled?.builtin ?? true;
  if (builtinOn) {
    // The builtin needs a Clock; fall back to a SystemClock from the
    // shared kernel when the caller did not pass one.
    if (clock) {
      scanners.push(new BuiltinPolicyScanner(clock));
    } else {
      // Lazy import to avoid pulling SystemClock into bundles that
      // already provide a clock.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { SystemClock } = require('../../../shared/kernel');
      scanners.push(new BuiltinPolicyScanner(new SystemClock() as Clock));
    }
  }

  if (enabled('SECURITY_REAL_TRIVY', true)) {
    scanners.push(
      new TrivyAdapter({
        ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
        timeoutMs,
        ...(clock !== undefined ? { clock } : {}),
      })
    );
  }
  if (enabled('SECURITY_REAL_KUBE_BENCH', true)) {
    scanners.push(
      new KubeBenchAdapter({
        ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
        timeoutMs,
        ...(clock !== undefined ? { clock } : {}),
      })
    );
  }
  if (enabled('SECURITY_REAL_KUBE_LINTER', true)) {
    scanners.push(
      new KubeLinterAdapter({
        ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
        timeoutMs,
        ...(clock !== undefined ? { clock } : {}),
      })
    );
  }
  if (enabled('SECURITY_REAL_SECRETS', true)) {
    scanners.push(
      new SecretsScannerAdapter({
        ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
        timeoutMs,
        ...(clock !== undefined ? { clock } : {}),
      })
    );
  }
  if (enabled('SECURITY_REAL_VULN_FEED', true)) {
    scanners.push(
      new VulnerabilityFeedAdapter({
        ...(opts.http !== undefined ? { http: opts.http } : {}),
        timeoutMs,
        ...(clock !== undefined ? { clock } : {}),
      })
    );
  }

  const compositeOpts: import('../infrastructure/scanners/composite-scanner').CompositeScannerOpts =
    {
      concurrency: 4,
      verbose: env['SCANNER_VERBOSE'] === '1',
    };
  if (opts.bus !== undefined) compositeOpts.bus = opts.bus;
  if (clock !== undefined) compositeOpts.clock = clock;
  if (opts.clusterId !== undefined) compositeOpts.clusterId = opts.clusterId;

  return new CompositeScanner(
    scanners,
    opts.logger ?? { warn: () => undefined },
    compositeOpts
  );
}
