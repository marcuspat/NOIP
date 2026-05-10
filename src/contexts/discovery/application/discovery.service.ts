// DiscoveryService — application service for the Infrastructure Discovery
// context (DDD-06).
//
// Responsibilities:
//   - Drive the scan use-case: open a `ClusterScan`, walk the kube
//     apiserver via `KubernetesClient`, build and persist a
//     `ResourceSnapshot`, compute drift vs. the previous snapshot,
//     persist a `DriftReport` if there are changes, and complete
//     the scan.
//   - Publish the matching domain events *after* persistence commits.
//   - Maintain back-compat with the legacy HTTP shape via
//     `scanCluster()` / `getResources()` / `getNamespaces()` /
//     `getNodeInfo()` so the routes that already exist keep working.
//
// Eventing rules: aggregates collect events into `pendingEvents` and
// the service drains them with `drainEvents()` after each successful
// repository save. We never publish events for an aborted command.

import type {
  ClusterId,
  Clock,
  EventBus,
  ScanId,
  SnapshotId,
} from '../../../shared/kernel';
import {
  BackpressureError,
  NotFoundError,
  ProviderError,
} from '../../../shared/errors';
import type { ClusterRepository } from '../infrastructure/persistence/cluster.repository';
import type { ClusterScanRepository } from '../infrastructure/persistence/cluster-scan.repository';
import type { ResourceSnapshotRepository } from '../infrastructure/persistence/resource-snapshot.repository';
import type { DriftReportRepository } from '../infrastructure/persistence/drift-report.repository';
import { Cluster, type ClusterRegisterSpec } from '../domain/cluster';
import { ClusterScan } from '../domain/cluster-scan';
import { ResourceSnapshot } from '../domain/resource-snapshot';
import { DriftReport } from '../domain/drift-report';
import { DriftCalculator } from '../domain/drift-calculator';
import type {
  ClusterInfoView,
  KubernetesClient,
  NodeInfoView,
} from '../domain/ports/kubernetes-client';
import type {
  KubernetesResourceRecord,
  ResourceRef,
  ResourceSnapshotRef,
  Scope,
  ScanError,
  TimeRange,
} from '../domain/value-objects';

export interface DiscoveryServiceLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface DiscoveryServiceDeps {
  clusters: ClusterRepository;
  scans: ClusterScanRepository;
  snapshots: ResourceSnapshotRepository;
  drifts: DriftReportRepository;
  k8s: KubernetesClient;
  bus: EventBus;
  clock: Clock;
  logger: DiscoveryServiceLogger;
  /** Optional override for tests. */
  driftCalculator?: DriftCalculator;
}

export interface TriggerScanResult {
  scanId: ScanId;
  snapshotId: SnapshotId | null;
  driftId: string | null;
  status: 'succeeded' | 'partial' | 'failed';
}

