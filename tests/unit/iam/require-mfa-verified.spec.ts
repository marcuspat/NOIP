// Branch coverage for the requireMFAVerified middleware (ADR-0009).

import {
  MFAVerifiedRequest,
  requireMFAVerified,
} from '../../../src/middleware/require-mfa-verified.middleware';
import { UnauthorizedError } from '../../../src/shared/errors';

interface MockResponse {
  headers: Record<string, string>;
  setHeader(name: string, value: string): void;
}

function makeRes(): MockResponse {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader(name: string, value: string): void {
      headers[name] = value;
    },
  };
}

describe('requireMFAVerified', () => {
  it('passes through when MFA is not enabled and user is within grace', () => {
    const middleware = requireMFAVerified({
      now: () => new Date('2026-01-02T00:00:00Z'),
    });
    const req: MFAVerifiedRequest = {
      user: {
        mfaEnabled: false,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    } as MFAVerifiedRequest;
    const res = makeRes();
    const next = jest.fn();
    middleware(req, res as unknown as never, next);
    expect(next).toHaveBeenCalledWith();
    expect(res.headers['X-MFA-Grace-Remaining']).toBeDefined();
    const remaining = Number(res.headers['X-MFA-Grace-Remaining']);
    expect(remaining).toBeGreaterThan(0);
  });

  it('rejects with mfa-required when grace has elapsed', () => {
    const middleware = requireMFAVerified({
      now: () => new Date('2026-02-01T00:00:00Z'),
    });
    const req: MFAVerifiedRequest = {
      user: {
        mfaEnabled: false,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    } as MFAVerifiedRequest;
    const next = jest.fn();
    middleware(req, makeRes() as unknown as never, next);
    const err = next.mock.calls[0]?.[0];
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect((err as UnauthorizedError).message).toBe('mfa-required');
    expect((err as UnauthorizedError).details).toEqual({
      step: 'mfa-enrolment',
    });
  });

  it('rejects with mfa-step-up-required when MFA is enabled but session is unverified', () => {
    const middleware = requireMFAVerified();
    const req: MFAVerifiedRequest = {
      user: { mfaEnabled: true, createdAt: new Date() },
      tokenPayload: { mfaVerified: false },
    } as MFAVerifiedRequest;
    const next = jest.fn();
    middleware(req, makeRes() as unknown as never, next);
    const err = next.mock.calls[0]?.[0];
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect((err as UnauthorizedError).message).toBe('mfa-step-up-required');
    expect((err as UnauthorizedError).details).toMatchObject({
      step: 'mfa',
    });
    const details = (err as UnauthorizedError).details as {
      methods: string[];
    };
    expect(Array.isArray(details.methods)).toBe(true);
    expect(details.methods.length).toBeGreaterThan(0);
  });

  it('passes through when MFA is enabled and the session is verified', () => {
    const middleware = requireMFAVerified();
    const req: MFAVerifiedRequest = {
      user: { mfaEnabled: true, createdAt: new Date() },
      tokenPayload: { mfaVerified: true },
    } as MFAVerifiedRequest;
    const next = jest.fn();
    middleware(req, makeRes() as unknown as never, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('honours session.mfaVerified when tokenPayload is missing', () => {
    const middleware = requireMFAVerified();
    const req: MFAVerifiedRequest = {
      user: { mfaEnabled: true, createdAt: new Date() },
      session: { mfaVerified: true },
    } as MFAVerifiedRequest;
    const next = jest.fn();
    middleware(req, makeRes() as unknown as never, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('forwards UnauthorizedError when no user is on the request', () => {
    const middleware = requireMFAVerified();
    const next = jest.fn();
    middleware({} as MFAVerifiedRequest, makeRes() as unknown as never, next);
    const err = next.mock.calls[0]?.[0];
    expect(err).toBeInstanceOf(UnauthorizedError);
  });

  it('when no createdAt is present, falls through to mfa-required', () => {
    const middleware = requireMFAVerified();
    const req: MFAVerifiedRequest = {
      user: { mfaEnabled: false },
    } as MFAVerifiedRequest;
    const next = jest.fn();
    middleware(req, makeRes() as unknown as never, next);
    const err = next.mock.calls[0]?.[0];
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect((err as UnauthorizedError).message).toBe('mfa-required');
  });
});
