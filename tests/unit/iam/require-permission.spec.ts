// Unit tests for `requirePermission` middleware.
//
// Coverage:
//   - missing req.user           → UnauthorizedError
//   - missing permission         → ForbiddenError with deny reason
//   - allow path                 → next() with no error
//   - resolver invocation        → resolver.check called with the
//                                   advertised resource/action

import type { Request, Response, NextFunction } from 'express';

import { ForbiddenError, UnauthorizedError } from '../../../src/shared/errors';
import {
  requirePermission,
  resetRequirePermissionDefaults,
  setDefaultPermissionResolver,
  setDefaultRequirePermissionLogger,
} from '../../../src/middleware/require-permission.middleware';
import { authzChecksTotal } from '../../../src/observability/metrics';
import {
  PermissionResolver,
  type AuthorizationDecision,
  type EffectivePermissionSet,
  type PermissionSpec,
} from '../../../src/services/iam/permission-resolver.service';
import { RedisPermissionCache } from '../../../src/services/iam/permission-cache';
import { asInstant } from '../../../src/shared/kernel';
import {
  CapturingLogger,
  FakeCacheRedis,
  FakePermissionRepository,
  FakeRoleRepository,
} from './_iam-stubs';

const PERM_USER_READ: PermissionSpec = {
  id: 'p-user-read',
  name: 'user.read',
  resource: 'user',
  action: 'read',
};

function buildResolver() {
  const roles = new FakeRoleRepository();
  const permissions = new FakePermissionRepository();
  const redis = new FakeCacheRedis();
  const logger = new CapturingLogger();
  const cache = new RedisPermissionCache({ redis, logger });
  const resolver = new PermissionResolver({
    roles,
    permissions,
    cache,
    logger,
  });
  return { roles, permissions, redis, logger, cache, resolver };
}

interface SpyResult {
  err?: unknown;
  called: boolean;
}

function makeNext(): { next: NextFunction; result: SpyResult } {
  const result: SpyResult = { called: false };
  const next: NextFunction = (err?: unknown) => {
    result.called = true;
    if (err !== undefined) result.err = err;
  };
  return { next, result };
}

function fakeReq(overrides: Partial<Request> = {}): Request {
  return {
    params: {},
    query: {},
    body: {},
    ip: '127.0.0.1',
    ...overrides,
  } as unknown as Request;
}

const noopRes = {} as unknown as Response;

