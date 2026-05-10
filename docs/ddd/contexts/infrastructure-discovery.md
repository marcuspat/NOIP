# Bounded Context: Infrastructure Discovery

> *Core subdomain.* Continuous, accurate, near-real-time inventory of
> cloud and Kubernetes resources is NOIP's central differentiator.

## Purpose

Enumerate, snapshot, and diff the resources in customer Kubernetes
clusters (and, in roadmap, in cloud accounts). Provide a stable,
NOIP-shaped view of those resources to every other context — without
leaking Kubernetes' vocabulary outwards.

## Ubiquitous language (canonical)

`Cluster` · `Namespace` · `Resource` · `Discovery Run` · `Snapshot` ·
`Drift`. See [`../ubiquitous-language.md`](../ubiquitous-language.md).

## Source layout

| Concern        | File                                       |
| -------------- | ------------------------------------------ |
| Domain service | `src/services/discovery.service.ts`        |
| Types          | `src/types/index.ts` (Cluster, KubernetesResource) |
| HTTP           | mounted in `src/app.ts` under `/api/v1/discovery/*` |

Aggregate models for `Cluster`, `Snapshot`, `DriftReport` are
**planned** — currently the service returns mock data. Their shapes
are described below as the contract that the upcoming models must
satisfy.

## Aggregates

### Cluster
- **Root**: `Cluster`.
- **Identity**: `ClusterId`.
- **Fields**: `name`, `endpoint` (URL), `credentialRef` (Secret
  name), `addedAt`, `lastScanAt`, `status: registered | scanning |
  active | unreachable`.
- **Invariants**:
  1. `name` unique within tenant.
  2. `credentialRef` resolves to a real secret at scan time
     (validated lazily).

### Snapshot
- **Root**: `Snapshot`.
- **Identity**: `SnapshotId`.
- **References**: `clusterId: ClusterId`, `discoveryRunId`.
- **Embedded entities**: many `ResourceRecord`s — each is an immutable
  point-in-time view of a Kubernetes resource normalised to NOIP
  shape:
  ```ts
  type ResourceRecord = {
    kind: string;        // Pod, Deployment, ConfigMap, ...
    apiVersion: string;
    namespace: string;
    name: string;
    uid: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
    spec: unknown;       // structurally validated subset
    fingerprint: string; // sha256 of canonicalised body
    capturedAt: Date;
  };
  ```
- **Invariants**:
  1. **Immutable** once `finalisedAt` is set.
  2. Snapshots for a cluster form a strictly increasing sequence by
     `discoveryRunId` (used to compute drift).

### DriftReport
- **Root**: `DriftReport`.
- **References**: `clusterId`, `fromSnapshotId`, `toSnapshotId`.
- **Embedded entities**: many `DriftItem`s — `{ kind, namespace,
  name, change: 'added' | 'removed' | 'modified', diff, severity }`.
- **Invariants**:
  1. `fromSnapshotId.discoveryRunId < toSnapshotId.discoveryRunId`.
  2. A `DriftItem` references a resource that exists in at least one
     of the two snapshots.

## Anti-Corruption Layer to Kubernetes

The K8s API has many quirks we do **not** want propagated:

- API-version churn (`v1beta1` → `v1`).
- Generated fields (`status`, `resourceVersion`).
- Inconsistent metadata across resource kinds.

The ACL lives entirely inside `discovery.service.ts` (today as a
mock; in production as a typed K8s client wrapper). It produces
`ResourceRecord`s and never lets a raw K8s object escape.

Mapping rules:

- Drop `status.*` from `spec` capture; status is observed
  separately by the Performance/Observability context.
- Normalise `metadata.creationTimestamp` to ISO-8601 in UTC.
- Compute `fingerprint` over a canonicalised, status-stripped
  document so semantically equivalent payloads compare equal.

## Domain service

`DiscoveryService`:

- `registerCluster(input)` → `Cluster` + `discovery.ClusterRegistered`.
- `scanCluster(clusterId)` → starts a `DiscoveryRun`, emits
  `discovery.ScanStarted`. Streams resources in pages, builds a
  `Snapshot`, then computes `DriftReport` against the previous
  snapshot. Emits `discovery.SnapshotCompleted` and
  `discovery.DriftDetected` (if non-empty).
- `getCluster(clusterId)`, `listClusters()`.
- `getSnapshot(snapshotId)`, `getLatestSnapshot(clusterId)`.
- `getDrift(driftId)`, `listDrift(clusterId, filters)`.

## Domain events

`discovery.ClusterRegistered`, `discovery.ScanStarted`,
`discovery.SnapshotCompleted`, `discovery.DriftDetected`,
`discovery.ScanFailed`. See
[`../domain-events.md`](../domain-events.md).

## Integration with neighbouring contexts

- **Security Operations** subscribes to `SnapshotCompleted` to scan
  for findings (secrets, vulnerabilities, integrity).
- **Compliance & Risk** subscribes to use snapshots as evidence.
- **AI Intelligence** subscribes to summarise snapshots and drift.
- **Dashboard** queries via the service's read API.

## Performance characteristics

- A scan is **O(resources)** — bounded paging from the K8s API.
- Snapshots are write-once and large; they are stored with
  compression and an index by `(clusterId, discoveryRunId)`.
- Drift computation is **O(N + M)** where N and M are the previous
  and current snapshots; we hash records and diff by fingerprint.
- Snapshots older than the configured retention window are pruned by
  a daily job; drift reports are retained longer.

## Out of scope (deliberately)

- **Continuous watch** of K8s resources (informer-style). Polling
  today; watch is a roadmap optimisation.
- **Cloud account discovery** (AWS/GCP/Azure). Schema is
  K8s-specific today; cloud is a separate aggregate type when added.
- **Action on drift.** Discovery reports drift; remediation is
  external (human or AI-recommended).

## Open questions

- Whether to elevate `Snapshot` to its own collection per cluster
  (vs. one shared) once snapshot volume grows.
- Whether `DriftItem.diff` should be a structured patch (JSON Patch)
  or a free-form summary. Today: planned as JSON Patch.