const NOOP_LOGGER: DiscoveryServiceLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export class DiscoveryService {
  private readonly clusters: ClusterRepository;
  private readonly scans: ClusterScanRepository;
  private readonly snapshots: ResourceSnapshotRepository;
  private readonly drifts: DriftReportRepository;
  private readonly k8s: KubernetesClient;
  private readonly bus: EventBus;
  private readonly clock: Clock;
  private readonly logger: DiscoveryServiceLogger;
  private readonly driftCalculator: DriftCalculator;

  constructor(deps: DiscoveryServiceDeps) {
    this.clusters = deps.clusters;
    this.scans = deps.scans;
    this.snapshots = deps.snapshots;
    this.drifts = deps.drifts;
    this.k8s = deps.k8s;
    this.bus = deps.bus;
    this.clock = deps.clock;
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.driftCalculator = deps.driftCalculator ?? new DriftCalculator();
  }

  // ---------------------------------------------------------------------------
  // New, ADR-conformant API
  // ---------------------------------------------------------------------------

  async registerCluster(spec: ClusterRegisterSpec): Promise<Cluster> {
    const cluster = Cluster.register(spec, this.clock);
    await this.clusters.save(cluster);
    this.bus.publishMany(cluster.drainEvents());
    return cluster;
  }

  async listClusters(): Promise<Cluster[]> {
    return this.clusters.findAll();
  }

  async getCluster(id: ClusterId): Promise<Cluster> {
    const cluster = await this.clusters.findById(id);
    if (!cluster) throw new NotFoundError('Cluster', id);
    return cluster;
  }

  async deleteCluster(id: ClusterId): Promise<void> {
    const removed = await this.clusters.delete(id);
    if (!removed) throw new NotFoundError('Cluster', id);
  }

  async getLatestSnapshot(clusterId: ClusterId): Promise<ResourceSnapshot> {
    const snap = await this.snapshots.findLatest(clusterId);
    if (!snap) {
      throw new NotFoundError('ResourceSnapshot', `cluster=${clusterId}`);
    }
    return snap;
  }

  async getLatestSnapshotById(id: SnapshotId): Promise<ResourceSnapshot> {
    const snap = await this.snapshots.findById(id);
    if (!snap) throw new NotFoundError('ResourceSnapshot', id);
    return snap;
  }

  async listSnapshots(
    clusterId: ClusterId,
    range?: TimeRange,
    limit?: number
  ): Promise<ResourceSnapshotRef[]> {
    return this.snapshots.list(clusterId, range, limit);
  }

  async getResource(
    clusterId: ClusterId,
    ref: ResourceRef,
    at?: Date
  ): Promise<KubernetesResourceRecord | null> {
    return this.snapshots.findResource(clusterId, ref, at);
  }

  /**
   * Returns the diff between two named snapshots. Either argument
   * being null/missing surfaces as a 404.
   */
  async compareSnapshots(
    prev: SnapshotId,
    curr: SnapshotId
  ): Promise<DriftReport | null> {
    const [a, b] = await Promise.all([
      this.snapshots.findById(prev),
      this.snapshots.findById(curr),
    ]);
    if (!a) throw new NotFoundError('ResourceSnapshot', prev);
    if (!b) throw new NotFoundError('ResourceSnapshot', curr);
    return this.driftCalculator.compare(a, b, this.clock);
  }

  async listDriftReports(clusterId: ClusterId): Promise<DriftReport[]> {
    return this.drifts.listByCluster(clusterId);
  }

  async getDriftReport(id: string): Promise<DriftReport> {
    const r = await this.drifts.findById(id as never);
    if (!r) throw new NotFoundError('DriftReport', id);
    return r;
  }

  /**
   * Core use-case. Open a scan, list cluster resources, build a
   * snapshot, compute drift, complete the scan, emit events.
   *
   * Failure semantics:
   *   - The kube adapter raises `BackpressureError` / `ProviderError`
   *     after retries exhaust. We mark the scan as `failed` and emit
   *     `discovery.cluster.scan_failed`.
   *   - If we got *some* records before the error, we mark the scan
   *     `partial` and persist the partial snapshot anyway. The SOC
   *     can choose to ignore partial snapshots.
   */
  async triggerScan(clusterId: ClusterId): Promise<TriggerScanResult> {
    const cluster = await this.clusters.findById(clusterId);
    if (!cluster) throw new NotFoundError('Cluster', clusterId);
    if (!cluster.enabled) {
      throw new ProviderError('cluster is disabled', { clusterId });
    }

    const scan = ClusterScan.open(clusterId, this.clock);
    scan.start(this.clock);
    await this.scans.save(scan);
    this.bus.publishMany(scan.drainEvents());

    const records: KubernetesResourceRecord[] = [];
    let partialError: ScanError | null = null;
    try {
      for await (const r of this.k8s.listResources({ clusterId })) {
        records.push(r);
      }
    } catch (err) {
      partialError = this.toScanError(err);
      this.logger.warn('discovery scan: k8s listing errored', {
        clusterId,
        scanId: scan.id,
        error: partialError.message,
      });
    }

    // No records and an error → fully failed.
    if (records.length === 0 && partialError !== null) {
      scan.fail(partialError, this.clock);
      await this.scans.save(scan);
      this.bus.publishMany(scan.drainEvents());
      return { scanId: scan.id, snapshotId: null, driftId: null, status: 'failed' };
    }

    // Build the snapshot. The hash determines whether we reuse an
    // existing row (no-change) or persist a new one.
    let snapshot = ResourceSnapshot.create(
      clusterId,
      scan.id,
      records,
      this.clock
    );
    const existing = await this.snapshots.findByHash(clusterId, snapshot.hash);
    if (existing !== null) {
      // Reuse existing snapshot — collapses no-change scans onto a
      // single row. We don't update its `takenAt` so historical
      // ordering stays intact.
      snapshot = existing;
    } else {
      await this.snapshots.save(snapshot);
    }

    // Drift vs. the previous snapshot in chronological order. We
    // only consider snapshots strictly older than the new one to
    // avoid comparing against ourselves on a no-change reuse.
    const previousList = await this.snapshots.list(
      clusterId,
      { to: new Date(snapshot.takenAt as unknown as string) },
      2
    );
    let driftId: string | null = null;
    const previous = previousList.find((s) => s.id !== snapshot.id);
    if (previous) {
      const prevSnap = await this.snapshots.findById(previous.id);
      if (prevSnap) {
        const drift = this.driftCalculator.compare(
          prevSnap,
          snapshot,
          this.clock
        );
        if (drift) {
          await this.drifts.save(drift);
          this.bus.publishMany(drift.drainEvents());
          driftId = drift.id;
        }
      }
    }

    // Complete the scan and persist the cluster's lastScanAt bump.
    if (partialError !== null) {
      scan.partial(snapshot.id, snapshot.counts, partialError, this.clock);
    } else {
      scan.succeed(snapshot.id, snapshot.counts, this.clock);
    }
    await this.scans.save(scan);
    this.bus.publishMany(scan.drainEvents());

    cluster.markScanned(snapshot.takenAt);
    await this.clusters.save(cluster);

    return {
      scanId: scan.id,
      snapshotId: snapshot.id,
      driftId,
      status: partialError !== null ? 'partial' : 'succeeded',
    };
  }

  private toScanError(err: unknown): ScanError {
    if (err instanceof BackpressureError) {
      return { code: 'BACKPRESSURE', message: err.message };
    }
    if (err instanceof ProviderError) {
      return { code: 'PROVIDER_ERROR', message: err.message };
    }
    return {
      code: 'INTERNAL_ERROR',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // ---------------------------------------------------------------------------
  // Legacy back-compat surface — keeps the existing /api/discovery/*
  // routes working on real adapter data.
  // ---------------------------------------------------------------------------

  async scanCluster(clusterId?: ClusterId): Promise<ClusterInfoView> {
    if (clusterId) {
      const view = await this.k8s.getCluster({});
      const cluster = await this.clusters.findById(clusterId);
      if (cluster) {
        return { ...view, name: cluster.name };
      }
      return view;
    }
    return this.k8s.getCluster({});
  }

  async getResources(namespace?: string): Promise<KubernetesResourceRecord[]> {
    const out: KubernetesResourceRecord[] = [];
    const scope: Scope = { clusterId: 'legacy' as ClusterId };
    if (namespace !== undefined) scope.namespace = namespace;
    for await (const r of this.k8s.listResources(scope)) {
      out.push(r);
    }
    return out;
  }

  async getNamespaces(): Promise<string[]> {
    return this.k8s.getNamespaces();
  }

  async getNodeInfo(): Promise<NodeInfoView[]> {
    return this.k8s.getNodeInfo();
  }

  async healthCheck(): Promise<{ status: string; lastScan?: Date }> {
    return { status: 'healthy', lastScan: this.clock.now() };
  }

  // The composition root drives the scheduler from outside the service
  // so we don't have to thread the interval here. `initialize` and
  // `stop` are kept as no-ops for back-compat with the legacy callsite.
  async initialize(): Promise<void> {
    this.logger.info('DiscoveryService initialised');
  }

  async stop(): Promise<void> {
    this.logger.info('DiscoveryService stopped');
  }
}
