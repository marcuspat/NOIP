// DiscoveryService tests with in-memory repos and a fake K8s client.

import { DiscoveryService } from '../../../src/contexts/discovery/application/discovery.service';
import { Cluster } from '../../../src/contexts/discovery/domain/cluster';
import { ClusterScan } from '../../../src/contexts/discovery/domain/cluster-scan';
import { ResourceSnapshot } from '../../../src/contexts/discovery/domain/resource-snapshot';
import { DriftReport } from '../../../src/contexts/discovery/domain/drift-report';
import type { ClusterRepository } from '../../../src/contexts/discovery/infrastructure/persistence/cluster.repository';
import type { ClusterScanRepository } from '../../../src/contexts/discovery/infrastructure/persistence/cluster-scan.repository';
import type { ResourceSnapshotRepository } from '../../../src/contexts/discovery/infrastructure/persistence/resource-snapshot.repository';
import type { DriftReportRepository } from '../../../src/contexts/discovery/infrastructure/persistence/drift-report.repository';
import type {
  ClusterInfoView,
  KubernetesClient,
  NodeInfoView,
} from '../../../src/contexts/discovery/domain/ports/kubernetes-client';
import type {
  ContentHash,
  KubernetesResourceRecord,
  ResourceRef,
  ResourceSnapshotRef,
  Scope,
  TimeRange,
} from '../../../src/contexts/discovery/domain/value-objects';
import {
  FixedClock,
  InMemoryEventBus,
  type ClusterId,
  type DomainEvent,
  type DriftId,
  type ScanId,
  type SnapshotId,
} from '../../../src/shared/kernel';

class InMemoryClusterRepo implements ClusterRepository {
  store = new Map<string, Cluster>();
  async save(c: Cluster): Promise<void> {
    // Round-trip via persistence so we don't share mutable state.
    this.store.set(c.id, Cluster.fromPersistence(c.toPersistence()));
  }
  async findById(id: ClusterId): Promise<Cluster | null> {
    const c = this.store.get(id);
    return c ? Cluster.fromPersistence(c.toPersistence()) : null;
  }
  async findAll(): Promise<Cluster[]> {
    return Array.from(this.store.values()).map(c =>
      Cluster.fromPersistence(c.toPersistence())
    );
  }
  async findEnabled(): Promise<Cluster[]> {
    return (await this.findAll()).filter(c => c.enabled);
  }
  async delete(id: ClusterId): Promise<boolean> {
    return this.store.delete(id);
  }
}

class InMemoryScanRepo implements ClusterScanRepository {
  store = new Map<string, ClusterScan>();
  async save(s: ClusterScan): Promise<void> {
    this.store.set(s.id, ClusterScan.fromPersistence(s.toPersistence()));
  }
  async findById(id: ScanId): Promise<ClusterScan | null> {
    const s = this.store.get(id);
    return s ? ClusterScan.fromPersistence(s.toPersistence()) : null;
  }
  async listByCluster(clusterId: ClusterId): Promise<ClusterScan[]> {
    return Array.from(this.store.values())
      .filter(s => s.clusterId === clusterId)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }
  async findLatest(clusterId: ClusterId): Promise<ClusterScan | null> {
    const all = await this.listByCluster(clusterId);
    return all[0] ?? null;
  }
}

class InMemorySnapshotRepo implements ResourceSnapshotRepository {
  store: ResourceSnapshot[] = [];
  async save(s: ResourceSnapshot): Promise<void> {
    // Reject duplicate (clusterId, hash) like the unique index does.
    const dup = this.store.find(
      x => x.clusterId === s.clusterId && x.hash === s.hash
    );
    if (dup) return;
    this.store.push(ResourceSnapshot.fromPersistence(s.toPersistence()));
  }
  async findById(id: SnapshotId): Promise<ResourceSnapshot | null> {
    return this.store.find(x => x.id === id) ?? null;
  }
  async findByHash(
    clusterId: ClusterId,
    hash: ContentHash
  ): Promise<ResourceSnapshot | null> {
    return (
      this.store.find(x => x.clusterId === clusterId && x.hash === hash) ?? null
    );
  }
  async findLatest(clusterId: ClusterId): Promise<ResourceSnapshot | null> {
    const ranked = this.store
      .filter(x => x.clusterId === clusterId)
      .sort((a, b) => (a.takenAt < b.takenAt ? 1 : -1));
    return ranked[0] ?? null;
  }
  async list(
    clusterId: ClusterId,
    range?: TimeRange
  ): Promise<ResourceSnapshotRef[]> {
    return this.store
      .filter(x => x.clusterId === clusterId)
      .filter(
        x =>
          (range?.from === undefined ||
            new Date(x.takenAt as unknown as string) >= range.from) &&
          (range?.to === undefined ||
            new Date(x.takenAt as unknown as string) <= range.to)
      )
      .sort((a, b) => (a.takenAt < b.takenAt ? 1 : -1))
      .map(x => ({
        id: x.id,
        clusterId: x.clusterId,
        takenAt: new Date(x.takenAt as unknown as string),
        hash: x.hash,
        counts: x.counts,
      }));
  }
  async findResource(
    _clusterId: ClusterId,
    _ref: ResourceRef,
    _at?: Date
  ): Promise<KubernetesResourceRecord | null> {
    return null;
  }
}