describe('requirePermission', () => {
  afterEach(() => {
    resetRequirePermissionDefaults();
  });

  it('throws UnauthorizedError when req.user is missing', async () => {
    const { resolver } = buildResolver();
    const handler = requirePermission('user', 'read', { resolver });
    const { next, result } = makeNext();

    await handler(fakeReq(), noopRes, next);

    expect(result.called).toBe(true);
    expect(result.err).toBeInstanceOf(UnauthorizedError);
  });

  it('throws ForbiddenError with the deny reason when permission missing', async () => {
    const { resolver, permissions } = buildResolver();
    permissions.add(PERM_USER_READ);

    const handler = requirePermission('role', 'delete', { resolver });
    const { next, result } = makeNext();

    const req = fakeReq({
      // typed loosely on purpose — the middleware reads req.user dynamically
    });
    (req as unknown as { user: unknown }).user = {
      _id: 'u-1',
      roles: [],
      permissions: [PERM_USER_READ.id],
    };

    await handler(req, noopRes, next);

    expect(result.called).toBe(true);
    expect(result.err).toBeInstanceOf(ForbiddenError);
    const err = result.err as ForbiddenError;
    expect(err.code).toBe('FORBIDDEN');
    expect(err.statusCode).toBe(403);
    expect(err.details).toEqual({
      resource: 'role',
      action: 'delete',
      reason: 'permission-missing',
    });
  });

  it('calls next() with no error on allow', async () => {
    const { resolver, permissions } = buildResolver();
    permissions.add(PERM_USER_READ);

    const handler = requirePermission('user', 'read', { resolver });
    const { next, result } = makeNext();

    const req = fakeReq();
    (req as unknown as { user: unknown }).user = {
      _id: 'u-1',
      roles: [],
      permissions: [PERM_USER_READ.id],
    };

    await handler(req, noopRes, next);
    expect(result.called).toBe(true);
    expect(result.err).toBeUndefined();
  });

  it('forwards the configured resource/action to resolver.check', async () => {
    // We swap in a spy resolver that records the check arguments and
    // forces an allow.
    const { resolver: real, permissions } = buildResolver();
    permissions.add(PERM_USER_READ);
    const checkCalls: Array<{
      set: EffectivePermissionSet;
      resource: string;
      action: string;
    }> = [];
    const spy: PermissionResolver = Object.assign(Object.create(real), {
      resolveEffective: real.resolveEffective.bind(real),
      check: (
        set: EffectivePermissionSet,
        resource: string,
        action: string
      ): AuthorizationDecision => {
        checkCalls.push({ set, resource, action });
        return { kind: 'allow' };
      },
      invalidateUser: real.invalidateUser.bind(real),
      invalidateRole: real.invalidateRole.bind(real),
      invalidateAll: real.invalidateAll.bind(real),
    });

    const handler = requirePermission('user', 'read', { resolver: spy });
    const { next } = makeNext();
    const req = fakeReq();
    (req as unknown as { user: unknown }).user = {
      _id: 'u-spy',
      roles: [],
      permissions: [PERM_USER_READ.id],
    };
    await handler(req, noopRes, next);

    expect(checkCalls).toHaveLength(1);
    const call = checkCalls[0]!;
    expect(call.resource).toBe('user');
    expect(call.action).toBe('read');
    expect(call.set.userId).toBe('u-spy');
  });

  it('throws Unauthorized when no resolver is configured', async () => {
    const handler = requirePermission('user', 'read');
    const { next, result } = makeNext();
    const req = fakeReq();
    (req as unknown as { user: unknown }).user = {
      _id: 'u-1',
      roles: [],
      permissions: [],
    };

    await handler(req, noopRes, next);
    expect(result.err).toBeInstanceOf(UnauthorizedError);
  });

  it('uses the module-level default resolver when none is passed', async () => {
    const { resolver, permissions } = buildResolver();
    permissions.add(PERM_USER_READ);
    setDefaultPermissionResolver(resolver);

    const handler = requirePermission('user', 'read');
    const { next, result } = makeNext();
    const req = fakeReq();
    (req as unknown as { user: unknown }).user = {
      _id: 'u-1',
      roles: [],
      permissions: [PERM_USER_READ.id],
    };

    await handler(req, noopRes, next);
    expect(result.err).toBeUndefined();
  });

  it('emits the authz counter through the logger', async () => {
    const { resolver, permissions } = buildResolver();
    permissions.add(PERM_USER_READ);
    const logger = new CapturingLogger();
    setDefaultRequirePermissionLogger(logger);

    const handler = requirePermission('user', 'read', { resolver });
    const { next } = makeNext();
    const req = fakeReq();
    (req as unknown as { user: unknown }).user = {
      _id: 'u-1',
      roles: [],
      permissions: [PERM_USER_READ.id],
    };

    await handler(req, noopRes, next);
    const counter = logger.events.find(
      e => e.message === 'noip.authz.checks.total'
    );
    expect(counter).toBeDefined();
    expect(counter!.meta).toMatchObject({
      decision: 'allow',
      resource: 'user',
      action: 'read',
    });
  });

  it('builds the default condition context from req.params/query/body/ip', async () => {
    const { resolver, permissions } = buildResolver();
    permissions.add({
      id: 'p-tenant-read',
      name: 'tenant.read',
      resource: 'tenant',
      action: 'read',
      conditions: { 'sameTenantAs(tenantId)': true },
    });

    const handler = requirePermission('tenant', 'read', { resolver });
    const { next, result } = makeNext();

    // Allow path — params.tenantId equals user.tenantId.
    const reqAllow = fakeReq({
      params: { tenantId: 't-acme' } as Request['params'],
    });
    (reqAllow as unknown as { user: unknown }).user = {
      _id: 'u-1',
      tenantId: 't-acme',
      roles: [],
      permissions: ['p-tenant-read'],
    };
    await handler(reqAllow, noopRes, next);
    expect(result.err).toBeUndefined();

    // Deny path — params.tenantId differs.
    const { next: next2, result: result2 } = makeNext();
    const reqDeny = fakeReq({
      params: { tenantId: 't-other' } as Request['params'],
    });
    (reqDeny as unknown as { user: unknown }).user = {
      _id: 'u-1',
      tenantId: 't-acme',
      roles: [],
      permissions: ['p-tenant-read'],
    };
    await handler(reqDeny, noopRes, next2);
    expect(result2.err).toBeInstanceOf(ForbiddenError);
    expect((result2.err as ForbiddenError).details).toMatchObject({
      reason: 'tenant-mismatch',
    });
  });

  it('honours an explicit contextFn override', async () => {
    const { resolver, permissions } = buildResolver();
    permissions.add({
      id: 'p-tenant-read',
      name: 'tenant.read',
      resource: 'tenant',
      action: 'read',
      conditions: { 'sameTenantAs(tenantId)': true },
    });

    let contextFnCalled = 0;
    const handler = requirePermission('tenant', 'read', {
      resolver,
      contextFn: req => {
        contextFnCalled += 1;
        return {
          user: { _id: 'u-1', tenantId: 't-acme' },
          params: { tenantId: 't-acme' },
          query: req.query as Record<string, unknown>,
          body: req.body as Record<string, unknown>,
        };
      },
    });

    const { next, result } = makeNext();
    const req = fakeReq();
    (req as unknown as { user: unknown }).user = {
      _id: 'u-1',
      tenantId: 't-acme',
      roles: [],
      permissions: ['p-tenant-read'],
    };
    await handler(req, noopRes, next);

    expect(contextFnCalled).toBe(1);
    expect(result.err).toBeUndefined();
  });

  it('fires noip_authz_checks_total{decision,resource,action} on each decision (ADR-0023)', async () => {
    const { resolver, permissions } = buildResolver();
    permissions.add(PERM_USER_READ);
    const before = readAuthzCounter('allow', 'user', 'read');

    const handler = requirePermission('user', 'read', { resolver });
    const { next } = makeNext();
    const req = fakeReq();
    (req as unknown as { user: unknown }).user = {
      _id: 'u-metric',
      roles: [],
      permissions: ['p-user-read'],
    };
    await handler(req, noopRes, next);

    const after = readAuthzCounter('allow', 'user', 'read');
    expect(after - before).toBe(1);
  });
});

function readAuthzCounter(
  decision: string,
  resource: string,
  action: string
): number {
  const hashMap = (
    authzChecksTotal as unknown as {
      hashMap: Record<
        string,
        { labels: Record<string, string>; value: number }
      >;
    }
  ).hashMap;
  for (const entry of Object.values(hashMap)) {
    if (
      entry.labels['decision'] === decision &&
      entry.labels['resource'] === resource &&
      entry.labels['action'] === action
    ) {
      return entry.value;
    }
  }
  return 0;
}
