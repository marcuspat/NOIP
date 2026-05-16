import { RetentionPolicy } from '../../../../src/contexts/audit/domain/retention-policy';
import type { PolicyId } from '../../../../src/shared/kernel';

describe('RetentionPolicy', () => {
  it('rejects archiveAfterDays > retentionDays', () => {
    expect(() =>
      RetentionPolicy.create({
        id: 'p-1' as PolicyId,
        collection: 'auditLogs',
        archiveAfterDays: 200,
        retentionDays: 100,
        immutable: false,
      })
    ).toThrow(/archiveAfterDays must be <= retentionDays/);
  });

  it('rejects non-positive windows', () => {
    expect(() =>
      RetentionPolicy.create({
        id: 'p-2' as PolicyId,
        collection: 'auditLogs',
        archiveAfterDays: 0,
        retentionDays: 30,
        immutable: false,
      })
    ).toThrow(/archiveAfterDays must be a positive number/);
    expect(() =>
      RetentionPolicy.create({
        id: 'p-3' as PolicyId,
        collection: 'auditLogs',
        archiveAfterDays: 10,
        retentionDays: 0,
        immutable: false,
      })
    ).toThrow(/retentionDays must be a positive number/);
  });

  it('allows mutable policies to loosen retention', () => {
    const p = RetentionPolicy.create({
      id: 'p-4' as PolicyId,
      collection: 'auditLogs',
      archiveAfterDays: 30,
      retentionDays: 90,
      immutable: false,
    });
    const next = p.tighten({ retentionDays: 60 });
    expect(next.retentionDays).toBe(60);
  });

  it('forbids loosening an immutable policy (shorter retention)', () => {
    const p = RetentionPolicy.create({
      id: 'p-5' as PolicyId,
      collection: 'auditLogs',
      archiveAfterDays: 30,
      retentionDays: 90,
      immutable: true,
    });
    expect(() => p.tighten({ retentionDays: 60 })).toThrow(
      /retentionDays may only increase/
    );
  });

  it('forbids loosening an immutable policy (later archive)', () => {
    const p = RetentionPolicy.create({
      id: 'p-6' as PolicyId,
      collection: 'auditLogs',
      archiveAfterDays: 30,
      retentionDays: 90,
      immutable: true,
    });
    expect(() => p.tighten({ archiveAfterDays: 60 })).toThrow(
      /archiveAfterDays may only decrease/
    );
  });

  it('allows tightening an immutable policy (longer retention)', () => {
    const p = RetentionPolicy.create({
      id: 'p-7' as PolicyId,
      collection: 'auditLogs',
      archiveAfterDays: 30,
      retentionDays: 90,
      immutable: true,
    });
    const next = p.tighten({ retentionDays: 365 });
    expect(next.retentionDays).toBe(365);
    expect(next.archiveAfterDays).toBe(30);
    expect(next.immutable).toBe(true);
  });

  it('allows tightening an immutable policy (earlier archive)', () => {
    const p = RetentionPolicy.create({
      id: 'p-8' as PolicyId,
      collection: 'auditLogs',
      archiveAfterDays: 30,
      retentionDays: 90,
      immutable: true,
    });
    const next = p.tighten({ archiveAfterDays: 15 });
    expect(next.archiveAfterDays).toBe(15);
  });

  it('round-trips via toJSON', () => {
    const p = RetentionPolicy.create({
      id: 'p-9' as PolicyId,
      collection: 'securityEvents',
      archiveAfterDays: 7,
      retentionDays: 30,
      immutable: false,
    });
    const json = p.toJSON();
    expect(json).toEqual({
      id: 'p-9',
      collection: 'securityEvents',
      archiveAfterDays: 7,
      retentionDays: 30,
      immutable: false,
    });
  });

  it('re-enforces invariants on tightened proposals', () => {
    const p = RetentionPolicy.create({
      id: 'p-10' as PolicyId,
      collection: 'auditLogs',
      archiveAfterDays: 30,
      retentionDays: 90,
      immutable: false,
    });
    // proposed archiveAfterDays > retentionDays after edits → reject
    expect(() => p.tighten({ archiveAfterDays: 95 })).toThrow(
      /archiveAfterDays must be <= retentionDays/
    );
  });
});
