// Boundary tests for the MFA grace-period helper (ADR-0009).

import {
  isMFAGracePeriodActive,
  mfaGraceRemainingMs,
} from '../../../src/utils/auth/mfa-grace-period';

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

describe('isMFAGracePeriodActive', () => {
  it('returns true for a brand-new user without MFA', () => {
    const created = new Date('2026-01-01T00:00:00Z');
    const now = new Date(created.getTime() + 60_000);
    expect(
      isMFAGracePeriodActive({ createdAt: created, mfaEnabled: false }, now)
    ).toBe(true);
  });

  it('returns true at the start of the window (delta === 0)', () => {
    const created = new Date('2026-01-01T00:00:00Z');
    expect(
      isMFAGracePeriodActive(
        { createdAt: created, mfaEnabled: false },
        new Date(created.getTime())
      )
    ).toBe(true);
  });

  it('returns false at exactly the boundary (now === created + grace)', () => {
    const created = new Date('2026-01-01T00:00:00Z');
    const at = new Date(created.getTime() + SEVEN_DAYS);
    expect(
      isMFAGracePeriodActive({ createdAt: created, mfaEnabled: false }, at)
    ).toBe(false);
  });

  it('returns false past the boundary', () => {
    const created = new Date('2026-01-01T00:00:00Z');
    const after = new Date(created.getTime() + SEVEN_DAYS + 1);
    expect(
      isMFAGracePeriodActive({ createdAt: created, mfaEnabled: false }, after)
    ).toBe(false);
  });

  it('returns false when MFA is already enabled', () => {
    const created = new Date('2026-01-01T00:00:00Z');
    expect(
      isMFAGracePeriodActive(
        { createdAt: created, mfaEnabled: true },
        new Date(created.getTime() + 60_000)
      )
    ).toBe(false);
  });

  it('honours an override gracePeriodMs', () => {
    const created = new Date('2026-01-01T00:00:00Z');
    expect(
      isMFAGracePeriodActive(
        { createdAt: created, mfaEnabled: false },
        new Date(created.getTime() + 2_000),
        { gracePeriodMs: 1_000 }
      )
    ).toBe(false);
  });

  it('returns false on an invalid createdAt', () => {
    expect(
      isMFAGracePeriodActive(
        { createdAt: 'not-a-date', mfaEnabled: false },
        new Date()
      )
    ).toBe(false);
  });

  it('accepts numeric epoch and ISO string forms', () => {
    const createdMs = Date.parse('2026-01-01T00:00:00Z');
    expect(
      isMFAGracePeriodActive(
        { createdAt: createdMs, mfaEnabled: false },
        new Date(createdMs + 60_000)
      )
    ).toBe(true);
    expect(
      isMFAGracePeriodActive(
        { createdAt: '2026-01-01T00:00:00Z', mfaEnabled: false },
        new Date(createdMs + 60_000)
      )
    ).toBe(true);
  });
});

describe('mfaGraceRemainingMs', () => {
  it('reports remaining ms inside the window', () => {
    const created = new Date('2026-01-01T00:00:00Z');
    const offset = 60_000;
    const now = new Date(created.getTime() + offset);
    expect(
      mfaGraceRemainingMs({ createdAt: created, mfaEnabled: false }, now)
    ).toBe(SEVEN_DAYS - offset);
  });

  it('returns 0 past the window', () => {
    const created = new Date('2026-01-01T00:00:00Z');
    const now = new Date(created.getTime() + SEVEN_DAYS + 5_000);
    expect(
      mfaGraceRemainingMs({ createdAt: created, mfaEnabled: false }, now)
    ).toBe(0);
  });

  it('returns 0 if MFA is already enabled', () => {
    const created = new Date('2026-01-01T00:00:00Z');
    expect(
      mfaGraceRemainingMs(
        { createdAt: created, mfaEnabled: true },
        new Date(created.getTime() + 1_000)
      )
    ).toBe(0);
  });
});
