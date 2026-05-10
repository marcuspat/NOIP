// Value objects for the Infrastructure Discovery context (DDD-06).
//
// Pure data shapes — no behaviour, no persistence concerns. Application
// services and aggregates compose these; the HTTP edge re-projects them
// onto the legacy `KubernetesResource`/`ClusterInfo` shape so existing
// integrations don't break.

import type { ClusterId, SnapshotId } from '../../../shared/kernel';

/**
 * Lifecycle states for a `ClusterScan`. The state machine is monotonic
 * (`pending → running → succeeded | failed | partial`); transitions are
 * enforced inside the aggregate.
 */
export type ScanStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'partial';

/**
 * Severity classification used by drift, security, and audit subsystems.
 * Ordered so a `Math.max`-style "highest wins" comparison is meaningful;
 * `severityRank` does the lookup.
 */
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

/** What changed in a `ResourceChange`. */
export type ChangeKind = 'created' | 'updated' | 'deleted';

/**
 * Globally identifies a single Kubernetes resource within a cluster
 * scope. `apiVersion + kind + namespace + name` is the canonical key
 * the kube apiserver itself uses.
 */
export interface ResourceRef {
  apiVersion: string;
  kind: string;
  namespace?: string;
  name: string;
}

/**
 * Canonical record we store per-resource. Foreign fields (`managedFields`,
 * `resourceVersion`, `uid`, `creationTimestamp`) are dropped at the ACL
 * boundary so the hash is stable across kube apiserver restarts.
 */
export interface KubernetesResourceRecord {
  apiVersion: string;
  kind: string;
  namespace?: string;
  name: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  spec: unknown;
  status: unknown;
}

/**
 * Bounded query envelope for `KubernetesClient.listResources`. An empty
 * `kinds` array means "every kind the apiserver advertises that we have
 * RBAC for" — the adapter expands this via `/apis` discovery.
 */
export interface Scope {
  clusterId: ClusterId;
  namespace?: string;
  kinds?: string[];
  labelSelector?: string;
}

/**
 * Time window used by snapshot listings. Both bounds are optional; the
 * repository uses `gte`/`lte` semantics so a one-sided range works as
 * "since X" or "up to X".
 */
export interface TimeRange {
  from?: Date;
  to?: Date;
}

/**
 * Per-kind counts produced by a successful scan. Stored on both the
 * `ClusterScan` and the `ResourceSnapshot`. The legacy `ClusterInfo`
 * shape projects four of these as top-level fields.
 */
export interface Counters {
  total: number;
  nodeCount: number;
  namespaceCount: number;
  podCount: number;
  serviceCount: number;
  deploymentCount: number;
}

export function emptyCounters(): Counters {
  return {
    total: 0,
    nodeCount: 0,
    namespaceCount: 0,
    podCount: 0,
    serviceCount: 0,
    deploymentCount: 0,
  };
}

/** Branded sha256 hex string. */
export type ContentHash = string & { readonly _t: 'ContentHash' };

export function asContentHash(hex: string): ContentHash {
  return hex as ContentHash;
}

/**
 * RFC-6902 JSON Patch operations we emit from `DriftCalculator`. We do
 * not currently emit `move`, `copy`, or `test` ops — they're not needed
 * for change reporting and add ambiguity to severity classification.
 */
export type JSONPatchOp =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: unknown };

export interface ResourceChange {
  kind: ChangeKind;
  ref: ResourceRef;
  patch: JSONPatchOp[];
  severity: Severity;
  rationale?: string;
}

/** Lightweight pointer used by the Public API to list snapshots. */
export interface ResourceSnapshotRef {
  id: SnapshotId;
  clusterId: ClusterId;
  takenAt: Date;
  hash: ContentHash;
  counts: Counters;
}

/**
 * Reasons a scan can fail. The adapter surfaces these as typed errors;
 * the application service stores the discriminator on the scan aggregate
 * so the HTTP edge and the SOC pipeline can branch on it.
 */
export interface ScanError {
  code:
    | 'PROVIDER_ERROR'
    | 'BACKPRESSURE'
    | 'UNAUTHORIZED'
    | 'TIMEOUT'
    | 'INTERNAL_ERROR';
  message: string;
}
