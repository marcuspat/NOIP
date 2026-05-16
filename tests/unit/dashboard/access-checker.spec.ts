// AccessChecker — pure logic, no I/O.

import { AccessChecker } from '../../../src/contexts/dashboard/application/access-checker';
import { Dashboard } from '../../../src/contexts/dashboard/domain/dashboard';
import { FixedClock, type UserId } from '../../../src/shared/kernel';

const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));

function dashboard(opts: {
  ownerId: string;
  visibility: 'private' | 'role-scoped' | 'organisation';
  roles?: ReadonlyArray<string>;
}): Dashboard {
  return Dashboard.create(
    {
      name: 'd',
      layout: 'grid',
      ownedBy: { userId: opts.ownerId as UserId },
      share:
        opts.visibility === 'role-scoped'
          ? { visibility: 'role-scoped', roles: opts.roles ?? ['viewer'] }
          : { visibility: opts.visibility },
    },
    clock
  );
}

describe('AccessChecker', () => {
  const checker = new AccessChecker();

  it('owner always reads a private dashboard', () => {
    const d = dashboard({ ownerId: 'u1', visibility: 'private' });
    expect(checker.canRead(d, { userId: 'u1' as UserId })).toBe(true);
  });

  it('non-owner cannot read a private dashboard', () => {
    const d = dashboard({ ownerId: 'u1', visibility: 'private' });
    expect(checker.canRead(d, { userId: 'u2' as UserId })).toBe(false);
  });

  it('anyone authenticated can read an organisation-wide dashboard', () => {
    const d = dashboard({ ownerId: 'u1', visibility: 'organisation' });
    expect(checker.canRead(d, { userId: 'u2' as UserId })).toBe(true);
  });

  it('role-scoped dashboard requires at least one matching role', () => {
    const d = dashboard({
      ownerId: 'u1',
      visibility: 'role-scoped',
      roles: ['viewer', 'admin'],
    });
    expect(
      checker.canRead(d, {
        userId: 'u2' as UserId,
        roles: ['admin'],
      })
    ).toBe(true);
    expect(
      checker.canRead(d, {
        userId: 'u3' as UserId,
        roles: ['other'],
      })
    ).toBe(false);
    expect(checker.canRead(d, { userId: 'u3' as UserId })).toBe(false);
  });

  it('unauthenticated principal always denied', () => {
    const d = dashboard({ ownerId: 'u1', visibility: 'organisation' });
    expect(checker.canRead(d, null)).toBe(false);
  });

  it('canWrite restricts to the owner regardless of share', () => {
    const d = dashboard({ ownerId: 'u1', visibility: 'organisation' });
    expect(checker.canWrite(d, { userId: 'u1' as UserId })).toBe(true);
    expect(checker.canWrite(d, { userId: 'u2' as UserId })).toBe(false);
    expect(checker.canWrite(d, null)).toBe(false);
  });

  it('policyAllows is callable directly without an aggregate', () => {
    expect(
      checker.policyAllows(
        { visibility: 'role-scoped', roles: ['a'] },
        { userId: 'u' as UserId, roles: ['a'] }
      )
    ).toBe(true);
    expect(
      checker.policyAllows(
        { visibility: 'role-scoped', roles: ['a'] },
        { userId: 'u' as UserId, roles: [] }
      )
    ).toBe(false);
    expect(
      checker.policyAllows(
        { visibility: 'private' },
        {
          userId: 'u' as UserId,
        }
      )
    ).toBe(false);
  });
});
