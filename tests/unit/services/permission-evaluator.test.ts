import {
  evaluateConditions,
  findGrantingPermission,
  allowedConditionKeys,
  PermissionContext,
} from '../../../src/services/permission-evaluator.service';
import type { Permission } from '../../../src/types/auth.types';

const baseCtx: PermissionContext = {
  user: { id: 'u1', tenantId: 't1', roles: ['analyst'] },
  resource: { id: 'r1', tenantId: 't1', ownerId: 'u1', kind: 'cluster' },
};

const mkPerm = (overrides: Partial<Permission> = {}): Permission =>
  ({
    _id: 'p1',
    name: 'test',
    resource: 'cluster',
    action: 'read',
    description: '',
    isSystem: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as Permission;

describe('evaluateConditions', () => {
  it('returns allowed=true when conditions are undefined', () => {
    expect(evaluateConditions(undefined, baseCtx).allowed).toBe(true);
  });

  it('returns allowed=true when conditions are empty', () => {
    expect(evaluateConditions({}, baseCtx).allowed).toBe(true);
  });

  it('passes when a user-tenant condition matches', () => {
    const r = evaluateConditions({ '$user.tenantId': 't1' }, baseCtx);
    expect(r.allowed).toBe(true);
  });

  it('fails with condition_mismatch when user-tenant does not match', () => {
    const r = evaluateConditions({ '$user.tenantId': 't2' }, baseCtx);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/condition_mismatch/);
  });

  it('rejects unknown condition keys (allow-list)', () => {
    const r = evaluateConditions(
      { '$user.isSuper': true } as Record<string, unknown>,
      baseCtx
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('unknown_condition_key:$user.isSuper');
  });

  it('rejects condition_unresolved when context is missing the key', () => {
    const ctx = { user: { id: 'u1' } } as PermissionContext;
    const r = evaluateConditions({ '$user.tenantId': 't1' }, ctx);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('condition_unresolved:$user.tenantId');
  });

  it('AND-conjuncts multiple conditions', () => {
    const ok = evaluateConditions(
      { '$user.tenantId': 't1', '$resource.kind': 'cluster' },
      baseCtx
    );
    expect(ok.allowed).toBe(true);
    const bad = evaluateConditions(
      { '$user.tenantId': 't1', '$resource.kind': 'secret' },
      baseCtx
    );
    expect(bad.allowed).toBe(false);
  });

  it('the allow-list is the set of $-prefixed keys exposed for tooling', () => {
    expect(allowedConditionKeys()).toEqual(
      expect.arrayContaining([
        '$user.id',
        '$user.tenantId',
        '$resource.id',
        '$resource.tenantId',
        '$resource.ownerId',
        '$resource.kind',
      ])
    );
  });

  it('refuses operator-shaped conditions (no DSL allowed)', () => {
    const r = evaluateConditions(
      { '$user.tenantId': { $eq: 't1' } } as Record<string, unknown>,
      baseCtx
    );
    expect(r.allowed).toBe(false);
  });
});

describe('findGrantingPermission', () => {
  it('finds an exact-match permission', () => {
    const perms = [mkPerm()];
    const r = findGrantingPermission(perms, 'cluster', 'read', baseCtx);
    expect(r?.permission._id).toBe('p1');
  });

  it("treats '*' as wildcard on resource and action", () => {
    const perms = [mkPerm({ resource: '*', action: '*' })];
    expect(findGrantingPermission(perms, 'cluster', 'read', baseCtx)).toBeTruthy();
    expect(findGrantingPermission(perms, 'secret', 'delete', baseCtx)).toBeTruthy();
  });

  it('skips a permission whose conditions fail', () => {
    const perms = [
      mkPerm({ _id: 'p1', conditions: { '$user.tenantId': 'other' } }),
      mkPerm({ _id: 'p2' }),
    ];
    const r = findGrantingPermission(perms, 'cluster', 'read', baseCtx);
    expect(r?.permission._id).toBe('p2');
  });

  it('returns null if none match', () => {
    const perms = [mkPerm({ resource: 'secret', action: 'read' })];
    expect(findGrantingPermission(perms, 'cluster', 'read', baseCtx)).toBeNull();
  });
});
