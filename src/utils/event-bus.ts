import * as uuid from 'uuid';
import logger from '../utils/logger';

/**
 * Base shape of a domain event published over the bus.
 *
 * Events follow the catalogue documented in `docs/ddd/domain-events.md`:
 * past-tense, namespaced names (e.g. `iam.UserRegistered`), payloads carry
 * stable identifiers, and every event has a UUIDv7 `eventId` and an
 * `occurredAt` timestamp. Subscribers are expected to dedupe on `eventId`.
 */
export interface DomainEvent<T = unknown> {
  eventId: string;
  name: string;
  occurredAt: Date;
  payload: T;
}

/**
 * Envelope passed to handlers; adds optional correlation metadata so
 * causally related events can be traced across boundaries.
 */
export interface EventEnvelope<T = unknown> extends DomainEvent<T> {
  correlationId?: string;
}

/**
 * A subscriber callback. May be sync or async; returned promises are awaited
 * by `publish` so callers can know when delivery has settled.
 */
export type EventHandler<T = unknown> = (
  event: EventEnvelope<T>
) => void | Promise<void>;

/**
 * Counters surfaced by `EventBus.metrics()`.
 *
 * - `published`     : number of events accepted by `publish`.
 * - `delivered`     : number of (event, handler) deliveries that completed
 *                     without throwing.
 * - `handlerErrors` : number of handler invocations that threw / rejected.
 * - `deadLettered`  : mirror of `handlerErrors`; kept as a separate counter
 *                     so future transports can distinguish "handler bug"
 *                     from "delivery dropped" without breaking this API.
 */
export interface EventBusMetrics {
  published: number;
  delivered: number;
  handlerErrors: number;
  deadLettered: number;
}

interface WildcardSubscription {
  prefix: string;
  handler: EventHandler<unknown>;
}

/**
 * Generate a `eventId`. Prefer UUIDv7 (time-ordered) when available, fall
 * back to v4 so the bus still works against older `uuid` releases or test
 * mocks that only expose `v4`.
 */
function newEventId(): string {
  const u = uuid as unknown as {
    v7?: () => string;
    v4: () => string;
  };
  if (typeof u.v7 === 'function') {
    return u.v7();
  }
  return u.v4();
}

/**
 * Tiny in-process publish/subscribe hub for domain events.
 *
 * Intentionally minimal: a `Map` of exact-name subscriptions and a `Set`
 * of trailing-`*` wildcard subscriptions. No EventEmitter inheritance, no
 * scheduling, no persistence. The surface mirrors what a real broker
 * binding (Kafka/NATS/etc.) would expose so swapping the implementation
 * later is a localised change.
 */
export class EventBus {
  private readonly exact = new Map<string, Set<EventHandler<unknown>>>();
  private readonly wildcards = new Set<WildcardSubscription>();
  private readonly counters: EventBusMetrics = {
    published: 0,
    delivered: 0,
    handlerErrors: 0,
    deadLettered: 0,
  };

  /**
   * Publish an event to all matching subscribers.
   *
   * Builds an envelope (eventId + occurredAt + correlationId), invokes
   * every matching handler concurrently, awaits them all, and returns the
   * envelope. A handler throwing does not abort the publish — the error
   * is logged and the handler-error / dead-letter counters tick up.
   */
  async publish<T>(
    name: string,
    payload: T,
    opts?: { correlationId?: string }
  ): Promise<EventEnvelope<T>> {
    const envelope: EventEnvelope<T> = {
      eventId: newEventId(),
      name,
      occurredAt: new Date(),
      payload,
      ...(opts?.correlationId !== undefined
        ? { correlationId: opts.correlationId }
        : {}),
    };

    this.counters.published += 1;

    const handlers = this.collectHandlers(name);
    if (handlers.length === 0) {
      return envelope;
    }

    await Promise.all(
      handlers.map(async (handler) => {
        try {
          await handler(envelope as EventEnvelope<unknown>);
          this.counters.delivered += 1;
        } catch (err) {
          this.counters.handlerErrors += 1;
          this.counters.deadLettered += 1;
          logger.error('event-bus handler threw', {
            eventName: name,
            eventId: envelope.eventId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })
    );

    return envelope;
  }

  /**
   * Subscribe to a specific event name or a trailing-`*` wildcard.
   *
   * Returns an unsubscribe function — call it (idempotently) to detach
   * the handler. Patterns are matched literally; only the trailing `*`
   * form is supported (e.g. `iam.*` matches `iam.UserRegistered`).
   */
  subscribe<T>(pattern: string, handler: EventHandler<T>): () => void {
    const erased = handler as EventHandler<unknown>;

    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      const sub: WildcardSubscription = { prefix, handler: erased };
      this.wildcards.add(sub);
      return () => {
        this.wildcards.delete(sub);
      };
    }

    let set = this.exact.get(pattern);
    if (!set) {
      set = new Set<EventHandler<unknown>>();
      this.exact.set(pattern, set);
    }
    set.add(erased);
    return () => {
      const current = this.exact.get(pattern);
      if (!current) return;
      current.delete(erased);
      if (current.size === 0) {
        this.exact.delete(pattern);
      }
    };
  }

  /**
   * Subscribe and auto-detach after the first matching delivery.
   *
   * The wrapper unsubscribes before invoking the user handler so a
   * re-entrant publish from within the handler will not re-fire it.
   */
  subscribeOnce<T>(pattern: string, handler: EventHandler<T>): () => void {
    const unsubscribe = this.subscribe<T>(pattern, async (event) => {
      unsubscribe();
      await handler(event);
    });
    return unsubscribe;
  }

  /** Drop every subscription. Intended for use between tests. */
  unsubscribeAll(): void {
    this.exact.clear();
    this.wildcards.clear();
  }

  /** Snapshot of internal counters (returned by value, safe to mutate). */
  metrics(): EventBusMetrics {
    return { ...this.counters };
  }

  private collectHandlers(name: string): Array<EventHandler<unknown>> {
    const matches: Array<EventHandler<unknown>> = [];
    const exactSet = this.exact.get(name);
    if (exactSet) {
      for (const h of exactSet) matches.push(h);
    }
    for (const sub of this.wildcards) {
      if (name.startsWith(sub.prefix)) {
        matches.push(sub.handler);
      }
    }
    return matches;
  }
}

/** Process-wide bus. Use this in production paths. */
export const defaultBus = new EventBus();

/** Build a fresh bus — preferred in tests to avoid cross-test leakage. */
export function createEventBus(): EventBus {
  return new EventBus();
}
