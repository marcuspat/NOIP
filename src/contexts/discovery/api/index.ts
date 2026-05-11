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
import { SnapshotArchiver } from '../domain/snapshot-archiver';
import type {
  SnapshotArchiverConfig,
  SnapshotArchiverLogger,
} from '../domain/snapshot-archiver';
import type { SnapshotArchiveStore } from '../domain/ports/snapshot-archive-store';
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
export type { StartArchiveLoopOpts } from '../application/scheduler';
export {
  KubernetesAdapter,
  type RawKubernetesClient,
} from '../infrastructure/kubernetes/kubernetes-adapter';
export { KubernetesClientFactory } from '../infrastructure/kubernetes/kubernetes-client-factory';

// ---------------------------------------------------------------------------
// Archive tier (DDD-06 follow-up)
// ---------------------------------------------------------------------------
export { SnapshotArchiver } from '../domain/snapshot-archiver';
export type {
  ArchiveOutcome,
  ArchiveSummary,
  SnapshotArchivedPayload,
  SnapshotArchivedEvent,
  SnapshotArchiverConfig,
  SnapshotArchiverDeps,
  SnapshotArchiverLogger,
} from '../domain/snapshot-archiver';
export type {
  SnapshotArchiveStore,
  SnapshotArchiveUploadOpts,
  SnapshotArchiveUploadResult,
} from '../domain/ports/snapshot-archive-store';
export { buildArchiveKey } from '../domain/ports/snapshot-archive-store';
export { NotConfiguredError, IntegrityError } from '../domain/archive-errors';
export { S3SnapshotArchiveAdapter } from '../infrastructure/archive/s3-archive-adapter';
export type {
  S3ArchiveAdapterEnv,
  S3ClientFactory,
  S3ClientLike,
  S3SnapshotArchiveAdapterOpts,
} from '../infrastructure/archive/s3-archive-adapter';
export { LocalFsSnapshotArchiveAdapter } from '../infrastructure/archive/local-fs-archive-adapter';
export type { LocalFsArchiveAdapterOpts } from '../infrastructure/archive/local-fs-archive-adapter';
export { createSnapshotArchiveStore } from '../infrastructure/archive/composite-archive-store';
export type { CreateSnapshotArchiveStoreOpts } from '../infrastructure/archive/composite-archive-store';

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
  /**
   * Optional cold-tier object store. When supplied a `SnapshotArchiver`
   * is built and attached to the scheduler so the composition root can
   * call `scheduler.startArchiveLoop(...)`.
   */
  archiveStore?: SnapshotArchiveStore;
  /** Tuning for the archiver. Defaults documented on
   * `SnapshotArchiverConfig`. */
  archiveConfig?: SnapshotArchiverConfig;
  /** Override logger for archive operations (falls back to `logger`). */
  archiveLogger?: SnapshotArchiverLogger;
}

export interface ComposedDiscovery {
  service: DiscoveryService;
  scheduler: DiscoveryScheduler;
  publicApi: DiscoveryPublicApi;
  /** Present only when `archiveStore` was supplied. */
  archiver?: SnapshotArchiver;
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

  let archiver: SnapshotArchiver | undefined;
  if (deps.archiveStore) {
    archiver = new SnapshotArchiver({
      repository: snapshots,
      store: deps.archiveStore,
      bus: deps.bus,
      clock: deps.clock,
      logger: deps.archiveLogger ?? deps.logger,
      ...(deps.archiveConfig ? { config: deps.archiveConfig } : {}),
    });
  }

  const scheduler = new DiscoveryScheduler({
    discoveryService: service,
    clusters: async () => {
      const list = await clusters.findEnabled();
      return list.map(c => ({ id: c.id, enabled: c.enabled }));
    },
    clock: deps.clock,
    logger: deps.logger,
    ...(archiver ? { archiver } : {}),
  });

  const publicApi: DiscoveryPublicApi = {
    getLatestSnapshot: scope => service.getLatestSnapshot(scope.clusterId),
    listSnapshots: (scope, range) =>
      service.listSnapshots(scope.clusterId, range),
    getResource: (clusterId, ref, at) =>
      service.getResource(clusterId, ref, at),
    compareSnapshots: (prev, curr) => service.compareSnapshots(prev, curr),
  };

  const out: ComposedDiscovery = { service, scheduler, publicApi };
  if (archiver) out.archiver = archiver;
  return out;
}
