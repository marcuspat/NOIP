// ComplianceReport aggregate invariants — sign immutability.

import { ComplianceReport } from '../../../src/contexts/security/domain/compliance-report';
import {
  FixedClock,
  newId,
  type ClusterId,
  type UserId,
} from '../../../src/shared/kernel';
import { ValidationError } from '../../../src/shared/errors';

describe('ComplianceReport aggregate', () => {
  const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));

  function generate(): ComplianceReport {
    return ComplianceReport.generate(
      {
        framework: 'SOC2',
        scope: { clusterId: newId<ClusterId>() },
        controls: [],
        overall: { score: 100, pass: 0, fail: 0, partial: 0, na: 0, total: 0 },
      },
      clock
    );
  }

  it('generate() is in draft and emits compliance.report.generated', () => {
    const r = generate();
    expect(r.status).toBe('draft');
    const events = r.drainEvents();
    expect(events.map(e => e.type)).toEqual(['compliance.report.generated']);
  });

  it('signing locks the report and emits compliance.report.signed', () => {
    const r = generate();
    r.drainEvents();
    const userId = newId<UserId>();
    r.sign(userId, clock);
    expect(r.status).toBe('signed');
    expect(r.isImmutable()).toBe(true);
    expect(r.signedBy?.userId).toBe(userId);
    const events = r.drainEvents();
    expect(events.map(e => e.type)).toEqual(['compliance.report.signed']);
  });

  it('cannot sign twice', () => {
    const r = generate();
    const userId = newId<UserId>();
    r.sign(userId, clock);
    expect(() => r.sign(userId, clock)).toThrow(ValidationError);
  });

  it('expire() emits compliance.report.expired and is idempotent', () => {
    const r = generate();
    r.drainEvents();
    r.expire(clock);
    expect(r.status).toBe('expired');
    const events = r.drainEvents();
    expect(events.map(e => e.type)).toEqual(['compliance.report.expired']);
    r.expire(clock);
    expect(r.drainEvents()).toHaveLength(0);
  });

  it('cannot sign an expired report', () => {
    const r = generate();
    r.expire(clock);
    expect(() => r.sign(newId<UserId>(), clock)).toThrow(ValidationError);
  });

  it('persistence round-trips', () => {
    const r = generate();
    const reloaded = ComplianceReport.fromPersistence(r.toPersistence());
    expect(reloaded.id).toBe(r.id);
    expect(reloaded.framework).toBe('SOC2');
  });
});
