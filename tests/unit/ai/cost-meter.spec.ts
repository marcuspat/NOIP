// CostMeter — cumulative tracking, TTL, budget breach raises RateLimitError.

import { CostMeter } from '../../../src/contexts/ai/domain/cost-meter';
import { createInMemoryCostRedis } from '../../../src/contexts/ai/api';
import {
  FixedClock,
  InMemoryEventBus,
  newId,
  type DomainEvent,
  type UserId,
} from '../../../src/shared/kernel';
import { RateLimitError } from '../../../src/shared/errors';

describe('CostMeter', () => {
  it('accumulates spend across charges', async () => {
    const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
    const bus = new InMemoryEventBus({
      warn: () => undefined,
      error: () => undefined,
    });
    const meter = new CostMeter({
      redis: createInMemoryCostRedis(),
      bus,
      clock,
      dailyBudgetUsd: 1.0,
    });
    const u = newId<UserId>();
    await meter.charge({ userId: u, amount: { amount: 0.1, currency: 'USD' } });
    await meter.charge({ userId: u, amount: { amount: 0.2, currency: 'USD' } });
    expect(await meter.getCurrentSpend(u)).toBeCloseTo(0.3, 4);
  });

  it('emits ai.cost.budget_breached and throws RateLimitError on breach', async () => {
    const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
    const bus = new InMemoryEventBus({
      warn: () => undefined,
      error: () => undefined,
    });
    const seen: DomainEvent<unknown>[] = [];
    bus.subscribe('ai.*', evt => {
      seen.push(evt);
    });
    const meter = new CostMeter({
      redis: createInMemoryCostRedis(),
      bus,
      clock,
      dailyBudgetUsd: 0.5,
    });
    const u = newId<UserId>();
    await meter.charge({ userId: u, amount: { amount: 0.4, currency: 'USD' } });
    await expect(
      meter.charge({ userId: u, amount: { amount: 0.2, currency: 'USD' } })
    ).rejects.toThrow(RateLimitError);
    expect(seen.some(e => e.type === 'ai.cost.budget_breached')).toBe(true);
  });

  it('round-trips through the in-memory redis stub', async () => {
    const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
    const redis = createInMemoryCostRedis();
    const bus = new InMemoryEventBus({
      warn: () => undefined,
      error: () => undefined,
    });
    const meter = new CostMeter({ redis, bus, clock, dailyBudgetUsd: 5 });
    await meter.charge({
      userId: null,
      amount: { amount: 0.05, currency: 'USD' },
    });
    const day = '2026-05-10';
    const raw = await redis.get(`ai:cost:anonymous:${day}`);
    expect(parseFloat(raw ?? '0')).toBeCloseTo(0.05, 4);
  });
});
