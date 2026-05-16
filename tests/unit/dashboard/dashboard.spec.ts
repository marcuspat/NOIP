// Dashboard aggregate unit tests.

import { Dashboard } from '../../../src/contexts/dashboard/domain/dashboard';
import { FixedClock, type UserId } from '../../../src/shared/kernel';
import { ValidationError } from '../../../src/shared/errors';

const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));

function makeCreateSpec(
  overrides: Partial<Parameters<typeof Dashboard.create>[0]> = {}
) {
  return {
    name: 'My Dashboard',
    layout: 'grid' as const,
    refreshIntervalSec: 60,
    ownedBy: { userId: 'owner-1' as UserId },
    ...overrides,
  };
}

describe('Dashboard aggregate — create', () => {
  it('rejects a blank name', () => {
    expect(() => Dashboard.create(makeCreateSpec({ name: '' }), clock)).toThrow(
      ValidationError
    );
  });

  it('rejects an unsupported layout', () => {
    expect(() =>
      Dashboard.create(makeCreateSpec({ layout: 'masonry' as never }), clock)
    ).toThrow(ValidationError);
  });

  it('rejects refreshIntervalSec below 30', () => {
    expect(() =>
      Dashboard.create(makeCreateSpec({ refreshIntervalSec: 5 }), clock)
    ).toThrow(/refreshIntervalSec/);
  });

  it('rejects role-scoped share without roles', () => {
    expect(() =>
      Dashboard.create(
        makeCreateSpec({ share: { visibility: 'role-scoped' } }),
        clock
      )
    ).toThrow(/roles list/);
  });

  it('rejects roles on a private share', () => {
    expect(() =>
      Dashboard.create(
        makeCreateSpec({
          share: { visibility: 'private', roles: ['admin'] },
        }),
        clock
      )
    ).toThrow(/can only be supplied/);
  });

  it('emits dashboard.created exactly once', () => {
    const d = Dashboard.create(makeCreateSpec(), clock);
    const events = d.drainEvents();
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('dashboard.created');
    expect(ev.aggregateType).toBe('dashboard');
    expect(ev.aggregateId).toBe(d.id);
    expect(ev.payload).toMatchObject({
      dashboardId: d.id,
      ownedBy: { userId: 'owner-1' },
    });
    expect(d.drainEvents()).toHaveLength(0);
  });

  it('rejects overlapping widgets on a grid layout', () => {
    expect(() =>
      Dashboard.create(
        makeCreateSpec({
          widgets: [
            {
              type: 'metric',
              title: 'A',
              datasource: { contextRef: 'security', query: 'score' },
              position: { x: 0, y: 0, w: 2, h: 2 },
            },
            {
              type: 'metric',
              title: 'B',
              datasource: { contextRef: 'security', query: 'score' },
              position: { x: 1, y: 1, w: 2, h: 2 },
            },
          ],
        }),
        clock
      )
    ).toThrow(/overlap/);
  });

  it('allows overlapping widgets on a flex layout', () => {
    expect(() =>
      Dashboard.create(
        makeCreateSpec({
          layout: 'flex',
          widgets: [
            {
              type: 'metric',
              title: 'A',
              datasource: { contextRef: 'security', query: 'score' },
              position: { x: 0, y: 0, w: 2, h: 2 },
            },
            {
              type: 'metric',
              title: 'B',
              datasource: { contextRef: 'security', query: 'score' },
              position: { x: 1, y: 1, w: 2, h: 2 },
            },
          ],
        }),
        clock
      )
    ).not.toThrow();
  });
});

describe('Dashboard aggregate — update / share / delete', () => {
  it('update emits dashboard.updated and bumps updatedAt', () => {
    const c2 = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
    const d = Dashboard.create(
      makeCreateSpec({
        ownedBy: { userId: 'owner-1' as UserId },
      }),
      c2
    );
    d.drainEvents();
    c2.advance(60_000);
    d.update({ name: 'Renamed' }, c2);
    expect(d.name).toBe('Renamed');
    expect(d.updatedAt).toBe('2026-05-10T00:01:00.000Z');
    const ev = d.drainEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.type).toBe('dashboard.updated');
    expect(
      (ev[0]!.payload as { changes: Record<string, unknown> }).changes
    ).toMatchObject({
      name: 'Renamed',
    });
  });

  it('update is a no-op when nothing changes', () => {
    const d = Dashboard.create(makeCreateSpec({ description: 'x' }), clock);
    d.drainEvents();
    d.update({ name: 'My Dashboard', description: 'x' }, clock);
    expect(d.drainEvents()).toHaveLength(0);
  });

  it('update re-checks overlap when widgets are swapped', () => {
    const d = Dashboard.create(makeCreateSpec({ layout: 'grid' }), clock);
    expect(() =>
      d.update(
        {
          widgets: [
            {
              type: 'metric',
              title: 'A',
              datasource: { contextRef: 'security', query: 'score' },
              position: { x: 0, y: 0, w: 2, h: 2 },
            },
            {
              type: 'metric',
              title: 'B',
              datasource: { contextRef: 'security', query: 'score' },
              position: { x: 1, y: 1, w: 2, h: 2 },
            },
          ],
        },
        clock
      )
    ).toThrow(/overlap/);
  });

  it('shareWith emits dashboard.shared with role list', () => {
    const d = Dashboard.create(makeCreateSpec(), clock);
    d.drainEvents();
    d.shareWith({ visibility: 'role-scoped', roles: ['viewer'] }, clock);
    const ev = d.drainEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.type).toBe('dashboard.shared');
    expect(d.share.visibility).toBe('role-scoped');
    expect(d.share.roles).toEqual(['viewer']);
  });

  it('shareWith rejects an invalid policy', () => {
    const d = Dashboard.create(makeCreateSpec(), clock);
    expect(() => d.shareWith({ visibility: 'role-scoped' }, clock)).toThrow(
      /roles list/
    );
  });

  it('markDeleted emits dashboard.deleted exactly once', () => {
    const d = Dashboard.create(makeCreateSpec(), clock);
    d.drainEvents();
    d.markDeleted(clock);
    d.markDeleted(clock); // idempotent
    const ev = d.drainEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.type).toBe('dashboard.deleted');
    expect(d.deleted).toBe(true);
  });

  it('round-trips via toPersistence / fromPersistence', () => {
    const original = Dashboard.create(
      makeCreateSpec({
        description: 'desc',
        share: { visibility: 'organisation' },
        widgets: [
          {
            type: 'chart',
            title: 'Trend',
            datasource: { contextRef: 'security', query: 'findings' },
            position: { x: 0, y: 0, w: 6, h: 4 },
          },
        ],
      }),
      clock
    );
    original.drainEvents();
    const reloaded = Dashboard.fromPersistence(original.toPersistence());
    expect(reloaded.id).toBe(original.id);
    expect(reloaded.name).toBe(original.name);
    expect(reloaded.description).toBe('desc');
    expect(reloaded.widgets).toHaveLength(1);
    expect(reloaded.share.visibility).toBe('organisation');
    expect(reloaded.peekEvents()).toHaveLength(0);
  });
});
