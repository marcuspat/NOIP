// DashboardService — covers the CRUD + share + widget-data paths
// using in-memory repos and a stub event bus.

import { DashboardService } from '../../../src/contexts/dashboard/application/dashboard.service';
import { InMemoryDashboardRepository } from '../../../src/contexts/dashboard/infrastructure/persistence/dashboard.repository';
import {
  FixedClock,
  type DomainEvent,
  type EventBus,
  type UserId,
} from '../../../src/shared/kernel';
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../../../src/shared/errors';

const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));

function makeBus(): { bus: EventBus; published: DomainEvent<unknown>[] } {
  const published: DomainEvent<unknown>[] = [];
  const bus: EventBus = {
    publish: e => published.push(e),
    publishMany: events => events.forEach(e => published.push(e)),
    subscribe: () => () => undefined,
  };
  return { bus, published };
}

function makeService() {
  const repository = new InMemoryDashboardRepository();
  const { bus, published } = makeBus();
  const service = new DashboardService({
    repository,
    bus,
    clock,
    suppliers: {
      security: {
        async getScore() {
          return {
            score: 90,
            counts: { total: 1, critical: 0, high: 0, medium: 0, low: 1 },
          };
        },
        async listFindings() {
          return [];
        },
      },
    },
  });
  return { service, repository, published };
}

describe('DashboardService — CRUD', () => {
  it('createDashboard persists and publishes dashboard.created', async () => {
    const { service, published } = makeService();
    const d = await service.createDashboard({
      name: 'My',
      layout: 'grid',
      ownedBy: { userId: 'u1' as UserId },
    });
    expect(d.id).toBeDefined();
    expect(published.map(e => e.type)).toEqual(['dashboard.created']);
  });

  it('listDashboards filters by access', async () => {
    const { service } = makeService();
    const owner = { userId: 'u1' as UserId };
    const other = { userId: 'u2' as UserId };
    await service.createDashboard({
      name: 'A',
      layout: 'grid',
      ownedBy: owner,
    });
    const org = await service.createDashboard({
      name: 'B',
      layout: 'grid',
      ownedBy: owner,
      share: { visibility: 'organisation' },
    });
    const visible = await service.listDashboards(other);
    expect(visible.map(d => d.id)).toEqual([org.id]);
  });

  it('listDashboards requires authentication', async () => {
    const { service } = makeService();
    await expect(service.listDashboards(null)).rejects.toThrow(
      UnauthorizedError
    );
  });

  it('getDashboard returns 404 on miss', async () => {
    const { service } = makeService();
    await expect(
      service.getDashboard('00000000-0000-7000-8000-000000000123' as never, {
        userId: 'u' as UserId,
      })
    ).rejects.toThrow(NotFoundError);
  });

  it('getDashboard enforces access policy', async () => {
    const { service } = makeService();
    const d = await service.createDashboard({
      name: 'A',
      layout: 'grid',
      ownedBy: { userId: 'u1' as UserId },
    });
    await expect(
      service.getDashboard(d.id, { userId: 'u2' as UserId })
    ).rejects.toThrow(ForbiddenError);
  });

  it('updateDashboard restricted to the owner', async () => {
    const { service } = makeService();
    const d = await service.createDashboard({
      name: 'A',
      layout: 'grid',
      ownedBy: { userId: 'u1' as UserId },
    });
    await expect(
      service.updateDashboard(d.id, { name: 'B' }, { userId: 'u2' as UserId })
    ).rejects.toThrow(ForbiddenError);
    const updated = await service.updateDashboard(
      d.id,
      { name: 'B' },
      { userId: 'u1' as UserId }
    );
    expect(updated.name).toBe('B');
  });

  it('deleteDashboard removes the row and emits the event', async () => {
    const { service, published, repository } = makeService();
    const d = await service.createDashboard({
      name: 'A',
      layout: 'grid',
      ownedBy: { userId: 'u1' as UserId },
    });
    published.length = 0;
    await service.deleteDashboard(d.id, { userId: 'u1' as UserId });
    expect(published.map(e => e.type)).toEqual(['dashboard.deleted']);
    expect(await repository.findById(d.id)).toBeNull();
  });

  it('share replaces the policy and emits dashboard.shared', async () => {
    const { service, published } = makeService();
    const d = await service.createDashboard({
      name: 'A',
      layout: 'grid',
      ownedBy: { userId: 'u1' as UserId },
    });
    published.length = 0;
    const out = await service.share(
      d.id,
      { visibility: 'role-scoped', roles: ['viewer'] },
      { userId: 'u1' as UserId }
    );
    expect(out.share.visibility).toBe('role-scoped');
    expect(published.map(e => e.type)).toEqual(['dashboard.shared']);
  });
});

describe('DashboardService — widget data', () => {
  it('getWidgetData resolves via the supplier', async () => {
    const { service } = makeService();
    const d = await service.createDashboard({
      name: 'A',
      layout: 'grid',
      ownedBy: { userId: 'u1' as UserId },
      widgets: [
        {
          type: 'metric',
          title: 'sec',
          datasource: {
            contextRef: 'security',
            query: 'score',
            parameters: { clusterId: 'c1' },
          },
          position: { x: 0, y: 0, w: 2, h: 2 },
        },
      ],
    });
    const widget = d.widgets[0]!;
    const data = await service.getWidgetData({
      dashboardId: d.id,
      widgetId: widget.id,
      principal: { userId: 'u1' as UserId },
    });
    expect(data.widgetType).toBe('metric');
    expect((data.payload as { score: number }).score).toBe(90);
  });

  it('getWidgetData enforces the dashboard access policy', async () => {
    const { service } = makeService();
    const d = await service.createDashboard({
      name: 'A',
      layout: 'grid',
      ownedBy: { userId: 'u1' as UserId },
      widgets: [
        {
          type: 'metric',
          title: 'sec',
          datasource: {
            contextRef: 'security',
            query: 'score',
            parameters: { clusterId: 'c1' },
          },
          position: { x: 0, y: 0, w: 2, h: 2 },
        },
      ],
    });
    await expect(
      service.getWidgetData({
        dashboardId: d.id,
        widgetId: d.widgets[0]!.id,
        principal: { userId: 'u2' as UserId },
      })
    ).rejects.toThrow(ForbiddenError);
  });

  it('getAllWidgetData reuses cached datasources per render cycle', async () => {
    let calls = 0;
    const repository = new InMemoryDashboardRepository();
    const { bus } = makeBus();
    const service = new DashboardService({
      repository,
      bus,
      clock,
      suppliers: {
        security: {
          async getScore() {
            calls += 1;
            return {
              score: 50,
              counts: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
            };
          },
          async listFindings() {
            return [];
          },
        },
      },
    });
    const d = await service.createDashboard({
      name: 'A',
      layout: 'flex',
      ownedBy: { userId: 'u1' as UserId },
      widgets: Array.from({ length: 5 }, (_, i) => ({
        type: 'metric' as const,
        title: `w${i}`,
        datasource: {
          contextRef: 'security' as const,
          query: 'score',
          parameters: { clusterId: 'c1' },
        },
        position: { x: 0, y: 0, w: 1, h: 1 },
      })),
    });
    const out = await service.getAllWidgetData(d.id, {
      userId: 'u1' as UserId,
    });
    expect(out.size).toBe(5);
    expect(calls).toBe(1);
  });
});
