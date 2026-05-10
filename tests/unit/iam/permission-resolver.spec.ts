// Unit tests for `PermissionResolver`.
//
// Coverage:
//   - simple union (direct grants only)
//   - role hierarchy with two parents (diamond) yields no duplicates
//   - cycle detection (A → B → A) terminates
//   - cache hit returns the same shape we wrote
//   - role closure pulls each layer in a single batched round trip

import {
  PermissionResolver,
  type PermissionSpec,
} from '../../../src/services/iam/permission-resolver.service';
import { RedisPermissionCache } from '../../../src/services/iam/permission-cache';
import {
  CapturingLogger,
  FakeCacheRedis,
  FakePermissionRepository,
  FakeRoleRepository,
} from './_iam-stubs';

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

const PERM_READ_USER: PermissionSpec = {
  id: 'p-read-user',
  name: 'user.read',
  resource: 'user',
  action: 'read',
};
const PERM_WRITE_USER: PermissionSpec = {
  id: 'p-write-user',
  name: 'user.update',
  resource: 'user',
  action: 'update',
};
const PERM_READ_ROLE: PermissionSpec = {
  id: 'p-read-role',
  name: 'role.read',
  resource: 'role',
  action: 'read',
};
const PERM_DELETE_ROLE: PermissionSpec = {
  id: 'p-delete-role',
  name: 'role.delete',
  resource: 'role',
  action: 'delete',
};

describe('PermissionResolver.resolveEffective', () => {
  it('unions direct grants when no roles are present', async () => {
    const { resolver, permissions } = buildResolver();
    permissions.add(PERM_READ_USER);

    const set = await resolver.resolveEffective(
      'user-1',
      [],
      [PERM_READ_USER.id]
    );

    expect(set.userId).toBe('user-1');
    expect(set.permissions.size).toBe(1);
    expect(set.permissions.get('user.read')).toEqual(PERM_READ_USER);
  });

  it('unions role and direct permissions without duplicates', async () => {
    const { resolver, permissions, roles } = buildResolver();
    permissions.add(PERM_READ_USER);
    permissions.add(PERM_READ_ROLE);
    roles.add({
      id: 'r-viewer',
      name: 'viewer',
      permissions: [PERM_READ_USER.id, PERM_READ_ROLE.id],
    });

    const set = await resolver.resolveEffective(
      'user-1',
      ['r-viewer'],
      [PERM_READ_USER.id]
    );

    // Direct grant for `user.read` and the role grant for the same
    // (resource, action) collapse to a single map entry.
    expect(set.permissions.size).toBe(2);
    expect(set.permissions.has('user.read')).toBe(true);
    expect(set.permissions.has('role.read')).toBe(true);
  });

  it('flattens a diamond role hierarchy with no duplicates', async () => {
    const { resolver, permissions, roles } = buildResolver();
    permissions.add(PERM_READ_USER);
    permissions.add(PERM_WRITE_USER);
    permissions.add(PERM_READ_ROLE);
    permissions.add(PERM_DELETE_ROLE);

    // Diamond:  child  -> parentA, parentB
    //           parentA -> grandparent
    //           parentB -> grandparent
    roles.add({
      id: 'r-grandparent',
      name: 'grandparent',
      permissions: [PERM_READ_USER.id],
    });
    roles.add({
      id: 'r-parentA',
      name: 'parentA',
      permissions: [PERM_WRITE_USER.id],
      parentRoles: ['r-grandparent'],
    });
    roles.add({
      id: 'r-parentB',
      name: 'parentB',
      permissions: [PERM_READ_ROLE.id],
      parentRoles: ['r-grandparent'],
    });
    roles.add({
      id: 'r-child',
      name: 'child',
      permissions: [PERM_DELETE_ROLE.id],
      parentRoles: ['r-parentA', 'r-parentB'],
    });

    const set = await resolver.resolveEffective('u-2', ['r-child'], []);

    expect(set.permissions.size).toBe(4);
    expect(set.permissions.get('user.read')).toEqual(PERM_READ_USER);
    expect(set.permissions.get('user.update')).toEqual(PERM_WRITE_USER);
    expect(set.permissions.get('role.read')).toEqual(PERM_READ_ROLE);
    expect(set.permissions.get('role.delete')).toEqual(PERM_DELETE_ROLE);
  });

  it('issues one round trip per BFS layer (no per-role queries)', async () => {
    const { resolver, permissions, roles } = buildResolver();
    permissions.add(PERM_READ_USER);
    permissions.add(PERM_WRITE_USER);
    permissions.add(PERM_READ_ROLE);
    permissions.add(PERM_DELETE_ROLE);

    roles.add({
      id: 'r-grandparent',
      name: 'grandparent',
      permissions: [PERM_READ_USER.id],
    });
    roles.add({
      id: 'r-parentA',
      name: 'parentA',
      permissions: [PERM_WRITE_USER.id],
      parentRoles: ['r-grandparent'],
    });
    roles.add({
      id: 'r-parentB',
      name: 'parentB',
      permissions: [PERM_READ_ROLE.id],
      parentRoles: ['r-grandparent'],
    });
    roles.add({
      id: 'r-child',
      name: 'child',
      permissions: [PERM_DELETE_ROLE.id],
      parentRoles: ['r-parentA', 'r-parentB'],
    });

    await resolver.resolveEffective('u-2', ['r-child'], []);

    // Three BFS layers: [child], [parentA, parentB], [grandparent].
    expect(roles.findCalls.length).toBe(3);
    expect(roles.findCalls[0]).toEqual(['r-child']);
    expect(roles.findCalls[1]?.sort()).toEqual(['r-parentA', 'r-parentB']);
    expect(roles.findCalls[2]).toEqual(['r-grandparent']);
    // Permissions for the closure resolve in a single batched call.
    expect(permissions.findCalls.length).toBe(1);
  });

  it('survives a cycle (A → B → A) without looping', async () => {
    const { resolver, permissions, roles } = buildResolver();
    permissions.add(PERM_READ_USER);
    roles.add({
      id: 'r-a',
      name: 'a',
      permissions: [PERM_READ_USER.id],
      parentRoles: ['r-b'],
    });
    roles.add({
      id: 'r-b',
      name: 'b',
      permissions: [],
      parentRoles: ['r-a'], // cycle
    });

    const set = await resolver.resolveEffective('u-3', ['r-a'], []);

    expect(set.permissions.size).toBe(1);
    expect(set.permissions.get('user.read')).toEqual(PERM_READ_USER);
  });

  it('returns the same set shape on a cache hit', async () => {
    const { resolver, permissions } = buildResolver();
    permissions.add(PERM_READ_USER);

    const first = await resolver.resolveEffective(
      'u-4',
      [],
      [PERM_READ_USER.id]
    );
    const second = await resolver.resolveEffective(
      'u-4',
      [],
      [PERM_READ_USER.id]
    );

    expect(second.userId).toBe(first.userId);
    expect(second.permissions.size).toBe(first.permissions.size);
    expect(second.permissions.get('user.read')).toEqual(
      first.permissions.get('user.read')
    );
    expect(second.computedAt).toBe(first.computedAt);
  });

  it('does not call the role repository on a cache hit', async () => {
    const { resolver, permissions, roles } = buildResolver();
    permissions.add(PERM_READ_USER);
    roles.add({
      id: 'r-viewer',
      name: 'viewer',
      permissions: [PERM_READ_USER.id],
    });

    await resolver.resolveEffective('u-5', ['r-viewer'], []);
    const callsAfterFirst = roles.findCalls.length;

    await resolver.resolveEffective('u-5', ['r-viewer'], []);
    expect(roles.findCalls.length).toBe(callsAfterFirst);
  });
});

