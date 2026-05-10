// requirePermission — Express middleware that gates a route on
// `(resource, action)` per ADR-0008.
//
// Sibling-agent contract: this file is **new** and does not modify
// `auth.middleware.ts` so the EventBus-wiring agent can land its changes
// to that file without conflict. Mount this *after* `authMiddleware` —
// it relies on `req.user` being populated.
//
// Behaviour summary:
//   - Missing `req.user`         → throw `UnauthorizedError`.
//   - Missing permission         → throw `ForbiddenError` with deny reason.
//   - Failing condition evaluator→ throw `ForbiddenError` with deny reason.
//   - Otherwise                  → `next()`.
//
// We funnel decisions through `next(err)` so the existing typed-error
// handler (see `src/shared/errors`) maps them to HTTP responses.

import type { Request, RequestHandler } from 'express';

import { ForbiddenError, UnauthorizedError } from '../shared/errors';
import type {
  PermissionResolver,
  EffectivePermissionSet,
} from '../services/iam/permission-resolver.service';
import type { ConditionContext } from '../services/iam/condition-evaluator';

/** Logger surface limited to what the middleware uses. */
export interface RequirePermissionLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface RequirePermissionOptions {
  resolver?: PermissionResolver;
  /**
   * Override the default context built for condition evaluators. The
   * default is `{ params, query, body, ip, user }`.
   */
  contextFn?: (req: Request) => ConditionContext;
  logger?: RequirePermissionLogger;
}

/**
 * Module-level resolver registry. The composition root (`src/app.ts`,
 * owned by the sibling agent) calls `setDefaultPermissionResolver(...)`
 * during boot; route definitions call `requirePermission('a','b')` without
 * having to thread the resolver through every router.
 *
 * Routes can still pass an explicit resolver via `opts.resolver` — used
 * heavily by tests.
 */
let defaultResolver: PermissionResolver | undefined;
let defaultLogger: RequirePermissionLogger | undefined;

export function setDefaultPermissionResolver(
  resolver: PermissionResolver
): void {
  defaultResolver = resolver;
}

export function setDefaultRequirePermissionLogger(
  logger: RequirePermissionLogger
): void {
  defaultLogger = logger;
}

/** Test helper. Resets module-level state between specs. */
export function resetRequirePermissionDefaults(): void {
  defaultResolver = undefined;
  defaultLogger = undefined;
}

/**
 * Build a request handler enforcing `(resource, action)`.
 *
 * Latency note: a single Redis `GET` (in the cache path) precedes any
 * Mongo work, and condition evaluation is O(conditions count) over an
 * already-loaded permission. We never fan out to additional Redis or
 * Mongo round trips beyond that.
 */
export function requirePermission(
  resource: string,
  action: string,
  opts: RequirePermissionOptions = {}
): RequestHandler {
  return async (req, _res, next) => {
    const resolver = opts.resolver ?? defaultResolver;
    const logger = opts.logger ?? defaultLogger;

    try {
      // 1. Authentication gate.
      const user = (req as Request & { user?: unknown }).user as
        | UserLike
        | undefined;
      if (!user) {
        throw new UnauthorizedError('Authentication required');
      }

      // 2. Materialise the principal's identifier list. The sibling
      //    auth.middleware populates `req.user` with the populated
      //    Mongoose user — we tolerate both populated docs and raw ids.
      const userId = pickUserId(user);
      if (!userId) {
        throw new UnauthorizedError('User identifier missing');
      }
      const roleIds = pickRoleIds(user);
      const directPermissionIds = pickPermissionIds(user);

      // 3. Resolve the effective set. We require a configured resolver
      //    in production; in tests the explicit `opts.resolver` covers it.
      if (!resolver) {
        throw new UnauthorizedError(
          'Authorization not configured: no permission resolver'
        );
      }
      const set: EffectivePermissionSet = await resolver.resolveEffective(
        userId,
        roleIds,
        directPermissionIds
      );

      // 4. Build the condition context. The default surface is the
      //    request bags so evaluators like `ownerOf(params.id)` just work.
      const ctx: ConditionContext = opts.contextFn
        ? opts.contextFn(req)
        : defaultContext(req, user);

      // 5. Decide.
      const decision = resolver.check(set, resource, action, ctx);

      // 6. Counter — wired through `logger.info` for now per the ADR-0008
      //    plan. Phase 5 swaps in a real Prometheus counter.
      if (logger) {
        logger.info('noip.authz.checks.total', {
          decision: decision.kind,
          resource,
          action,
          ...(decision.kind === 'deny' ? { reason: decision.reason } : {}),
        });
      }

      if (decision.kind === 'deny') {
        throw new ForbiddenError('Access denied', {
          resource,
          action,
          reason: decision.reason,
        });
      }
      next();
    } catch (err: unknown) {
      next(err);
    }
  };
}

