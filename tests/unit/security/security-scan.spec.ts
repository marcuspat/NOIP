// SecurityScan aggregate invariants.

import { SecurityScan } from '../../../src/contexts/security/domain/security-scan';
import { asPolicyVersion } from '../../../src/contexts/security/domain/value-objects';
import {
  FixedClock,
  newId,
  type ClusterId,
  type SnapshotId,
} from '../../../src/shared/kernel';
import { ValidationError } from '../../../src/shared/errors';

describe('SecurityScan aggregate', () => {
  const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));

  function start(): SecurityScan {
    return SecurityScan.start(
      {
        scope: { clusterId: newId<ClusterId>() },
        snapshot: {
          id: newId<SnapshotId>(),
          clusterId: newId<ClusterId>(),
          hash: 'abc',
          takenAt: clock.nowInstant(),
        },
        policyVersion: asPolicyVersion(1),
        profile: { id: 'default', enabledCheckIds: [] },
      },
      clock
    );
  }

  it('starts in running status and emits security.scan.started', () => {
    const scan = start();
    expect(scan.status).toBe('running');
    const events = scan.drainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('security.scan.started');
  });

  it('completes once and emits security.scan.completed', () => {
    const scan = start();
    scan.drainEvents();
    scan.complete(
      { total: 3, critical: 1, high: 1, medium: 1, low: 0 },
      80,
      clock
    );
    expect(scan.status).toBe('succeeded');
    expect(scan.score).toBe(80);
    expect(scan.isCompleted()).toBe(true);
    const events = scan.drainEvents();
    expect(events.map(e => e.type)).toEqual(['security.scan.completed']);
  });

  it('refuses double completion', () => {
    const scan = start();
    scan.complete(
      { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
      100,
      clock
    );
    expect(() =>
      scan.complete(
        { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
        100,
        clock
      )
    ).toThrow(ValidationError);
  });

  it('fail() emits security.scan.failed', () => {
    const scan = start();
    scan.drainEvents();
    scan.fail({ code: 'PROVIDER_ERROR', message: 'boom' }, clock);
    expect(scan.status).toBe('failed');
    const events = scan.drainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('security.scan.failed');
  });

  it('round-trips persistence', () => {
    const scan = start();
    scan.complete(
      { total: 1, critical: 0, high: 1, medium: 0, low: 0 },
      90,
      clock
    );
    const json = scan.toPersistence();
    const reloaded = SecurityScan.fromPersistence(json);
    expect(reloaded.id).toBe(scan.id);
    expect(reloaded.score).toBe(90);
    expect(reloaded.status).toBe('succeeded');
  });
});
