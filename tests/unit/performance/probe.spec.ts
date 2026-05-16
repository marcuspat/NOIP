// Probe aggregate invariants.

import { Probe } from '../../../src/contexts/performance/domain/probe';
import { FixedClock } from '../../../src/shared/kernel';
import { ValidationError } from '../../../src/shared/errors';

describe('Probe aggregate', () => {
  const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));

  function make(): Probe {
    return Probe.create(
      {
        name: 'health',
        kind: 'http',
        target: 'https://example.test/health',
        schedule: { intervalMs: 30_000 },
        labels: { team: 'core' },
      },
      clock
    );
  }

  it('creates with sensible defaults', () => {
    const p = make();
    expect(p.id).toMatch(/[0-9a-f-]{36}/);
    expect(p.enabled).toBe(true);
    expect(p.sloId).toBeNull();
    expect(p.labels).toEqual({ team: 'core' });
    expect(p.createdAt).toBe(p.updatedAt);
  });

  it('rejects empty name', () => {
    expect(() =>
      Probe.create(
        {
          name: '   ',
          kind: 'http',
          target: 't',
          schedule: { intervalMs: 1 },
        },
        clock
      )
    ).toThrow(ValidationError);
  });

  it('rejects empty target', () => {
    expect(() =>
      Probe.create(
        {
          name: 'n',
          kind: 'http',
          target: '',
          schedule: { intervalMs: 1 },
        },
        clock
      )
    ).toThrow(ValidationError);
  });

  it('rejects non-positive intervalMs', () => {
    expect(() =>
      Probe.create(
        {
          name: 'n',
          kind: 'http',
          target: 't',
          schedule: { intervalMs: 0 },
        },
        clock
      )
    ).toThrow(ValidationError);
  });

  it('update changes target + bumps updatedAt', () => {
    const p = make();
    const ck = new FixedClock(new Date('2026-05-10T01:00:00.000Z'));
    p.update({ target: 'https://example.test/v2' }, ck);
    expect(p.target).toBe('https://example.test/v2');
    expect(p.updatedAt).not.toBe(p.createdAt);
  });

  it('update rejects empty fields', () => {
    const p = make();
    expect(() => p.update({ name: '   ' }, clock)).toThrow(ValidationError);
    expect(() => p.update({ target: '' }, clock)).toThrow(ValidationError);
    expect(() => p.update({ schedule: { intervalMs: -1 } }, clock)).toThrow(
      ValidationError
    );
  });

  it('round-trips persistence', () => {
    const p = make();
    const roundTripped = Probe.fromPersistence(p.toPersistence());
    expect(roundTripped.id).toBe(p.id);
    expect(roundTripped.target).toBe(p.target);
    expect(roundTripped.labels).toEqual(p.labels);
  });
});
