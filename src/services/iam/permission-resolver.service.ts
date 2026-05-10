// PermissionResolver — domain service that materialises a user's effective
// permission set per ADR-0008.
//
//   effective(user) = ⋃ permissions(role) for role in flatten(user.roles)
//                    ∪ user.permissions /* direct grants */
//
// Per DDD-05 the role hierarchy is a DAG. We BFS over `parentRoles[]`
// defensively (DAG invariant lives at the write boundary, not here): a
// cycle is logged and truncated rather than thrown so a corrupted hierarchy
// never pages the request path.
//
// The cache is consulted before any Mongo trip (see `permission-cache.ts`).
// On cache miss / cache failure we recompute live; on Redis failure we
// **never** fail-open at the authorisation decision — that lives in
// `check()` and its condition evaluators.

import type { Instant, Clock } from '../../shared/kernel';
import { SystemClock } from '../../shared/kernel';
import type { PermissionCache } from './permission-cache';
import {
  evaluateConditions,
  type ConditionContext,
} from './condition-evaluator';

/** Logger surface limited to what this service uses. */
export interface PermissionResolverLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Stripped-down permission shape we operate on. */
export interface PermissionSpec {
  id: string;
  name: string;
  resource: string;
  action: string;
  conditions?: Record<string, unknown>;
}

/** Stripped-down role shape — only what the resolver consumes. */
export interface RoleSpec {
  id: string;
  name: string;
  /** Permission ids OR inlined permission specs. The resolver tolerates both. */
  permissions: ReadonlyArray<string | PermissionSpec>;
  /** Parent role ids (DAG edges). */
  parentRoles?: ReadonlyArray<string>;
}

/**
 * Minimal repository surface so the service can be unit-tested with a
 * lightweight stub. Mongoose's `Model` exposes a superset of these methods
 * once wrapped in a thin adapter (Phase 1 wave 3).
 */
export interface RoleRepository {
  /** Resolve a batch of roles in one round trip. Order is irrelevant. */
  findByIds(ids: ReadonlyArray<string>): Promise<ReadonlyArray<RoleSpec>>;
}

export interface PermissionRepository {
  findByIds(ids: ReadonlyArray<string>): Promise<ReadonlyArray<PermissionSpec>>;
}

/**
 * Effective set, keyed by `${resource}.${action}` for O(1) lookup. The
 * value is the *originating* permission spec — when conditions are present
 * the evaluator gets the raw `conditions` map.
 *
 * `permissions` is a `Map`; serialised representations expand it to an
 * object (see `serialise` / `deserialise`). External callers should treat
 * the map as read-only.
 */
export interface EffectivePermissionSet {
  userId: string;
  permissions: Map<string, PermissionSpec>;
  computedAt: Instant;
}

export type AuthorizationDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string };

interface Deps {
  roles: RoleRepository;
  permissions: PermissionRepository;
  cache: PermissionCache;
  logger: PermissionResolverLogger;
  /** Optional clock for `computedAt`; defaults to `SystemClock`. */
  clock?: Clock;
}

/**
 * Hard cap on the number of *distinct* role ids a user's hierarchy can pull
 * in. Any user with more than this is almost certainly the symptom of a
 * cycle slipped past the write-side invariant — log loudly and truncate.
 */
const ROLE_CLOSURE_LIMIT = 256;

export class PermissionResolver {
  private readonly roles: RoleRepository;
  private readonly permissions: PermissionRepository;
  private readonly cache: PermissionCache;
  private readonly logger: PermissionResolverLogger;
  private readonly clock: Clock;

  constructor(deps: Deps) {
    this.roles = deps.roles;
    this.permissions = deps.permissions;
    this.cache = deps.cache;
    this.logger = deps.logger;
    this.clock = deps.clock ?? new SystemClock();
  }

  /**
   * Resolve the effective permission set for a user.
   *
   * Cache-first: if Redis serves a hit we return it untouched. On miss or
   * Redis failure we compute live and write back.
   */
  async resolveEffective(
    userId: string,
    roleIds: ReadonlyArray<string>,
    directPermissionIds: ReadonlyArray<string>
  ): Promise<EffectivePermissionSet> {
    const cached = await this.cache.get(userId);
    if (cached) return cached;

    const set = await this.computeLive(userId, roleIds, directPermissionIds);
    // Best-effort write-back. The cache implementation swallows Redis
    // errors; we never let cache writes block the request path.
    await this.cache.set(userId, set);
    return set;
  }

  /**
   * O(1) lookup against `${resource}.${action}` followed by optional
   * condition evaluation. Returns a structured decision so callers (e.g.
   * `requirePermission`) can surface the deny reason.
   */
  check(
    set: EffectivePermissionSet,
    resource: string,
    action: string,
    ctx?: ConditionContext
  ): AuthorizationDecision {
    const key = `${resource}.${action}`;
    const perm = set.permissions.get(key);
    if (!perm) {
      return { kind: 'deny', reason: 'permission-missing' };
    }
    if (
      perm.conditions !== undefined &&
      Object.keys(perm.conditions).length > 0
    ) {
      return evaluateConditions(perm.conditions, ctx ?? {});
    }
    return { kind: 'allow' };
  }

