// Domain event envelope and in-process event bus for the shared kernel.
//
// The envelope shape is fixed by docs/architecture/ddd/12-domain-events.md
// and must remain stable across bounded contexts. Subscribers live inside
// each context; this module only knows about delivery, not semantics.

import type { Instant } from './time';
import { newId } from './ids';
import type { EventId } from './ids';

/**
 * Identity of the actor that triggered the event. `system` covers
 * scheduler-driven and reconciliation events that have no human origin.
 */
export interface DomainEventActor {
  type: 'user' | 'service' | 'system';
  id?: string;
}

/**
 * Canonical domain event envelope. `payload` carries the context-specific
 * data; everything else is metadata that infrastructure code can rely on
 * without reaching into `payload`.
 */
export interface DomainEvent<T = unknown> {
  id: EventId;
  type: string;
  occurredAt: Instant;
  context: string;
  aggregateType: string;
  aggregateId: string;
  actor?: DomainEventActor;
  payload: T;
  correlationId?: string;
  causationId?: string;
  schemaVersion: number;
}

export type EventHandler<T = unknown> = (
  event: DomainEvent<T>
) => void | Promise<void>;

export type Unsubscribe = () => void;

/**
 * Minimal logger surface so the bus does not depend on winston directly.
 * Anything that exposes these methods (including `console`) satisfies it.
 */
export interface EventBusLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface EventBus {
  publish<T>(event: DomainEvent<T>): void;
  publishMany(events: ReadonlyArray<DomainEvent<unknown>>): void;
  subscribe<T = unknown>(
    typeOrPattern: string,
    handler: EventHandler<T>
  ): Unsubscribe;
}

/**
 * Subset of `Clock` used here. We don't depend on the full interface so
 * tests can pass a plain `() => Date` shim if they prefer.
 */
export interface ComposeClock {
  nowInstant(): Instant;
}

/**
 * Builds a fully-formed `DomainEvent` from a partial envelope. Generates
 * `id`, `occurredAt`, and `schemaVersion` defaults if not supplied.
 *
 * The caller must always provide context, aggregateType, aggregateId,
 * type, and payload — these are not safely defaultable.
 */
export function compose<T>(
  envelope: Omit<DomainEvent<T>, 'id' | 'occurredAt' | 'schemaVersion'> & {
    id?: EventId;
    occurredAt?: Instant;
    schemaVersion?: number;
  },
  clock: ComposeClock
): DomainEvent<T> {
  return {
    id: envelope.id ?? newId<EventId>(),
    type: envelope.type,
    occurredAt: envelope.occurredAt ?? clock.nowInstant(),
    context: envelope.context,
    aggregateType: envelope.aggregateType,
    aggregateId: envelope.aggregateId,
    ...(envelope.actor !== undefined ? { actor: envelope.actor } : {}),
    payload: envelope.payload,
    ...(envelope.correlationId !== undefined
      ? { correlationId: envelope.correlationId }
      : {}),
    ...(envelope.causationId !== undefined
      ? { causationId: envelope.causationId }
      : {}),
    schemaVersion: envelope.schemaVersion ?? 1,
  };
}

interface Subscription {
  pattern: string;
  isPrefix: boolean;
  prefix: string; // valid when isPrefix is true; the part before the trailing `*`
  handler: EventHandler<unknown>;
}

/**
 * Single-process synchronous event bus.
 *
 * Delivery rules:
 *   - Handlers are invoked in registration order.
 *   - Promise-returning handlers fire-and-forget; the bus does not await
 *     them. Subscribers that need ordering must serialize internally.
 *   - A handler that throws (sync) or rejects (async) is logged and the
 *     bus continues delivering to remaining subscribers. Retry/DLQ
 *     semantics live in subscribers, not here.
 *   - Pattern subscriptions support a single trailing `*` (e.g. `iam.*`).
 *     Anything else is treated as an exact match.
 */
export class InMemoryEventBus implements EventBus {
  private readonly subs: Subscription[] = [];

  constructor(private readonly logger: EventBusLogger = console) {}

  publish<T>(event: DomainEvent<T>): void {
    for (const sub of this.subs) {
      if (!this.matches(sub, event.type)) continue;
      this.invoke(sub, event);
    }
  }

  publishMany(events: ReadonlyArray<DomainEvent<unknown>>): void {
    for (const event of events) {
      this.publish(event);
    }
  }

  subscribe<T = unknown>(
    typeOrPattern: string,
    handler: EventHandler<T>
  ): Unsubscribe {
    const isPrefix = typeOrPattern.endsWith('*');
    const prefix = isPrefix
      ? typeOrPattern.slice(0, typeOrPattern.length - 1)
      : '';
    const sub: Subscription = {
      pattern: typeOrPattern,
      isPrefix,
      prefix,
      handler: handler as EventHandler<unknown>,
    };
    this.subs.push(sub);
    return () => {
      const idx = this.subs.indexOf(sub);
      if (idx >= 0) this.subs.splice(idx, 1);
    };
  }

  private matches(sub: Subscription, eventType: string): boolean {
    if (sub.isPrefix) return eventType.startsWith(sub.prefix);
    return sub.pattern === eventType;
  }

  private invoke(sub: Subscription, event: DomainEvent<unknown>): void {
    try {
      const result = sub.handler(event);
      if (result && typeof (result as Promise<void>).then === 'function') {
        (result as Promise<void>).catch((err: unknown) => {
          this.logger.error('event handler rejected', {
            eventType: event.type,
            eventId: event.id,
            pattern: sub.pattern,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch (err: unknown) {
      this.logger.error('event handler threw', {
        eventType: event.type,
        eventId: event.id,
        pattern: sub.pattern,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
