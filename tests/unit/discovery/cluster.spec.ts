// Unit tests for the Cluster aggregate.

import { Cluster } from '../../../src/contexts/discovery/domain/cluster';
import { FixedClock } from '../../../src/shared/kernel';
import { ValidationError } from '../../../src/shared/errors';

describe('Cluster aggregate', () => {
  const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));

  it('register() validates required fields', () => {
    expect(() =>
      Cluster.register(
        {
          name: '',
          endpoint: 'https://api.example.com',
          credentials: { ref: 'vault://x' },
        },
        clock
      )
    ).toThrow(ValidationError);
    expect(() =>
      Cluster.register(
        {
          name: 'prod',
          endpoint: 'not-a-url',
          credentials: { ref: 'vault://x' },
        },
        clock
      )
    ).toThrow(ValidationError);
    expect(() =>
      Cluster.register(
        // @ts-expect-error: deliberate missing credentials
        { name: 'prod', endpoint: 'https://api.example.com' },
        clock
      )
    ).toThrow(ValidationError);
  });

  it('register() emits discovery.cluster.registered exactly once', () => {
    const c = Cluster.register(
      {
        name: 'prod-east',
        endpoint: 'https://api.prod-east.example.com',
        credentials: { ref: 'vault://k/prod-east' },
      },
      clock
    );
    const events = c.drainEvents();
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.type).toBe('discovery.cluster.registered');
    expect(evt.context).toBe('discovery');
    expect(evt.aggregateType).toBe('cluster');
    expect(evt.aggregateId).toBe(c.id);
    expect(evt.payload).toMatchObject({
      clusterId: c.id,
      endpoint: 'https://api.prod-east.example.com',
      name: 'prod-east',
    });
    // drain leaves the buffer empty.
    expect(c.drainEvents()).toHaveLength(0);
  });

  it('enable/disable flips the state', () => {
    const c = Cluster.register(
      {
        name: 'p',
        endpoint: 'https://api.example.com',
        credentials: { ref: 'vault://r' },
      },
      clock
    );
    expect(c.enabled).toBe(true);
    c.disable();
    expect(c.enabled).toBe(false);
    c.enable();
    expect(c.enabled).toBe(true);
  });

  it('markScanned refuses on a disabled cluster', () => {
    const c = Cluster.register(
      {
        name: 'p',
        endpoint: 'https://api.example.com',
        credentials: { ref: 'vault://r' },
      },
      clock
    );
    c.disable();
    expect(() => c.markScanned(clock.nowInstant())).toThrow(ValidationError);
  });

  it('markScanned bumps lastScanAt monotonically', () => {
    const c = Cluster.register(
      {
        name: 'p',
        endpoint: 'https://api.example.com',
        credentials: { ref: 'vault://r' },
      },
      clock
    );
    c.markScanned('2026-05-10T01:00:00.000Z' as never);
    c.markScanned('2026-05-10T02:00:00.000Z' as never);
    expect(c.lastScanAt).toBe('2026-05-10T02:00:00.000Z');
    // Earlier timestamp is rejected silently.
    c.markScanned('2026-05-09T01:00:00.000Z' as never);
    expect(c.lastScanAt).toBe('2026-05-10T02:00:00.000Z');
  });

  it('toPersistence/fromPersistence round-trips', () => {
    const original = Cluster.register(
      {
        name: 'p',
        endpoint: 'https://api.example.com',
        credentials: { ref: 'vault://r' },
      },
      clock
    );
    original.drainEvents();
    const reloaded = Cluster.fromPersistence(original.toPersistence());
    expect(reloaded.id).toBe(original.id);
    expect(reloaded.endpoint).toBe(original.endpoint);
    expect(reloaded.enabled).toBe(true);
    // No replay of events on rehydrate.
    expect(reloaded.peekEvents()).toHaveLength(0);
  });
});