// ---------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------

interface UserLike {
  _id?: unknown;
  id?: unknown;
  roles?: unknown;
  permissions?: unknown;
  tenantId?: unknown;
  [key: string]: unknown;
}

function defaultContext(req: Request, user: UserLike): ConditionContext {
  // Express's runtime values are typed loosely; the cast keeps the
  // condition evaluator surface explicit at module boundaries.
  const contextUser = toContextUser(user);
  const ctx: ConditionContext = {
    params: req.params as unknown as Record<string, unknown>,
    query: req.query as unknown as Record<string, unknown>,
    body: (req.body ?? {}) as Record<string, unknown>,
  };
  if (contextUser !== undefined) {
    ctx.user = contextUser;
  }
  if (typeof req.ip === 'string') {
    ctx.ip = req.ip;
  }
  return ctx;
}

function toContextUser(user: UserLike): ConditionContext['user'] {
  const out: NonNullable<ConditionContext['user']> = {};
  const id = pickUserId(user);
  if (id !== undefined) {
    out._id = id;
    out.id = id;
  }
  if (typeof user.tenantId === 'string') {
    out.tenantId = user.tenantId;
  }
  return out;
}

function pickUserId(user: UserLike): string | undefined {
  if (typeof user._id === 'string') return user._id;
  if (typeof user.id === 'string') return user.id;
  // Mongoose ObjectId — `.toString()` is safe.
  if (
    user._id !== undefined &&
    user._id !== null &&
    typeof (user._id as { toString?: () => string }).toString === 'function'
  ) {
    return (user._id as { toString: () => string }).toString();
  }
  return undefined;
}

function pickRoleIds(user: UserLike): string[] {
  const raw = user.roles;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      out.push(item);
    } else if (item !== null && typeof item === 'object') {
      const maybe = (item as { _id?: unknown; id?: unknown })._id;
      if (typeof maybe === 'string') {
        out.push(maybe);
        continue;
      }
      const altId = (item as { _id?: unknown; id?: unknown }).id;
      if (typeof altId === 'string') {
        out.push(altId);
        continue;
      }
      if (
        maybe !== undefined &&
        maybe !== null &&
        typeof (maybe as { toString?: () => string }).toString === 'function'
      ) {
        out.push((maybe as { toString: () => string }).toString());
      }
    }
  }
  return out;
}

function pickPermissionIds(user: UserLike): string[] {
  const raw = user.permissions;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      out.push(item);
    } else if (item !== null && typeof item === 'object') {
      const maybe = (item as { _id?: unknown; id?: unknown })._id;
      if (typeof maybe === 'string') {
        out.push(maybe);
        continue;
      }
      const altId = (item as { _id?: unknown; id?: unknown }).id;
      if (typeof altId === 'string') {
        out.push(altId);
        continue;
      }
      if (
        maybe !== undefined &&
        maybe !== null &&
        typeof (maybe as { toString?: () => string }).toString === 'function'
      ) {
        out.push((maybe as { toString: () => string }).toString());
      }
    }
  }
  return out;
}
