import {
  InMemoryEventBus,
  compose,
  type DomainEvent,
  type EventBusLogger,
} from '../../../src/shared/kernel/events';
import { FixedClock } from '../../../src/shared/kernel/time';
import type { ClusterId } from '../../../src/shared/kernel/ids';

interface SessionCreated {
  sessionId: string;
}

function makeEvent<T>(type: string, payload: T): DomainEvent<T> {
  return compose<T>(
    {
      type,
      context: 'iam',
      aggregateType: 'Session',
      aggregateId: '00000000-0000-4000-8000-000000000001',
      payload,
    },
    new FixedClock('2026-05-10T00:00:00.000Z')
  );
}

describe('shared/kernel/events', () => {
  describe('compose', () => {
    it('fills id, occurredAt, and schemaVersion defaults', () => {
      const clock = new FixedClock('2026-05-10T12:00:00.000Z');
      const e = compose<{ x: number }>(
        {
          type: 'iam.session.created',
          context: 'iam',
          aggregateType: 'Session',
          aggregateId: 'agg-1',
          payload: { x: 1 },
        },
        clock
      );
      expect(e.id).toMatch(/[0-9a-f-]{36}/);
      expect(e.occurredAt).toBe('2026-05-10T12:00:00.000Z');
      expect(e.schemaVersion).toBe(1);
      expect(e.payload).toEqual({ x: 1 });
    });

    it('preserves caller-supplied optional fields', () => {
      const clock = new FixedClock('2026-05-10T00:00:00.000Z');
      const e = compose<{ x: number }>(
        {
          type: 'iam.session.created',
          context: 'iam',
          aggregateType: 'Session',
          aggregateId: 'agg-1',
          payload: { x: 1 },
          actor: { type: 'user', id: 'u-1' },
          correlationId: 'corr-1',
          causationId: 'cause-1',
        },
        clock
      );
      expect(e.actor).toEqual({ type: 'user', id: 'u-1' });
      expect(e.correlationId).toBe('corr-1');
      expect(e.causationId).toBe('cause-1');
    });
  });

  describe('subscribe / publish', () => {
    it('delivers to handlers subscribed by exact type', () => {
      const bus = new InMemoryEventBus();
      const seen: DomainEvent<SessionCreated>[] = [];
      bus.subscribe<SessionCreated>('iam.session.created', e => {
        seen.push(e);
      });

      const evt = makeEvent<SessionCreated>('iam.session.created', {
        sessionId: 's1',
      });
      bus.publish(evt);

      expect(seen).toHaveLength(1);
      expect(seen[0]?.payload.sessionId).toBe('s1');
    });

    it('does not deliver events that do not match', () => {
      const bus = new InMemoryEventBus();
      const seen: string[] = [];
      bus.subscribe('iam.session.created', e => {
        seen.push(e.type);
      });
      bus.publish(makeEvent('iam.session.revoked', {}));
      expect(seen).toEqual([]);
    });

    it('matches trailing-* prefix patterns', () => {
      const bus = new InMemoryEventBus();
      const seen: string[] = [];
      bus.subscribe('iam.*', e => {
        seen.push(e.type);
      });

      bus.publish(makeEvent('iam.session.created', {}));
      bus.publish(makeEvent('iam.session.revoked', {}));
      bus.publish(makeEvent('discovery.cluster.scanned', {}));

      expect(seen).toEqual(['iam.session.created', 'iam.session.revoked']);
    });

    it('matches deeper prefix patterns like iam.session.*', () => {
      const bus = new InMemoryEventBus();
      const seen: string[] = [];
      bus.subscribe('iam.session.*', e => {
        seen.push(e.type);
      });

      bus.publish(makeEvent('iam.session.created', {}));
      bus.publish(makeEvent('iam.role.assigned', {}));

      expect(seen).toEqual(['iam.session.created']);
    });

    it('delivers a single event to multiple matching subscribers', () => {
      const bus = new InMemoryEventBus();
      const a: string[] = [];
      const b: string[] = [];
      bus.subscribe('iam.session.created', () => {
        a.push('a');
      });
      bus.subscribe('iam.*', () => {
        b.push('b');
      });
      bus.publish(makeEvent('iam.session.created', {}));
      expect(a).toEqual(['a']);
      expect(b).toEqual(['b']);
    });
  });

  describe('publishMany', () => {
    it('publishes each event in order', () => {
      const bus = new InMemoryEventBus();
      const seen: string[] = [];
      bus.subscribe('iam.*', e => {
        seen.push(e.type);
      });
      bus.publishMany([
        makeEvent('iam.session.created', {}),
        makeEvent('iam.session.revoked', {}),
        makeEvent('iam.role.assigned', {}),
      ]);
      expect(seen).toEqual([
        'iam.session.created',
        'iam.session.revoked',
        'iam.role.assigned',
      ]);
    });
  });

  describe('handler errors', () => {
    it('a throwing handler does not stop later handlers and is logged', () => {
      const errors: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
      const logger: EventBusLogger = {
        warn: () => undefined,
        error: (msg, meta) => {
          errors.push({ msg, ...(meta !== undefined ? { meta } : {}) });
        },
      };
      const bus = new InMemoryEventBus(logger);
      const reached: string[] = [];

      bus.subscribe('iam.session.created', () => {
        throw new Error('boom');
      });
      bus.subscribe('iam.session.created', () => {
        reached.push('second');
      });

      bus.publish(makeEvent('iam.session.created', {}));

      expect(reached).toEqual(['second']);
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors[0]?.msg).toMatch(/event handler threw/);
    });

    it('a rejecting async handler is logged and does not throw', async () => {
      const errors: string[] = [];
      const logger: EventBusLogger = {
        warn: () => undefined,
        error: msg => errors.push(msg),
      };
      const bus = new InMemoryEventBus(logger);
      const reached: string[] = [];

      bus.subscribe('iam.session.created', async () => {
        await Promise.resolve();
        throw new Error('async boom');
      });
      bus.subscribe('iam.session.created', () => {
        reached.push('second');
      });

      bus.publish(makeEvent('iam.session.created', {}));
      // Allow microtasks to drain so the rejection is observed.
      await new Promise(r => setImmediate(r));

      expect(reached).toEqual(['second']);
      expect(errors.some(m => m.includes('rejected'))).toBe(true);
    });
  });

  describe('unsubscribe', () => {
    it('stops delivering to a handler after unsubscribe', () => {
      const bus = new InMemoryEventBus();
      const seen: number[] = [];
      const off = bus.subscribe('iam.*', () => {
        seen.push(1);
      });

      bus.publish(makeEvent('iam.session.created', {}));
      off();
      bus.publish(makeEvent('iam.session.created', {}));

      expect(seen).toEqual([1]);
    });

    it('is idempotent', () => {
      const bus = new InMemoryEventBus();
      const off = bus.subscribe('iam.*', () => undefined);
      off();
      expect(() => off()).not.toThrow();
    });
  });

  describe('payload typing smoke', () => {
    // Confirms generic payload typing flows through publish/subscribe.
    it('preserves payload generic across the bus', () => {
      const bus = new InMemoryEventBus();
      const seenIds: ClusterId[] = [];
      bus.subscribe<{ clusterId: ClusterId }>(
        'discovery.cluster.scanned',
        e => {
          seenIds.push(e.payload.clusterId);
        }
      );
      bus.publish<{ clusterId: ClusterId }>(
        makeEvent('discovery.cluster.scanned', {
          clusterId: 'c1' as ClusterId,
        })
      );
      expect(seenIds).toEqual(['c1']);
    });
  });
});
