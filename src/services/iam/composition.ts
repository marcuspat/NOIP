// IAM composition helpers for the application bootstrap.
//
// Centralises two responsibilities so `src/app.ts` does not have to carry the
// mechanical glue:
//
//   1. Mongoose-backed adapters that satisfy the resolver's
//      `RoleRepository` / `PermissionRepository` interfaces. The resolver
//      tolerates either permission ids or inlined specs; we hand it inlined
//      specs (via `populate`) so the per-layer hop is one query, not two.
//
//   2. A `NoopPermissionCache` that satisfies the cache contract without
//      Redis. Phase 1 wave 3 wires the real Redis client in and swaps this
//      out for `RedisPermissionCache`. Until then the resolver computes
//      live on every authorisation check — correct, just unoptimised.
//
// No domain logic lives here. Everything substantive is in
// `permission-resolver.service.ts`, `permission-cache.ts`,
// `condition-evaluator.ts`, and `permission-invalidation.ts`.

import { RoleModel } from '../../models/role.model';
import { PermissionModel } from '../../models/permission.model';
import type {
  EffectivePermissionSet,
  PermissionRepository,
  PermissionSpec,
  RoleRepository,
  RoleSpec,
} from './permission-resolver.service';
import type { PermissionCache } from './permission-cache';

/**
 * Cache implementation that defers to "compute live" on every call. Used as
 * the default until the shared Redis client is wired into the composition
 * root (TODO `src/app.ts`).
 */
export class NoopPermissionCache implements PermissionCache {
  async get(_userId: string): Promise<EffectivePermissionSet | null> {
    return null;
  }
  async set(_userId: string, _set: EffectivePermissionSet): Promise<void> {
    // intentional no-op
  }
  async invalidate(_userId: string): Promise<void> {
    // intentional no-op
  }
  async invalidateAll(): Promise<void> {
    // intentional no-op
  }
}

/**
 * Mongoose-backed repository adapters. The resolver only ever calls
 * `findByIds`, so the surface is intentionally tiny — extend in Phase 1
 * wave 3 if other consumers materialise.
 */
export const mongooseRoleRepository: RoleRepository = {
  async findByIds(ids) {
    if (ids.length === 0) return [];
    const docs = await RoleModel.find({ _id: { $in: ids as string[] } })
      .populate('permissions')
      .lean<unknown[]>()
      .exec();
    return (docs as Array<Record<string, unknown>>).map(toRoleSpec);
  },
};

export const mongoosePermissionRepository: PermissionRepository = {
  async findByIds(ids) {
    if (ids.length === 0) return [];
    const docs = await PermissionModel.find({ _id: { $in: ids as string[] } })
      .lean<unknown[]>()
      .exec();
    return (docs as Array<Record<string, unknown>>).map(toPermissionSpec);
  },
};

function toRoleSpec(doc: Record<string, unknown>): RoleSpec {
  const id = stringId(doc['_id'] ?? doc['id']);
  const rawPerms = doc['permissions'];
  const permissions: Array<string | PermissionSpec> = Array.isArray(rawPerms)
    ? (rawPerms as unknown[]).map(p =>
        typeof p === 'string'
          ? p
          : isObject(p) && (p['_id'] !== undefined || p['id'] !== undefined)
            ? toPermissionSpec(p)
            : stringId(p)
      )
    : [];
  const rawParents = doc['parentRoles'];
  const parents = Array.isArray(rawParents)
    ? (rawParents as unknown[]).map(stringId)
    : undefined;
  return {
    id,
    name: String(doc['name'] ?? id),
    permissions,
    ...(parents ? { parentRoles: parents } : {}),
  };
}

function toPermissionSpec(doc: Record<string, unknown>): PermissionSpec {
  const id = stringId(doc['_id'] ?? doc['id']);
  const conditions = doc['conditions'];
  return {
    id,
    name: String(
      doc['name'] ?? `${String(doc['resource'])}.${String(doc['action'])}`
    ),
    resource: String(doc['resource'] ?? ''),
    action: String(doc['action'] ?? ''),
    ...(isObject(conditions) ? { conditions } : {}),
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringId(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof (v as { toString: unknown }).toString === 'function') {
    return (v as { toString(): string }).toString();
  }
  return String(v);
}
