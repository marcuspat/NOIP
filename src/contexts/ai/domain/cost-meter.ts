// CostMeter — tracks per-user/day token spend in Redis.
//
// Key shape: `noip:ai:cost:<userId>:<yyyy-mm-dd>` (the shared client's
// `keyPrefix` adds `noip:`; we write the rest here).
// TTL: 2 days so the row survives a tz boundary.
//
// Optimised: single round trip via pipeline (INCRBYFLOAT + EXPIRE).
// On budget breach we publish `ai.cost.budget_breached` and throw a
// `RateLimitError` so the orchestrator returns 429 to the caller.

import {
  compose,
  type Clock,
  type EventBus,
  type UserId,
} from '../../../shared/kernel';
import { RateLimitError } from '../../../shared/errors';
import type { Money } from './value-objects';

export interface CostMeterRedis {
  pipeline(): {
    incrbyfloat(key: string, increment: number): unknown;
    expire(key: string, seconds: number): unknown;
    get(key: string): unknown;
    exec(): Promise<Array<[Error | null, unknown]> | null>;
  };
  get(key: string): Promise<string | null>;
}

export interface CostMeterOptions {
  redis: CostMeterRedis;
  bus: EventBus;
  clock: Clock;
  /** Daily budget in USD per user. Default: 5.0. */
  dailyBudgetUsd?: number;
  /** TTL applied to the daily counter, in seconds. Default: 2 days. */
  ttlSec?: number;
}

const COST_KEY_PREFIX = 'ai:cost';
const EVENT_CONTEXT = 'ai';
const AGGREGATE_TYPE = 'cost_meter';

export class CostMeter {
  private readonly redis: CostMeterRedis;
  private readonly bus: EventBus;
  private readonly clock: Clock;
  private readonly dailyBudgetUsd: number;
  private readonly ttlSec: number;

  constructor(opts: CostMeterOptions) {
    this.redis = opts.redis;
    this.bus = opts.bus;
    this.clock = opts.clock;
    this.dailyBudgetUsd = opts.dailyBudgetUsd ?? 5.0;
    this.ttlSec = opts.ttlSec ?? 60 * 60 * 24 * 2;
  }

  /**
   * Charge a request. Throws `RateLimitError` (and emits
   * `ai.cost.budget_breached`) when the post-charge total exceeds the
   * configured daily budget.
   */
  async charge(args: {
    userId: UserId | null;
    amount: Money;
  }): Promise<{ total: number; budget: number }> {
    if (args.amount.amount <= 0) {
      return { total: 0, budget: this.dailyBudgetUsd };
    }
    const userKey = args.userId ?? ('anonymous' as UserId);
    const day = this.dayStamp();
    const key = `${COST_KEY_PREFIX}:${userKey}:${day}`;

    const pipe = this.redis.pipeline();
    pipe.incrbyfloat(key, args.amount.amount);
    pipe.expire(key, this.ttlSec);
    const results = await pipe.exec();

    let total = 0;
    if (results && results.length > 0) {
      const row = results[0];
      if (row && row[0] === null) {
        total = parseFloat(String(row[1]));
        if (Number.isNaN(total)) total = args.amount.amount;
      } else {
        total = args.amount.amount;
      }
    } else {
      total = args.amount.amount;
    }

    if (total > this.dailyBudgetUsd) {
      this.bus.publish(
        compose(
          {
            type: 'ai.cost.budget_breached',
            context: EVENT_CONTEXT,
            aggregateType: AGGREGATE_TYPE,
            aggregateId: String(userKey),
            actor: { type: 'system' },
            payload: {
              scope: { userId: userKey },
              period: day,
              cost: total,
              budget: this.dailyBudgetUsd,
            },
          },
          this.clock
        )
      );
      throw new RateLimitError(
        Math.max(60, this.ttlSec),
        'AI daily budget exceeded',
        { total, budget: this.dailyBudgetUsd, period: day }
      );
    }

    return { total, budget: this.dailyBudgetUsd };
  }

  /**
   * Read the current spend without charging. Returns 0 if the key is
   * absent.
   */
  async getCurrentSpend(userId: UserId | null): Promise<number> {
    const userKey = userId ?? ('anonymous' as UserId);
    const day = this.dayStamp();
    const key = `${COST_KEY_PREFIX}:${userKey}:${day}`;
    const raw = await this.redis.get(key);
    if (raw === null) return 0;
    const n = parseFloat(raw);
    return Number.isNaN(n) ? 0 : n;
  }

  /** Returns "yyyy-mm-dd" for the current clock instant. */
  private dayStamp(): string {
    const iso = this.clock.nowInstant();
    return iso.slice(0, 10);
  }
}
