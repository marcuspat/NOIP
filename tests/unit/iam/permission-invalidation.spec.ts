// Unit tests for `installPermissionInvalidation`.
//
// Coverage:
//   - each subscribed event triggers the right resolver method
//   - unsubscribe handles stop further invocations
//   - missing payload identifiers are logged and ignored

import { InMemoryEventBus, asInstant } from '../../../src/shared/kernel';
import type { DomainEvent, EventId } from '../../../src/shared/kernel';
import {
  installPermissionInvalidation,
  disposeAll,
} from '../../../src/services/iam/permission-invalidation';
import type { PermissionResolver } from '../../../src/services/iam/permission-resolver.service';
import { CapturingLogger } from './_iam-stubs';

interface Recorder {
  user: string[];
  role: string[];
  all: number;
}

function makeFakeResolver(): { resolver: PermissionResolver; calls: Recorder } {
  const calls: Recorder = { user: [], role: [], all: 0 };
  const resolver = {
    async resolveEffective() {
      throw new Error('not used in invalidation tests');
    },
    check() {
      throw new Error('not used in invalidation tests');
    },
    async invalidateUser(userId: string) {
      calls.user.push(userId);
    },
    async invalidateRole(roleId: string) {
      calls.role.push(roleId);
    },
    async invalidateAll() {
      calls.all += 1;
    },
  } as unknown as PermissionResolver;
  return { resolver, calls };
}

function makeEvent(
  type: string,
  payload: Record<string, unknown>,
  aggregate: { type: string; id: string }
): DomainEvent<Record<string, unknown>> {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 10)}` as EventId,
    type,
    occurredAt: asInstant('2026-05-10T00:00:00.000Z'),
    context: 'iam',
    aggregateType: aggregate.type,
    aggregateId: aggregate.id,
    payload,
    schemaVersion: 1,
  };
}

/** Wait for the bus's microtask-deferred async handlers to settle. */
async function flush(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

describe('installPermissionInvalidation', () => {
  it('invalidates the user on iam.permission.escalated', async () => {
    const bus = new InMemoryEventBus();
    const logger = new CapturingLogger();
    const { resolver, calls } = makeFakeResolver();
    installPermissionInvalidation(bus, resolver, logger);

    bus.publish(
      makeEvent(
        'iam.permission.escalated',
        { userId: 'u-1', addedPermissions: ['p-1'] },
        { type: 'user', id: 'u-1' }
      )
    );
    await flush();
    expect(calls.user).toEqual(['u-1']);
  });

  it('invalidates the user on iam.permission.granted and revoked', async () => {
    const bus = new InMemoryEventBus();
    const logger = new CapturingLogger();
    const { resolver, calls } = makeFakeResolver();
    installPermissionInvalidation(bus, resolver, logger);

    bus.publish(
      makeEvent(
        'iam.permission.granted',
        { userId: 'u-2', permissionId: 'p-1' },
        { type: 'user', id: 'u-2' }
      )
    );
    bus.publish(
      makeEvent(
        'iam.permission.revoked',
        { userId: 'u-3', permissionId: 'p-1' },
        { type: 'user', id: 'u-3' }
      )
    );
    await flush();
    expect(calls.user.sort()).toEqual(['u-2', 'u-3']);
  });

  it('invalidates the user on iam.user.deactivated', async () => {
    const bus = new InMemoryEventBus();
    const logger = new CapturingLogger();
    const { resolver, calls } = makeFakeResolver();
    installPermissionInvalidation(bus, resolver, logger);

    bus.publish(
      makeEvent(
        'iam.user.deactivated',
        { userId: 'u-9', reason: 'admin-revoke' },
        { type: 'user', id: 'u-9' }
      )
    );
    await flush();
    expect(calls.user).toEqual(['u-9']);
  });

  it('invalidates the role on iam.role.updated and deleted', async () => {
    const bus = new InMemoryEventBus();
    const logger = new CapturingLogger();
    const { resolver, calls } = makeFakeResolver();
    installPermissionInvalidation(bus, resolver, logger);

    bus.publish(
      makeEvent(
        'iam.role.updated',
        { roleId: 'r-1', changes: { name: 'new' } },
        { type: 'role', id: 'r-1' }
      )
    );
    bus.publish(
      makeEvent(
        'iam.role.deleted',
        { roleId: 'r-2' },
        { type: 'role', id: 'r-2' }
      )
    );
    await flush();
    expect(calls.role.sort()).toEqual(['r-1', 'r-2']);
  });

  it('falls back to aggregateId when payload.userId is absent', async () => {
    const bus = new InMemoryEventBus();
    const logger = new CapturingLogger();
    const { resolver, calls } = makeFakeResolver();
    installPermissionInvalidation(bus, resolver, logger);

    bus.publish(
      makeEvent(
        'iam.permission.escalated',
        {},
        { type: 'user', id: 'u-fallback' }
      )
    );
    await flush();
    expect(calls.user).toEqual(['u-fallback']);
  });

  it('skips invalidation and warns when both userId and aggregateId are missing', async () => {
    const bus = new InMemoryEventBus();
    const logger = new CapturingLogger();
    const { resolver, calls } = makeFakeResolver();
    installPermissionInvalidation(bus, resolver, logger);

    bus.publish(
      makeEvent(
        'iam.permission.escalated',
        {},
        // Aggregate type is *not* `user`, so the fallback does not apply.
        { type: 'session', id: 's-1' }
      )
    );
    await flush();
    expect(calls.user).toEqual([]);
    expect(logger.events.some(e => e.level === 'warn')).toBe(true);
  });

  it('unsubscribe handles stop further invocations', async () => {
    const bus = new InMemoryEventBus();
    const logger = new CapturingLogger();
    const { resolver, calls } = makeFakeResolver();
    const handles = installPermissionInvalidation(bus, resolver, logger);

    disposeAll(handles);

    bus.publish(
      makeEvent(
        'iam.permission.escalated',
        { userId: 'u-after-dispose' },
        { type: 'user', id: 'u-after-dispose' }
      )
    );
    bus.publish(
      makeEvent(
        'iam.role.updated',
        { roleId: 'r-after-dispose' },
        { type: 'role', id: 'r-after-dispose' }
      )
    );
    await flush();

    expect(calls.user).toEqual([]);
    expect(calls.role).toEqual([]);
  });

  it('returns one handle per subscribed event type', () => {
    const bus = new InMemoryEventBus();
    const logger = new CapturingLogger();
    const { resolver } = makeFakeResolver();
    const handles = installPermissionInvalidation(bus, resolver, logger);

    // 4 per-user events + 2 role events = 6.
    expect(handles).toHaveLength(6);
  });
});
