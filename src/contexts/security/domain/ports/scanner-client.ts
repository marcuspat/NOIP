// Scanner client port — domain-side interface that infrastructure
// adapters (Trivy, kube-bench, kube-linter, the in-tree
// `BuiltinPolicyScanner`) implement.
//
// Adapters translate foreign types (CVE feeds, CLI output, JSON
// reports) into NOIP-domain `RawFinding` objects. The application
// service then promotes them to `Finding` aggregates and persists
// them.

import type { PolicyId } from '../../../../shared/kernel';
import type { Evidence, ResourceRef, Severity } from '../value-objects';

/**
 * A scanner-emitted finding before it's promoted to a domain `Finding`
 * aggregate. We keep this shape explicit so adapters never instantiate
 * aggregates directly — the application service owns aggregate lifecycle.
 */
export interface RawFinding {
  policyId: PolicyId;
  resource: ResourceRef;
  severity: Severity;
  description: string;
  recommendation?: string;
  evidence: Evidence;
}

/** Bundle of resources scanners run against. */
export interface ScannerInput {
  /** Records the scan operates on. */
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
}

/**
 * The minimal capability surface scanners must offer. `id` is logged
 * with each finding and lets the application service skip disabled
 * scanners declaratively.
 */
export interface ScannerClient {
  readonly id: string;
  scan(input: ScannerInput): Promise<RawFinding[]>;
}
