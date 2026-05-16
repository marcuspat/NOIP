// Report aggregate unit tests.

import { Report } from '../../../src/contexts/dashboard/domain/report';
import { FixedClock, type UserId } from '../../../src/shared/kernel';
import { ValidationError } from '../../../src/shared/errors';

const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));

describe('Report aggregate', () => {
  function queue(overrides: Partial<Parameters<typeof Report.queued>[0]> = {}) {
    return Report.queued(
      {
        kind: 'executive_summary',
        scope: {},
        format: 'json',
        generatedBy: { userId: 'u1' as UserId },
        ...overrides,
      },
      clock
    );
  }

  it('queued() rejects an unsupported kind', () => {
    expect(() =>
      Report.queued(
        {
          kind: 'plotly' as never,
          scope: {},
          format: 'json',
          generatedBy: { userId: 'u1' as UserId },
        },
        clock
      )
    ).toThrow(ValidationError);
  });

  it('queued() rejects an unsupported format', () => {
    expect(() => queue({ format: 'docx' as never })).toThrow(ValidationError);
  });

  it('queued() rejects a missing generatedBy', () => {
    expect(() =>
      Report.queued(
        // @ts-expect-error: deliberately missing
        { kind: 'posture', scope: {}, format: 'csv' },
        clock
      )
    ).toThrow(ValidationError);
  });

  it('queued() starts in `queued` status with no artifact', () => {
    const r = queue();
    expect(r.status).toBe('queued');
    expect(r.artifactUri).toBeNull();
    expect(r.artifactKey).toBeNull();
    expect(r.generatedAt).toBeNull();
  });

  it('markGenerated stamps artifact + emits report.generated', () => {
    const r = queue();
    r.markGenerated(
      {
        artifactUri: 'file:///tmp/a.json',
        artifactKey: 'dashboard/reports/2026/05/r.json',
        artifactSize: 42,
      },
      clock
    );
    expect(r.status).toBe('generated');
    expect(r.artifactUri).toBe('file:///tmp/a.json');
    expect(r.artifactKey).toBe('dashboard/reports/2026/05/r.json');
    expect(r.artifactSize).toBe(42);
    const ev = r.drainEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.type).toBe('report.generated');
    expect(ev[0]!.payload).toMatchObject({
      reportId: r.id,
      kind: 'executive_summary',
      format: 'json',
    });
  });

  it('markGenerated cannot run twice — enforces artifact immutability', () => {
    const r = queue();
    r.markGenerated(
      {
        artifactUri: 'file:///a',
        artifactKey: 'k',
        artifactSize: 1,
      },
      clock
    );
    expect(() =>
      r.markGenerated(
        {
          artifactUri: 'file:///b',
          artifactKey: 'k2',
          artifactSize: 2,
        },
        clock
      )
    ).toThrow(/already generated/);
    // Persistence still carries the original URI.
    expect(r.artifactUri).toBe('file:///a');
  });

  it('markGenerated rejects blank artifactUri / artifactKey', () => {
    const r = queue();
    expect(() =>
      r.markGenerated(
        { artifactUri: '', artifactKey: 'k', artifactSize: 0 },
        clock
      )
    ).toThrow(/artifactUri/);
    expect(() =>
      r.markGenerated(
        { artifactUri: 'u', artifactKey: '', artifactSize: 0 },
        clock
      )
    ).toThrow(/artifactKey/);
  });

  it('markFailed records the reason without an event', () => {
    const r = queue();
    r.markFailed('renderer crashed', clock);
    expect(r.status).toBe('failed');
    expect(r.failureReason).toBe('renderer crashed');
    expect(r.drainEvents()).toHaveLength(0);
  });

  it('markFailed cannot run after success', () => {
    const r = queue();
    r.markGenerated(
      {
        artifactUri: 'u',
        artifactKey: 'k',
        artifactSize: 1,
      },
      clock
    );
    expect(() => r.markFailed('late', clock)).toThrow(/only queued/);
  });

  it('round-trips via toPersistence / fromPersistence', () => {
    const r = queue({ format: 'csv' });
    r.markGenerated(
      {
        artifactUri: 'file:///x',
        artifactKey: 'dashboard/reports/x.csv',
        artifactSize: 123,
      },
      clock
    );
    r.drainEvents();
    const reloaded = Report.fromPersistence(r.toPersistence());
    expect(reloaded.id).toBe(r.id);
    expect(reloaded.status).toBe('generated');
    expect(reloaded.artifactSize).toBe(123);
    expect(reloaded.artifactUri).toBe('file:///x');
  });
});
