// permission-invalidation — wires the IAM cache to the EventBus so that
// role/permission mutations propagate across pods without waiting for the
// 5-minute TTL to elapse.
//
// Per DDD-12 the relevant events are:
//   - iam.permission.escalated  → invalidate the affected user
//   - iam.permission.granted    → invalidate the affected user
//   - iam.permission.revoked    → invalidate the affected user
//   - iam.role.updated          → invalidate every user (no reverse index yet)
//   - iam.role.deleted          → invalidate every user
//   - iam.user.deactivated      → invalidate the affected user
//
// Subscribers run synchronously per the in-memory bus contract; the
// returned `unsubscribe` handles let tests revert state cleanly.

import type { EventBus, Unsubscribe, DomainEvent } from '../../shared/kernel';
import type { PermissionResolver } from './permission-resolver.service';

/** Logger surface limited to what this module uses. */
export interface PermissionInvalidationLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Permission-impacting events keyed off their `userId` payload field.
 * These are eligible for fine-grained per-user invalidation.
 */
const PER_USER_EVENTS = [
  'iam.permission.escalated',
  'iam.permission.granted',
  'iam.permission.revoked',
  'iam.user.deactivated',
] as const;

/**
 * Role-level events. We invalidate the entire cache because a role
 * mutation could affect any user that transitively inherits it; absent a
 * reverse `roleId → userIds` index this is the safe default.
 */
const ROLE_EVENTS = ['iam.role.updated', 'iam.role.deleted'] as const;

interface PerUserPayload {
  userId?: unknown;
  [key: string]: unknown;
}

interface RolePayload {
  roleId?: unknown;
  [key: string]: unknown;
}

/**
 * Subscribe `resolver` to permission-affecting events on `bus`. Returns
 * the array of unsubscribe handles in registration order so callers can
 * tear down individual subscriptions or all of them via `disposeAll`.
 */
export function installPermissionInvalidation(
  bus: EventBus,
  resolver: PermissionResolver,
  logger: PermissionInvalidationLogger
): Unsubscribe[] {
  const handles: Unsubscribe[] = [];

  for (const type of PER_USER_EVENTS) {
    handles.push(
      bus.subscribe<PerUserPayload>(type, async event => {
        const userId = readUserId(event);
        if (!userId) {
          logger.warn('invalidation event missing userId; skipping', {
            type: event.type,
            eventId: event.id,
          });
          return;
        }
        try {
          await resolver.invalidateUser(userId);
        } catch (err: unknown) {
          logger.error('invalidateUser failed', {
            type: event.type,
            userId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })
    );
  }

  for (const type of ROLE_EVENTS) {
    handles.push(
      bus.subscribe<RolePayload>(type, async event => {
        const roleId = readRoleId(event);
        if (!roleId) {
          logger.warn('invalidation event missing roleId; skipping', {
            type: event.type,
            eventId: event.id,
          });
          return;
        }
        try {
          await resolver.invalidateRole(roleId);
        } catch (err: unknown) {
          logger.error('invalidateRole failed', {
            type: event.type,
            roleId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })
    );
  }

  logger.info('permission invalidation subscribers installed', {
    perUserEventCount: PER_USER_EVENTS.length,
    roleEventCount: ROLE_EVENTS.length,
  });

  return handles;
}

/** Convenience: tear down every subscription returned by install. */
export function disposeAll(handles: ReadonlyArray<Unsubscribe>): void {
  for (const h of handles) h();
}

function readUserId(event: DomainEvent<PerUserPayload>): string | undefined {
  const direct = event.payload?.userId;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  // Some producers may attach the principal under `event.aggregateId`
  // when the aggregate type is `user`. Fall back to that.
  if (
    event.aggregateType === 'user' &&
    typeof event.aggregateId === 'string' &&
    event.aggregateId.length > 0
  ) {
    return event.aggregateId;
  }
  return undefined;
}

function readRoleId(event: DomainEvent<RolePayload>): string | undefined {
  const direct = event.payload?.roleId;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  if (
    event.aggregateType === 'role' &&
    typeof event.aggregateId === 'string' &&
    event.aggregateId.length > 0
  ) {
    return event.aggregateId;
  }
  return undefined;
}
