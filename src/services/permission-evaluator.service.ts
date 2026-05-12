import type { Permission } from '../types/auth.types';

/**
 * Conditional-permission evaluator (ADR-0009).
 *
 * A Permission may carry an optional `conditions` object that further
 * narrows when the (resource, action) pair grants access. Conditions are
 * a flat `Record<allowedKey, value>`: each key references a piece of
 * request context (`$user.tenantId`, `$resource.ownerId`, …) and the
 * value is the expected literal that the context must equal.
 *
 * Rules:
 *   1. Allow-list only. Unknown condition keys are a hard FAIL — never
 *      a silent allow — so an attacker cannot smuggle a permissive
 *      key through admin tooling.
 *   2. Conditions are pure data — no expressions, no JS eval, no
 *      function values.
 *   3. Multiple conditions are AND-ed.
 *   4. A permission with no `conditions` always passes the evaluator.
 *
 * To extend, add the key to `ALLOWED_CONDITION_KEYS` *and* a resolver
 * that reads the value from the supplied `PermissionContext`.
 */
export interface PermissionContext {
  user: {
    id: string;
    tenantId?: string;
    roles?: string[];
  };
  resource?: {
    id?: string;
    tenantId?: string;
    ownerId?: string;
    kind?: string;
  };
}

/**
 * The closed allow-list of condition keys. Anything else is rejected.
 * Each entry maps a key to a resolver that reads the value from the
 * `PermissionContext`. Resolvers must be pure functions; never throw.
 */
const ALLOWED_CONDITION_KEYS: Record<
  string,
  (ctx: PermissionContext) => unknown
> = {
  '$user.id': c => c.user.id,
  '$user.tenantId': c => c.user.tenantId,
  '$resource.id': c => c.resource?.id,
  '$resource.tenantId': c => c.resource?.tenantId,
  '$resource.ownerId': c => c.resource?.ownerId,
  '$resource.kind': c => c.resource?.kind,
};

export interface ConditionEvalResult {
  allowed: boolean;
  /** Which condition failed (if any). For logging / debugging. */
  reason?: string;
}

/**
 * Evaluate a single condition object against a context.
 * Returns { allowed: false, reason } on:
 *   - unknown condition key (rejected as a safety measure)
 *   - resolver returning undefined when the value is non-undefined
 *   - any AND-clause mismatching
 */
export function evaluateConditions(
  conditions: Record<string, unknown> | undefined,
  ctx: PermissionContext
): ConditionEvalResult {
  if (!conditions || Object.keys(conditions).length === 0) {
    return { allowed: true };
  }

  for (const [key, expected] of Object.entries(conditions)) {
    const resolver = ALLOWED_CONDITION_KEYS[key];
    if (!resolver) {
      return {
        allowed: false,
        reason: `unknown_condition_key:${key}`,
      };
    }
    const actual = resolver(ctx);
    if (actual === undefined) {
      return {
        allowed: false,
        reason: `condition_unresolved:${key}`,
      };
    }
    if (!valuesEqual(actual, expected)) {
      return {
        allowed: false,
        reason: `condition_mismatch:${key}`,
      };
    }
  }
  return { allowed: true };
}

/**
 * Evaluate a list of permissions against a (resource, action) and a
 * context. Returns the first permission that:
 *   - matches resource (literal or '*')
 *   - matches action (literal or '*')
 *   - passes conditions
 * Returns null if none match.
 */
export function findGrantingPermission(
  permissions: Permission[],
  resource: string,
  action: string,
  ctx: PermissionContext
): { permission: Permission; reason?: string } | null {
  for (const p of permissions) {
    if (p.resource !== resource && p.resource !== '*') continue;
    if (p.action !== action && p.action !== '*') continue;
    const r = evaluateConditions(p.conditions, ctx);
    if (r.allowed) {
      return { permission: p };
    }
  }
  return null;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  // Coerce primitives via JSON for arrays / plain objects only.
  if (typeof a === 'object' && typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Exposed for tests + tooling: the set of accepted condition keys.
 */
export function allowedConditionKeys(): string[] {
  return Object.keys(ALLOWED_CONDITION_KEYS);
}
