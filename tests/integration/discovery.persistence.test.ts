import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { DiscoveryService } from '../../src/services/discovery.service';
import { EventBus } from '../../src/utils/event-bus';
import { ClusterModel } from '../../src/models/cluster.model';
import { SnapshotModel } from '../../src/models/snapshot.model';
import { DriftReportModel } from '../../src/models/drift-report.model';
import { KubernetesResource } from '../../src/types';

describe('DiscoveryService persistence', () => {
  let mongoServer: MongoMemoryServer;
  let bus: EventBus;
  let service: DiscoveryService;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await ClusterModel.deleteMany({});
    await SnapshotModel.deleteMany({});
    await DriftReportModel.deleteMany({});
    bus = new EventBus();
    service = new DiscoveryService(bus);
  });

  it('upserts a Cluster and persists an immutable Snapshot on scan', async () => {
    await service.scanCluster();

    const clusters = await ClusterModel.find({});
    expect(clusters).toHaveLength(1);
    expect(clusters[0].name).toBe('noip-cluster');
    expect(clusters[0].credentialRef).toBe('default');
    expect(clusters[0].lastScanAt).toBeInstanceOf(Date);

    const snapshots = await SnapshotModel.find({});
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].resourceCount).toBeGreaterThan(0);
    expect(snapshots[0].resources.length).toBe(snapshots[0].resourceCount);
    expect(snapshots[0].resources[0].fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not record a Cluster duplicate across repeated scans', async () => {
    await service.scanCluster();
    await service.scanCluster();

    expect(await ClusterModel.countDocuments({})).toBe(1);
    expect(await SnapshotModel.countDocuments({})).toBe(2);
  });

  it('detects, persists, and publishes drift between snapshots', async () => {
    // First scan establishes a baseline from the standard fixtures.
    await service.scanCluster();

    // Second scan returns fewer resources, simulating a removed Deployment.
    const reduced: KubernetesResource[] = [
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'noip-api-pod', namespace: 'default', labels: { app: 'noip-api' } },
        status: { phase: 'Running' },
      },
    ];
    jest.spyOn(service, 'getResources').mockResolvedValueOnce(reduced);

    const drifts: Array<{ driftCount: number }> = [];
    bus.subscribe<{ driftCount: number }>('discovery.DriftDetected', (e) => {
      drifts.push(e.payload);
    });

    await service.scanCluster();

    const reports = await DriftReportModel.find({});
    expect(reports).toHaveLength(1);
    expect(reports[0].driftCount).toBeGreaterThan(0);
    // Two of the three baseline resources were removed.
    expect(reports[0].items.some((i) => i.changeType === 'removed')).toBe(true);

    expect(drifts).toHaveLength(1);
    expect(drifts[0].driftCount).toBe(reports[0].driftCount);
  });

  it('records no drift when the snapshot is unchanged', async () => {
    await service.scanCluster();
    await service.scanCluster();

    expect(await DriftReportModel.countDocuments({})).toBe(0);
  });

  it('enforces snapshot immutability', async () => {
    await service.scanCluster();
    const snap = await SnapshotModel.findOne({});
    await expect(
      SnapshotModel.updateOne({ _id: snap!._id }, { $set: { resourceCount: 999 } })
    ).rejects.toThrow(/immutable/i);
  });
});
