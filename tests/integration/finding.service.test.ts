import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { FindingService, FindingInput } from '../../src/services/finding.service';
import { FindingModel } from '../../src/models/finding.model';

const mkInput = (overrides: Partial<FindingInput> = {}): FindingInput => ({
  ruleId: 'RBAC-001',
  title: 'Wildcard role binding',
  description: 'ClusterRole grants *',
  category: 'security',
  severity: 'high',
  affectedResource: {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRole',
    name: 'too-permissive',
  },
  ...overrides,
});

describe('FindingService', () => {
  let mongoServer: MongoMemoryServer;
  let service: FindingService;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    service = new FindingService();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await FindingModel.deleteMany({});
  });

  it('creates new findings on first observation', async () => {
    const res = await service.recordFindings('c1', 'snap1', [mkInput()]);
    expect(res.created).toBe(1);
    expect(res.updated).toBe(0);
    expect(await FindingModel.countDocuments({})).toBe(1);
  });

  it('deduplicates the same finding across scans (no duplicate row)', async () => {
    await service.recordFindings('c1', 'snap1', [mkInput()]);
    const res = await service.recordFindings('c1', 'snap2', [mkInput()]);
    expect(res.created).toBe(0);
    expect(res.updated).toBe(1);
    expect(await FindingModel.countDocuments({})).toBe(1);

    const f = await FindingModel.findOne({});
    expect(f!.snapshotId).toBe('snap2'); // lastSeen advanced
  });

  it('scopes dedup per cluster (same issue in two clusters = two rows)', async () => {
    await service.recordFindings('c1', 'snap1', [mkInput()]);
    await service.recordFindings('c2', 'snap1', [mkInput()]);
    expect(await FindingModel.countDocuments({})).toBe(2);
  });

  it('auto-resolves findings no longer observed', async () => {
    await service.recordFindings('c1', 'snap1', [
      mkInput(),
      mkInput({
        ruleId: 'NET-001',
        affectedResource: {
          apiVersion: 'v1',
          kind: 'Service',
          name: 'open-svc',
        },
      }),
    ]);
    expect(await FindingModel.countDocuments({ status: 'open' })).toBe(2);

    // Next scan only sees the first finding.
    const res = await service.recordFindings('c1', 'snap2', [mkInput()]);
    expect(res.resolved).toBe(1);
    expect(await FindingModel.countDocuments({ status: 'open' })).toBe(1);
    expect(await FindingModel.countDocuments({ status: 'resolved' })).toBe(1);
  });

  it('re-opens a resolved finding when it recurs', async () => {
    await service.recordFindings('c1', 'snap1', [mkInput()]);
    await service.recordFindings('c1', 'snap2', []); // resolves it
    expect(await FindingModel.countDocuments({ status: 'resolved' })).toBe(1);

    await service.recordFindings('c1', 'snap3', [mkInput()]); // recurs
    const f = await FindingModel.findOne({});
    expect(f!.status).toBe('open');
    expect(f!.resolvedAt).toBeFalsy();
  });

  it('resolves all open findings when a scan returns nothing', async () => {
    await service.recordFindings('c1', 'snap1', [mkInput()]);
    const res = await service.recordFindings('c1', 'snap2', []);
    expect(res.resolved).toBe(1);
    expect(await FindingModel.countDocuments({ status: 'open' })).toBe(0);
  });

  it('getOpenFindings returns only open findings for the cluster', async () => {
    await service.recordFindings('c1', 'snap1', [mkInput()]);
    await service.recordFindings('c2', 'snap1', [mkInput()]);
    const open = await service.getOpenFindings('c1');
    expect(open).toHaveLength(1);
    expect(open[0].clusterId).toBe('c1');
  });
});
