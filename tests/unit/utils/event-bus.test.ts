import {
  createEventBus,
  EventBus,
  EventEnvelope,
} from '../../../src/utils/event-bus';

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = createEventBus();
  });

  describe('publish with no subscribers', () => {
    it('does not throw and increments published metric', async () => {
      await expect(
        bus.publish('iam.UserRegistered', { userId: 'u1' })
      ).resolves.toBeDefined();

      const m = bus.metrics();
      expect(m.published).toBe(1);
      expect(m.delivered).toBe(0);
      expect(m.handlerErrors).toBe(0);
      expect(m.deadLettered).toBe(0);
    });
  });

  describe('exact-match subscription', () => {
    it('receives the event with original payload, eventId, occurredAt, and correlationId', async () => {
      const received: Array<EventEnvelope<{ userId: string }>> = [];
      bus.subscribe<{ userId: string }>('iam.UserRegistered', (event) => {
        received.push(event);
      });

      const envelope = await bus.publish(
        'iam.UserRegistered',
        { userId: 'user-42' },
        { correlationId: 'corr-123' }
      );

      expect(received).toHaveLength(1);
      const got = received[0]!;
      expect(got.name).toBe('iam.UserRegistered');
      expect(got.payload).toEqual({ userId: 'user-42' });
      expect(got.eventId).toBe(envelope.eventId);
      expect(got.occurredAt).toBe(envelope.occurredAt);
      expect(got.occurredAt).toBeInstanceOf(Date);
      expect(got.correlationId).toBe('corr-123');
      expect(typeof got.eventId).toBe('string');
      expect(got.eventId.length).toBeGreaterThan(0);
    });

    it('does not fire for events of a different name', async () => {
      const handler = jest.fn();
      bus.subscribe('iam.UserRegistered', handler);

      await bus.publish('iam.UserDeleted', { userId: 'x' });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('wildcard subscription', () => {
    it('receives matching events but not non-matching ones', async () => {
      const received: string[] = [];
      bus.subscribe('iam.*', (event) => {
        received.push(event.name);
      });

      await bus.publish('iam.UserRegistered', { userId: 'a' });
      await bus.publish('iam.UserDeleted', { userId: 'b' });
      await bus.publish('discovery.SnapshotCompleted', { snapshotId: 's' });
      await bus.publish('secops.FindingRaised', { findingId: 'f' });

      expect(received).toEqual(['iam.UserRegistered', 'iam.UserDeleted']);
    });
  });

  describe('multiple subscribers', () => {
    it('all subscribers for the same pattern receive the event', async () => {
      const a = jest.fn();
      const b = jest.fn();
      const c = jest.fn();

      bus.subscribe('discovery.SnapshotCompleted', a);
      bus.subscribe('discovery.SnapshotCompleted', b);
      bus.subscribe('discovery.*', c);

      await bus.publish('discovery.SnapshotCompleted', { snapshotId: 's-1' });

      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
      expect(c).toHaveBeenCalledTimes(1);
      expect(bus.metrics().delivered).toBe(3);
    });
  });

  describe('unsubscribe', () => {
    it('returned function detaches the handler from exact subscriptions', async () => {
      const handler = jest.fn();
      const off = bus.subscribe('iam.UserRegistered', handler);

      await bus.publish('iam.UserRegistered', { userId: 'a' });
      off();
      await bus.publish('iam.UserRegistered', { userId: 'b' });

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('returned function detaches the handler from wildcard subscriptions', async () => {
      const handler = jest.fn();
      const off = bus.subscribe('iam.*', handler);

      await bus.publish('iam.UserRegistered', { userId: 'a' });
      off();
      await bus.publish('iam.UserDeleted', { userId: 'b' });

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('subscribeOnce', () => {
    it('fires exactly once even with several matching publishes', async () => {
      const handler = jest.fn();
      bus.subscribeOnce('secops.FindingRaised', handler);

      await bus.publish('secops.FindingRaised', { findingId: 'f1' });
      await bus.publish('secops.FindingRaised', { findingId: 'f2' });
      await bus.publish('secops.FindingRaised', { findingId: 'f3' });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]![0].payload).toEqual({ findingId: 'f1' });
    });

    it('also works with a wildcard pattern', async () => {
      const handler = jest.fn();
      bus.subscribeOnce('secops.*', handler);

      await bus.publish('secops.FindingRaised', { id: 1 });
      await bus.publish('secops.FindingResolved', { id: 2 });

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('error isolation', () => {
    it('a throwing handler does not block other handlers and bumps error counters', async () => {
      const good1 = jest.fn();
      const good2 = jest.fn();
      const bad = jest.fn(() => {
        throw new Error('boom');
      });

      bus.subscribe('iam.UserRegistered', good1);
      bus.subscribe('iam.UserRegistered', bad);
      bus.subscribe('iam.UserRegistered', good2);

      await expect(
        bus.publish('iam.UserRegistered', { userId: 'u' })
      ).resolves.toBeDefined();

      expect(good1).toHaveBeenCalledTimes(1);
      expect(good2).toHaveBeenCalledTimes(1);
      expect(bad).toHaveBeenCalledTimes(1);

      const m = bus.metrics();
      expect(m.published).toBe(1);
      expect(m.delivered).toBe(2);
      expect(m.handlerErrors).toBe(1);
      expect(m.deadLettered).toBe(1);
    });

    it('handles async handlers that reject', async () => {
      const good = jest.fn();
      const bad = jest.fn(async () => {
        throw new Error('async boom');
      });

      bus.subscribe('iam.UserRegistered', bad);
      bus.subscribe('iam.UserRegistered', good);

      await bus.publish('iam.UserRegistered', { userId: 'u' });

      expect(good).toHaveBeenCalledTimes(1);
      const m = bus.metrics();
      expect(m.handlerErrors).toBe(1);
      expect(m.deadLettered).toBe(1);
      expect(m.delivered).toBe(1);
    });
  });

  describe('metrics shape', () => {
    it('returns the documented counters', () => {
      const m = bus.metrics();
      expect(m).toEqual({
        published: 0,
        delivered: 0,
        handlerErrors: 0,
        deadLettered: 0,
      });
      expect(Object.keys(m).sort()).toEqual(
        ['deadLettered', 'delivered', 'handlerErrors', 'published'].sort()
      );
    });

    it('returns a snapshot, not a live reference', async () => {
      const before = bus.metrics();
      await bus.publish('x.y', {});
      const after = bus.metrics();
      expect(before.published).toBe(0);
      expect(after.published).toBe(1);
    });
  });

  describe('unsubscribeAll', () => {
    it('clears every subscription', async () => {
      const a = jest.fn();
      const b = jest.fn();
      bus.subscribe('iam.UserRegistered', a);
      bus.subscribe('iam.*', b);

      bus.unsubscribeAll();

      await bus.publish('iam.UserRegistered', { userId: 'x' });
      expect(a).not.toHaveBeenCalled();
      expect(b).not.toHaveBeenCalled();
    });
  });
});
