// Finding aggregate invariants.

import {
  Finding,
  fingerprintFor,
} from '../../../src/contexts/security/domain/finding';
import { asPolicyVersion } from '../../../src/contexts/security/domain/value-objects';
import {
  FixedClock,
  newId,
  type ClusterId,
  type Instant,
  type PolicyId,
  type ScanId,
  type UserId,
} from '../../../src/shared/kernel';
import { ValidationError } from '../../../src/shared/errors';

describe('Finding aggregate', () => {
  const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
  const policyId = newId<PolicyId>();
  const userId = newId<UserId>();

  function open(): Finding {
    return Finding.open(
      {
        scanId: newId<ScanId>(),
        scope: { clusterId: newId<ClusterId>() },
        resource: {
          apiVersion: 'v1',
          kind: 'Pod',
          name: 'web-1',
          namespace: 'default',
        },
        policyId,
        policyVersion: asPolicyVersion(1),
        severity: 'high',
        description: 'something bad',
        evidence: {
          source: 'builtin',
          summary: 'matched',
          capturedAt: clock.nowInstant(),
        },
      },
      clock
    );
  }

  it('opens in open status and emits security.finding.opened', () => {
    const f = open();
    expect(f.status).toBe('open');
    const events = f.drainEvents();
    expect(events.map(e => e.type)).toEqual(['security.finding.opened']);
  });

  it('fingerprint is stable for (policyId, kind, ns, name)', () => {
    const a = fingerprintFor(policyId, {
      apiVersion: 'v1',
      kind: 'Pod',
      name: 'web',
      namespace: 'ns',
    });
    const b = fingerprintFor(policyId, {
      apiVersion: 'v1',
      kind: 'Pod',
      name: 'web',
      namespace: 'ns',
    });
    expect(a).toBe(b);
  });

  describe('lifecycle', () => {
    it('acknowledge → suppressed only via suppress()', () => {
      const f = open();
      f.acknowledge(userId, 'on it', clock);
      expect(f.status).toBe('acknowledged');
      // can't acknowledge twice
      expect(() => f.acknowledge(userId, undefined, clock)).toThrow(
        ValidationError
      );
    });

    it('suppress requires expiry and justification', () => {
      const f = open();
      const future = '2026-06-10T00:00:00.000Z' as Instant;
      expect(() => f.suppress(userId, future, '', clock)).toThrow(
        ValidationError
      );
      expect(() => f.suppress(userId, '' as Instant, 'because', clock)).toThrow(
        ValidationError
      );
      expect(() =>
        f.suppress(userId, '2026-04-01T00:00:00.000Z' as Instant, 'past', clock)
      ).toThrow(ValidationError);
      f.suppress(userId, future, 'risk-accepted', clock);
      expect(f.status).toBe('suppressed');
      expect(f.suppressedUntil).toBe(future);
      expect(f.suppressionJustification).toBe('risk-accepted');
    });

    it('resolve is idempotent', () => {
      const f = open();
      f.resolve(userId, clock);
      expect(f.status).toBe('resolved');
      // a second resolve drops silently
      f.resolve(userId, clock);
      expect(f.status).toBe('resolved');
    });

    it('touching a resolved finding throws', () => {
      const f = open();
      f.resolve(userId, clock);
      expect(() => f.touch(newId<ScanId>(), clock)).toThrow(ValidationError);
    });

    it('suppressing a resolved finding throws', () => {
      const f = open();
      f.resolve(userId, clock);
      expect(() =>
        f.suppress(userId, '2027-01-01T00:00:00.000Z' as Instant, 'why', clock)
      ).toThrow(ValidationError);
    });
  });

  it('persistence round-trip preserves status and lifecycle stamps', () => {
    const f = open();
    f.acknowledge(userId, 'note', clock);
    const reloaded = Finding.fromPersistence(f.toPersistence());
    expect(reloaded.id).toBe(f.id);
    expect(reloaded.status).toBe('acknowledged');
    expect(reloaded.acknowledgedBy).toBe(userId);
    expect(reloaded.fingerprint).toBe(f.fingerprint);
  });
});