  /** Drop a single user's cached set. No-op on Redis failure. */
  async invalidateUser(userId: string): Promise<void> {
    await this.cache.invalidate(userId);
  }

  /**
   * Drop every user's cached set. We err on the side of correctness: a
   * role mutation could have widened the hierarchy reachable from any
   * user, so we cannot cheaply enumerate the affected users without a
   * reverse index. ADR-0008 explicitly accepts this trade-off — `Phase 1
   * wave 3` will add a `roleId -> userIds` reverse index when the user
   * volume justifies the bookkeeping cost.
   */
  async invalidateRole(roleId: string): Promise<void> {
    this.logger.info('invalidating cached permissions for role', { roleId });
    await this.cache.invalidateAll();
  }

  /** Drop everything. */
  async invalidateAll(): Promise<void> {
    await this.cache.invalidateAll();
  }

  // ---------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------

  private async computeLive(
    userId: string,
    roleIds: ReadonlyArray<string>,
    directPermissionIds: ReadonlyArray<string>
  ): Promise<EffectivePermissionSet> {
    const closure = await this.computeRoleClosure(roleIds);

    // Collect every permission id (or inlined spec) referenced by any
    // role in the closure plus the direct grants.
    const inlineSpecs = new Map<string, PermissionSpec>();
    const referencedIds = new Set<string>();
    for (const id of directPermissionIds) referencedIds.add(id);
    for (const role of closure.values()) {
      for (const ref of role.permissions) {
        if (typeof ref === 'string') {
          referencedIds.add(ref);
        } else {
          inlineSpecs.set(ref.id, ref);
        }
      }
    }

    // Resolve any ids that weren't already inlined in a single round trip.
    const idsToFetch = Array.from(referencedIds).filter(
      id => !inlineSpecs.has(id)
    );
    let fetched: ReadonlyArray<PermissionSpec> = [];
    if (idsToFetch.length > 0) {
      fetched = await this.permissions.findByIds(idsToFetch);
    }

    // Build the lookup map. Last-wins on duplicate `(resource, action)` —
    // role hierarchy invariants forbid contradictions, but if one shows up
    // we prefer the most recently iterated permission deterministically.
    const permissions = new Map<string, PermissionSpec>();
    for (const spec of inlineSpecs.values()) {
      permissions.set(`${spec.resource}.${spec.action}`, spec);
    }
    for (const spec of fetched) {
      permissions.set(`${spec.resource}.${spec.action}`, spec);
    }

    return {
      userId,
      permissions,
      computedAt: this.clock.nowInstant(),
    };
  }

  /**
   * BFS over `parentRoles[]`. Cycles are detected via a visited set and
   * silently truncated (with a `warn`) — invariants live at the write
   * boundary, this read path stays robust.
   */
  private async computeRoleClosure(
    roleIds: ReadonlyArray<string>
  ): Promise<Map<string, RoleSpec>> {
    const closure = new Map<string, RoleSpec>();
    const queue: string[] = [...roleIds];
    const visited = new Set<string>();

    while (queue.length > 0) {
      // Pop the entire current frontier so we can fetch the layer in a
      // single round trip. After the frontier is consumed the queue
      // contains the next layer of unseen ids.
      const frontier: string[] = [];
      for (const id of queue) {
        if (visited.has(id)) continue;
        visited.add(id);
        if (visited.size > ROLE_CLOSURE_LIMIT) {
          this.logger.warn('role closure truncated by safety limit', {
            limit: ROLE_CLOSURE_LIMIT,
            seedRoleIds: roleIds,
          });
          break;
        }
        frontier.push(id);
      }
      // Reset the queue for the next iteration's BFS frontier.
      queue.length = 0;

      if (frontier.length === 0) break;

      const layer = await this.roles.findByIds(frontier);
      for (const role of layer) {
        if (closure.has(role.id)) {
          // Cycle — already captured. Defensive only; BFS visited-set
          // should have caught this above.
          this.logger.warn('cycle detected in role hierarchy; skipping', {
            roleId: role.id,
          });
          continue;
        }
        closure.set(role.id, role);
        for (const parentId of role.parentRoles ?? []) {
          if (visited.has(parentId)) continue;
          queue.push(parentId);
        }
      }
    }

    return closure;
  }
}

/**
 * Serialise an `EffectivePermissionSet` for storage. We expand the `Map`
 * to a plain object since `JSON.stringify` ignores `Map` keys.
 */
export interface SerialisedEffectiveSet {
  userId: string;
  permissions: Record<string, PermissionSpec>;
  computedAt: string;
}

export function serialiseSet(
  set: EffectivePermissionSet
): SerialisedEffectiveSet {
  const out: Record<string, PermissionSpec> = {};
  for (const [key, value] of set.permissions) {
    out[key] = value;
  }
  return {
    userId: set.userId,
    permissions: out,
    computedAt: set.computedAt as string,
  };
}

export function deserialiseSet(
  raw: SerialisedEffectiveSet
): EffectivePermissionSet {
  const map = new Map<string, PermissionSpec>();
  for (const [key, value] of Object.entries(raw.permissions)) {
    map.set(key, value);
  }
  return {
    userId: raw.userId,
    permissions: map,
    computedAt: raw.computedAt as Instant,
  };
}