describe('PermissionResolver.check', () => {
  it('denies with permission-missing when the (resource,action) is absent', async () => {
    const { resolver, permissions } = buildResolver();
    permissions.add(PERM_READ_USER);

    const set = await resolver.resolveEffective('u-1', [], [PERM_READ_USER.id]);
    const decision = resolver.check(set, 'role', 'delete');
    expect(decision).toEqual({ kind: 'deny', reason: 'permission-missing' });
  });

  it('allows when the permission is present and unconditioned', async () => {
    const { resolver, permissions } = buildResolver();
    permissions.add(PERM_READ_USER);

    const set = await resolver.resolveEffective('u-1', [], [PERM_READ_USER.id]);
    expect(resolver.check(set, 'user', 'read')).toEqual({ kind: 'allow' });
  });

  it('allows when conditions are satisfied', async () => {
    const { resolver, permissions } = buildResolver();
    permissions.add({
      id: 'p-tenant-read',
      name: 'tenant.read',
      resource: 'tenant',
      action: 'read',
      conditions: { 'sameTenantAs(tenantId)': true },
    });

    const set = await resolver.resolveEffective('u-1', [], ['p-tenant-read']);
    const decision = resolver.check(set, 'tenant', 'read', {
      user: { _id: 'u-1', tenantId: 't-acme' },
      params: { tenantId: 't-acme' },
    });
    expect(decision).toEqual({ kind: 'allow' });
  });

  it('denies with the evaluator reason when conditions fail', async () => {
    const { resolver, permissions } = buildResolver();
    permissions.add({
      id: 'p-tenant-read',
      name: 'tenant.read',
      resource: 'tenant',
      action: 'read',
      conditions: { 'sameTenantAs(tenantId)': true },
    });

    const set = await resolver.resolveEffective('u-1', [], ['p-tenant-read']);
    const decision = resolver.check(set, 'tenant', 'read', {
      user: { _id: 'u-1', tenantId: 't-acme' },
      params: { tenantId: 't-other' },
    });
    expect(decision.kind).toBe('deny');
    if (decision.kind === 'deny') {
      expect(decision.reason).toBe('tenant-mismatch');
    }
  });
});

describe('PermissionResolver invalidation', () => {
  it('invalidateUser drops the cached entry only', async () => {
    const { resolver, permissions, redis } = buildResolver();
    permissions.add(PERM_READ_USER);

    await resolver.resolveEffective('u-1', [], [PERM_READ_USER.id]);
    await resolver.resolveEffective('u-2', [], [PERM_READ_USER.id]);
    expect(redis.size()).toBe(2);

    await resolver.invalidateUser('u-1');
    expect(redis.has('noip:cache:perm:u-1')).toBe(false);
    expect(redis.has('noip:cache:perm:u-2')).toBe(true);
  });

  it('invalidateRole drops every cached entry (no reverse index yet)', async () => {
    const { resolver, permissions, redis } = buildResolver();
    permissions.add(PERM_READ_USER);

    await resolver.resolveEffective('u-1', [], [PERM_READ_USER.id]);
    await resolver.resolveEffective('u-2', [], [PERM_READ_USER.id]);
    expect(redis.size()).toBe(2);

    await resolver.invalidateRole('r-anything');
    expect(redis.size()).toBe(0);
  });

  it('invalidateAll drops everything', async () => {
    const { resolver, permissions, redis } = buildResolver();
    permissions.add(PERM_READ_USER);
    await resolver.resolveEffective('u-1', [], [PERM_READ_USER.id]);
    await resolver.resolveEffective('u-2', [], [PERM_READ_USER.id]);

    await resolver.invalidateAll();
    expect(redis.size()).toBe(0);
  });
});
