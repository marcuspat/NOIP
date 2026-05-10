// Redactor invariants — covers each class (secrets, PII, ids), produces
// a deterministic pseudonymisation, and emits a structured RedactionReport.

import { Redactor } from '../../../src/contexts/ai/domain/redactor';

describe('Redactor', () => {
  it('replaces JWTs with <REDACTED:jwt>', () => {
    const r = new Redactor();
    const { redacted, report } = r.redact(
      'token=eyJhbGciOiJIUzI1NiJ9.payload.signature ok'
    );
    expect(redacted).toContain('<REDACTED:jwt>');
    expect(report.secretsRedacted).toBeGreaterThan(0);
  });

  it('replaces api keys / passwords with their typed marker', () => {
    const r = new Redactor();
    const { redacted, report } = r.redact(
      'password=hunter2supersecretvalue and apikey=abcdef0123456789'
    );
    expect(redacted).toContain('<REDACTED:password>');
    expect(redacted).toContain('<REDACTED:api_key>');
    expect(report.secretsRedacted).toBeGreaterThanOrEqual(2);
  });

  it('pseudonymises emails deterministically across calls', () => {
    const r = new Redactor();
    const a = r.redact('contact alice@example.com today');
    const b = r.redact('alice@example.com again');
    const tokenA = a.redacted.match(/<PII:email:[a-f0-9]+>/)?.[0];
    const tokenB = b.redacted.match(/<PII:email:[a-f0-9]+>/)?.[0];
    expect(tokenA).toBeDefined();
    expect(tokenA).toBe(tokenB);
    expect(a.report.piiPseudonymised).toBe(1);
  });

  it('pseudonymises IPv4 addresses', () => {
    const r = new Redactor();
    const out = r.redact('client at 10.0.0.42 hit the api');
    expect(out.redacted).toMatch(/<PII:ip:[a-f0-9]+>/);
  });

  it('opaques uuids into op_<hash>', () => {
    const r = new Redactor();
    const out = r.redact(
      'session 550e8400-e29b-41d4-a716-446655440000 expired'
    );
    expect(out.redacted).toMatch(/op_[a-f0-9]+/);
    expect(out.report.idsOpaqued).toBeGreaterThan(0);
  });

  it('emits an aggregate report from redactAll', () => {
    const r = new Redactor();
    const out = r.redactAll([
      'pwd=topsecretpassword',
      'mail bob@example.com',
      'uid 550e8400-e29b-41d4-a716-446655440000',
    ]);
    expect(out.report.secretsRedacted).toBeGreaterThanOrEqual(1);
    expect(out.report.piiPseudonymised).toBeGreaterThanOrEqual(1);
    expect(out.report.idsOpaqued).toBeGreaterThanOrEqual(1);
  });

  it('different salts produce different tokens', () => {
    const a = new Redactor({ salt: 'salt1' });
    const b = new Redactor({ salt: 'salt2' });
    const o1 = a.redact('alice@example.com').redacted;
    const o2 = b.redact('alice@example.com').redacted;
    expect(o1).not.toBe(o2);
  });
});
