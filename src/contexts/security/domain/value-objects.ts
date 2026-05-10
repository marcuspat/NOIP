// Value objects for the Security & Compliance context (DDD-07).
//
// Pure data shapes. Aggregates and application services compose these.
// The HTTP edge re-projects them onto the legacy `SecurityScanResult`
// (back-compat) where required.

import type {
  ClusterId,
  FindingId,
  PolicyId,
  ReportId,
  ScanId,
  SnapshotId,
  UserId,
  Instant,
} from '../../../shared/kernel';

// ---------------------------------------------------------------------------
// Re-used primitives from Discovery's published language. We accept the
// `Severity` ladder and `Scope` envelope per DDD-07 §"Cross-context
// relationships" — the Discovery context is the supplier of these types
// but the Security context needs them in its own published surface so
// downstream contexts (AI, Dashboard) don't have to import Discovery
// directly to read a Finding.
// ---------------------------------------------------------------------------

export type Severity = 'low' | 'medium' | 'high' | 'critical';

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function severityRank(s: Severity): number {
  return SEVERITY_RANK[s];
}

export function maxSeverity(a: Severity, b: Severity): Severity {
  return severityRank(a) >= severityRank(b) ? a : b;
}

/** Bounded scope for scans, scores, and reports. */
export interface Scope {
  clusterId: ClusterId;
  namespace?: string;
  kind?: string;
}

/**
 * Pointer to the snapshot a scan was bound to. We keep `hash` here so
 * a security scan is reproducible even if the `ResourceSnapshot` row
 * is later compacted.
 */
export interface SnapshotRef {
  id: SnapshotId;
  clusterId: ClusterId;
  hash: string;
  takenAt: Instant;
}

/**
 * Reference to the resource a finding pertains to. Same shape as
 * Discovery's `ResourceRef` but kept independent so we can evolve the
 * security model without touching discovery.
 */
export interface ResourceRef {
  apiVersion: string;
  kind: string;
  namespace?: string;
  name: string;
}

/**
 * Lifecycle status of a `Finding`. Only certain transitions are legal;
 * the aggregate enforces them.
 */
export type FindingStatus = 'open' | 'acknowledged' | 'suppressed' | 'resolved';

/** Pass/fail/N-A judgment of a single compliance control. */
export type ControlStatus = 'pass' | 'fail' | 'na' | 'partial';

/** Lifecycle of a `ComplianceReport`. */
export type ComplianceReportStatus = 'draft' | 'signed' | 'expired';

/** Frameworks we ship mappings for. */
export type ComplianceFramework =
  | 'SOC2'
  | 'ISO27001'
  | 'HIPAA'
  | 'PCI-DSS'
  | 'GDPR';

/**
 * Configurable scanner profile. The ID is opaque; the application
 * service dispatches to the right scanners via the registered
 * `ScannerClient` registry.
 */
export interface ScannerProfile {
  id: string;
  /** Empty → default profile (every check enabled). */
  enabledCheckIds: string[];
  /** Optional severity floor; findings below this are dropped. */
  severityFloor?: Severity;
}

export const DEFAULT_SCANNER_PROFILE: ScannerProfile = {
  id: 'default',
  enabledCheckIds: [],
};

/**
 * Branded policy version. Versions are monotonic per `PolicyId`.
 */
export type PolicyVersion = number & { readonly _t: 'PolicyVersion' };

export function asPolicyVersion(n: number): PolicyVersion {
  return n as PolicyVersion;
}

/**
 * Immutable evidence captured at the moment of finding detection.
 * Snippets are JSON-stringifiable; the rendering layer prettifies
 * them for the UI / API.
 */
export interface Evidence {
  /** What scanner produced this evidence. */
  source: string;
  /** Free-form summary appropriate for the rendered UI. */
  summary: string;
  /** Optional structured data — JSON-serialisable values only. */
  data?: Record<string, unknown>;
  /** When the evidence was captured. */
  capturedAt: Instant;
}

/** Filter envelope for `listFindings`. All fields optional. */
export interface FindingFilter {
  status?: FindingStatus | FindingStatus[];
  severity?: Severity | Severity[];
  policyId?: PolicyId;
  scanId?: ScanId;
  resourceKind?: string;
  /** Limit on rows returned. */
  limit?: number;
}

/** A 0–100 coverage score with a human readable breakdown. */
export interface CoverageScore {
  score: number; // integer 0..100
  pass: number;
  fail: number;
  partial: number;
  na: number;
  total: number;
}

export type ScanStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface SecurityScanCounts {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export function emptyScanCounts(): SecurityScanCounts {
  return { total: 0, critical: 0, high: 0, medium: 0, low: 0 };
}

export interface SecurityScanError {
  code:
    | 'PROVIDER_ERROR'
    | 'BACKPRESSURE'
    | 'UNAUTHORIZED'
    | 'TIMEOUT'
    | 'INTERNAL_ERROR'
    | 'VALIDATION_ERROR';
  message: string;
}

/** Public projection for `getScore`. */
export interface SecurityScore {
  scope: Scope;
  score: number; // 0..100
  breakdown: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  computedAt: Instant;
}

/**
 * Family of policy types. Mirrors DDD-07's listing.
 */
export type PolicyType =
  | 'password'
  | 'account_lockout'
  | 'session'
  | 'mfa'
  | 'access'
  | 'k8s'
  | 'secrets'
  | 'cve';

/**
 * Configuration blob for a `SecurityPolicy`. The shape is open since
 * different policy types pack different parameters; the engine reads
 * what it needs.
 */
export interface PolicyConfig {
  /** Builtin check identifier (e.g. `k8s.privileged`). */
  checkId?: string;
  /** Optional additional parameters (e.g. severity floor, allowed images). */
  parameters?: Record<string, unknown>;
  /** Human-readable description for operators. */
  description?: string;
  /** Suggested remediation when this policy fires. */
  recommendation?: string;
  /** Default severity for findings produced by this policy. */
  severity?: Severity;
}

/**
 * A single control assessment inside a `ComplianceReport`. References
 * the findings that supported the judgment so auditors can trace
 * evidence end-to-end.
 */
export interface ControlAssessment {
  controlId: string;
  framework: ComplianceFramework;
  title: string;
  category: string;
  status: ControlStatus;
  supportingFindings: FindingId[];
  rationale?: string;
}

/**
 * Stable fingerprint used to dedupe findings across re-scans. Computed
 * on the client side as `${policyId}|${kind}|${namespace}|${name}` —
 * see `Finding.fingerprintFor`.
 */
export type FindingFingerprint = string & { readonly _t: 'FindingFingerprint' };

export function asFingerprint(raw: string): FindingFingerprint {
  return raw as FindingFingerprint;
}

export interface SignedBy {
  userId: UserId;
  signedAt: Instant;
}

export type ReportId_ = ReportId;