class InMemoryDriftRepo implements DriftReportRepository {
  store = new Map<string, DriftReport>();
  async save(r: DriftReport): Promise<void> {
    this.store.set(r.id, DriftReport.fromPersistence(r.toPersistence()));
  }
  async findById(id: DriftId): Promise<DriftReport | null> {
    return this.store.get(id) ?? null;
  }
  async listByCluster(clusterId: ClusterId): Promise<DriftReport[]> {
    return Array.from(this.store.values()).filter(
      r => r.clusterId === clusterId
    );
  }
}

class FakeK8s implements KubernetesClient {
  records: KubernetesResourceRecord[] = [];
  failNext = false;

  async *listResources(_scope: Scope): AsyncIterable<KubernetesResourceRecord> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('kube down');
    }
    for (const r of this.records) yield r;
  }
  async getCluster(): Promise<ClusterInfoView> {
    return {
      name: 'fake',
      endpoint: 'https://api',
      version: 'v1.28',
      nodeCount: 0,
      namespaceCount: 0,
      podCount: 0,
      serviceCount: 0,
      lastScan: new Date(),
    };
  }
  async getNamespaces(): Promise<string[]> {
    return ['default'];
  }
  async getNodeInfo(): Promise<NodeInfoView[]> {
    return [];
  }
}

const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));

function pod(name: string, replicas = 1): KubernetesResourceRecord {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    name,
    namespace: 'default',
    labels: {},
    annotations: {},
    spec: { replicas },
    status: null,
  };
}

describe('DiscoveryService.triggerScan', () => {
  let clusters: InMemoryClusterRepo;
  let scans: InMemoryScanRepo;
  let snapshots: InMemorySnapshotRepo;
  let drifts: InMemoryDriftRepo;
  let k8s: FakeK8s;
  let bus: InMemoryEventBus;
  let observed: DomainEvent<unknown>[] = [];
  let svc: DiscoveryService;

  beforeEach(() => {
    clusters = new InMemoryClusterRepo();
    scans = new InMemoryScanRepo();
    snapshots = new InMemorySnapshotRepo();
    drifts = new InMemoryDriftRepo();
    k8s = new FakeK8s();
    bus = new InMemoryEventBus({
      warn: () => undefined,
      error: () => undefined,
    });
    observed = [];
    bus.subscribe('discovery.*', evt => {
      observed.push(evt);
    });
    svc = new DiscoveryService({
      clusters,
      scans,
      snapshots,
      drifts,
      k8s,
      bus,
      clock,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });
  });

  it('register → trigger → scanned (no drift on first scan)', async () => {
    const cluster = await svc.registerCluster({
      name: 'p',
      endpoint: 'https://api.example.com',
      credentials: { ref: 'vault://r' },
    });
    k8s.records = [pod('a'), pod('b')];

    const result = await svc.triggerScan(cluster.id);
    expect(result.status).toBe('succeeded');
    expect(result.snapshotId).not.toBeNull();
    expect(result.driftId).toBeNull();
    expect(snapshots.store).toHaveLength(1);

    const types = observed.map(e => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'discovery.cluster.registered',
        'discovery.cluster.scan_started',
        'discovery.cluster.scanned',
      ])
    );
  });

  it('detects drift on the second scan', async () => {
    const cluster = await svc.registerCluster({
      name: 'p',
      endpoint: 'https://api.example.com',
      credentials: { ref: 'vault://r' },
    });

    k8s.records = [pod('a', 1)];
    await svc.triggerScan(cluster.id);

    // Advance clock so the second snapshot has a later takenAt.
    clock.advance(60_000);

    k8s.records = [pod('a', 5)];
    const second = await svc.triggerScan(cluster.id);
    expect(second.driftId).not.toBeNull();
    expect(observed.some(e => e.type === 'discovery.drift.detected')).toBe(
      true
    );
    expect(drifts.store.size).toBe(1);
  });

  it('reuses snapshot when content has not changed', async () => {
    const cluster = await svc.registerCluster({
      name: 'p',
      endpoint: 'https://api.example.com',
      credentials: { ref: 'vault://r' },
    });
    k8s.records = [pod('a', 1)];
    const first = await svc.triggerScan(cluster.id);
    clock.advance(60_000);
    k8s.records = [pod('a', 1)];
    const second = await svc.triggerScan(cluster.id);
    expect(second.snapshotId).toBe(first.snapshotId);
    expect(snapshots.store).toHaveLength(1);
    // No drift event because hashes match.
    expect(observed.some(e => e.type === 'discovery.drift.detected')).toBe(
      false
    );
  });

  it('marks the scan failed when k8s yields no records and errors', async () => {
    const cluster = await svc.registerCluster({
      name: 'p',
      endpoint: 'https://api.example.com',
      credentials: { ref: 'vault://r' },
    });
    k8s.failNext = true;
    k8s.records = [];
    const result = await svc.triggerScan(cluster.id);
    expect(result.status).toBe('failed');
    expect(snapshots.store).toHaveLength(0);
    expect(observed.some(e => e.type === 'discovery.cluster.scan_failed')).toBe(
      true
    );
  });
});
