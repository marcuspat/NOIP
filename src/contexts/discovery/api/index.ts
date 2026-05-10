// Public API barrel for the Infrastructure Discovery context.
// Per ADR-0011 cross-context code MUST only import from this module.
//
// What we expose:
//   - The `DiscoveryPublicApi` interface (DDD-06).
//   - The aggregate types other contexts compose with (`Cluster`,
//     `ResourceSnapshot`, `DriftReport`, value objects).
//   - The `composeDiscovery` factory that wires the application
//     service for production callers (the composition root) and tests.
//   - The HTTP router factory.
//
// Anything not re-exported here is private to the context.

import type {
  ClusterId,
  Clock,
  EventBus,
  SnapshotId,
} from '../../../shared/kernel';
import { DiscoveryService } from '../application/discovery.service';
import type { DiscoveryServiceLogger } from '../application/discovery.service';
import { DiscoveryScheduler } from '../application/scheduler';
import { MongooseClusterRepository } from '../infrastructure/persistence/cluster.repository';
import { MongooseClusterScanRepository } from '../infrastructure/persistence/cluster-scan.repository';
import { MongooseResourceSnapshotRepository } from '../infrastructure/persistence/resource-snapshot.repository';
import { MongooseDriftReportRepository } from '../infrastructure/persistence/drift-report.repository';
import type { KubernetesClient } from '../domain/ports/kubernetes-client';
import type { ResourceSnapshot } from '../domain/resource-snapshot';
import type { DriftReport } from '../domain/drift-report';
import type {
  KubernetesResourceRecord,
  ResourceRef,
  ResourceSnapshotRef,
  Scope,
  TimeRange,
} from '../domain/value-objects';

// ---------------------------------------------------------------------------
// Re-exports (public domain types)
// ---------------------------------------------------------------------------
export { Cluster } from '../domain/cluster';
export type {
  ClusterRegisterSpec,
  ClusterCredentialsRef,
} from '../domain/cluster';
export { ClusterScan } from '../domain/cluster-scan';
export { ResourceSnapshot } from '../domain/resource-snapshot';
export { DriftReport } from '../domain/drift-report';
export type {
  ContentHash,
  Counters,
  KubernetesResourceRecord,
  ResourceChange,
  ResourceRef,
  ResourceSnapshotRef,
  ScanError,
  ScanStatus,
  Scope,
  Severity,
  TimeRange,
  JSONPatchOp,
  ChangeKind,
} from '../domain/value-objects';
export type {
  KubernetesClient,
  ClusterSpec,
  ClusterInfoView,
  NodeInfoView,
} from '../domain/ports/kubernetes-client';
export { DiscoveryService } from '../application/discovery.service';
export { DiscoveryScheduler } from '../application/scheduler';
export {
  KubernetesAdapter,
  type RawKubernetesClient,
} from '../infrastructure/kubernetes/kubernetes-adapter';
export { KubernetesClientFactory } from '../infrastructure/kubernetes/kubernetes-client-factory';

// ---------------------------------------------------------------------------
// Public API contract per DDD-06
// ---------------------------------------------------------------------------

export interface DiscoveryPublicApi {
  getLatestSnapshot(scope: Scope): Promise<ResourceSnapshot>;
  listSnapshots(
    scope: Scope,
    range?: TimeRange
  ): Promise<ResourceSnapshotRef[]>;
  getResource(
    clusterId: ClusterId,
    ref: ResourceRef,
    at?: Date
  ): Promise<KubernetesResourceRecord | null>;
  compareSnapshots(
    prev: SnapshotId,
    curr: SnapshotId
  ): Promise<DriftReport | null>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface ComposeDiscoveryDeps {
  /** A connected mongoose instance is implicit — the schemas register
   * against the global mongoose. We keep the option open here so a
   * future migration to a context-local database is one DI swap. */
  k8s: KubernetesClient;
  bus: EventBus;
  clock: Clock;
  logger: DiscoveryServiceLogger;
}

export interface ComposedDiscovery {
  service: DiscoveryService;
  scheduler: DiscoveryScheduler;
  publicApi: DiscoveryPublicApi;
}

export function composeDiscovery(
  deps: ComposeDiscoveryDeps
): ComposedDiscovery {
  const clusters = new MongooseClusterRepository();
  const scans = new MongooseClusterScanRepository();
  const snapshots = new MongooseResourceSnapshotRepository();
  const drifts = new MongooseDriftReportRepository();

  const service = new DiscoveryService({
    clusters,
    scans,
    snapshots,
    drifts,
    k8s: deps.k8s,
    bus: deps.bus,
    clock: deps.clock,
    logger: deps.logger,
  });

  const scheduler = new DiscoveryScheduler({
    discoveryService: service,
    clusters: async () => {
      const list = await clusters.findEnabled();
      return list.map((c) => ({ id: c.id, enabled: c.enabled }));
    },
    clock: deps.clock,
    logger: deps.logger,
  });

  const publicApi: DiscoveryPublicApi = {
    getLatestSnapshot: (scope) => service.getLatestSnapshot(scope.clusterId),
    listSnapshots: (scope, range) =>
      service.listSnapshots(scope.clusterId, range),
    getResource: (clusterId, ref, at) => service.getResource(clusterId, ref, at),
    compareSnapshots: (prev, curr) => service.compareSnapshots(prev, curr),
  };

  return { service, scheduler, publicApi };
}
