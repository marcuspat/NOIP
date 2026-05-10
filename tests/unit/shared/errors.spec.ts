import {
  DomainError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  OptimisticLockError,
  RateLimitError,
  BackpressureError,
  ProviderError,
  InternalError,
  isDomainError,
  toHttpResponse,
} from '../../../src/shared/errors';

describe('shared/errors', () => {
  describe('DomainError base class', () => {
    it('captures code, statusCode, message, and stack', () => {
      const e = new DomainError('boom', 'TEST_CODE', 418, { a: 1 });
      expect(e).toBeInstanceOf(Error);
      expect(e.code).toBe('TEST_CODE');
      expect(e.statusCode).toBe(418);
      expect(e.message).toBe('boom');
      expect(e.details).toEqual({ a: 1 });
      expect(e.stack).toContain('errors.spec.ts');
    });

    it('leaves details undefined when not supplied', () => {
      const e = new DomainError('m', 'C', 500);
      expect(e.details).toBeUndefined();
    });

    it('subclass name is set correctly', () => {
      const e = new ValidationError();
      expect(e.name).toBe('ValidationError');
    });
  });

  describe('isDomainError', () => {
    it('returns true for any DomainError subclass', () => {
      expect(isDomainError(new ValidationError())).toBe(true);
      expect(isDomainError(new ProviderError())).toBe(true);
    });

    it('returns false for plain errors and non-errors', () => {
      expect(isDomainError(new Error('x'))).toBe(false);
      expect(isDomainError('string')).toBe(false);
      expect(isDomainError(null)).toBe(false);
      expect(isDomainError(undefined)).toBe(false);
    });
  });

  describe('concrete error classes', () => {
    type Case = {
      name: string;
      build: () => DomainError;
      expectedStatus: number;
      expectedCode: string;
    };

    const cases: Case[] = [
      {
        name: 'ValidationError',
        build: () => new ValidationError('bad input'),
        expectedStatus: 400,
        expectedCode: 'VALIDATION_ERROR',
      },
      {
        name: 'UnauthorizedError',
        build: () => new UnauthorizedError(),
        expectedStatus: 401,
        expectedCode: 'UNAUTHORIZED',
      },
      {
        name: 'ForbiddenError',
        build: () => new ForbiddenError(),
        expectedStatus: 403,
        expectedCode: 'FORBIDDEN',
      },
      {
        name: 'ConflictError',
        build: () => new ConflictError(),
        expectedStatus: 409,
        expectedCode: 'CONFLICT',
      },
      {
        name: 'OptimisticLockError',
        build: () => new OptimisticLockError(),
        expectedStatus: 409,
        expectedCode: 'OPTIMISTIC_LOCK',
      },
      {
        name: 'BackpressureError',
        build: () => new BackpressureError(),
        expectedStatus: 503,
        expectedCode: 'BACKPRESSURE',
      },
      {
        name: 'ProviderError',
        build: () => new ProviderError(),
        expectedStatus: 502,
        expectedCode: 'PROVIDER_ERROR',
      },
      {
        name: 'InternalError',
        build: () => new InternalError(),
        expectedStatus: 500,
        expectedCode: 'INTERNAL_ERROR',
      },
    ];

    it.each(cases)(
      '$name carries the expected status & code',
      ({ build, expectedStatus, expectedCode }) => {
        const e = build();
        expect(e.statusCode).toBe(expectedStatus);
        expect(e.code).toBe(expectedCode);
      }
    );
  });

  describe('NotFoundError', () => {
    it('formats message with resource only when no id given', () => {
      const e = new NotFoundError('Cluster');
      expect(e.message).toBe('Cluster not found');
      expect(e.statusCode).toBe(404);
      expect(e.code).toBe('NOT_FOUND');
      expect(e.details).toEqual({ resource: 'Cluster' });
    });

    it('formats message with id when supplied', () => {
      const e = new NotFoundError('Cluster', 'c-123');
      expect(e.message).toBe('Cluster not found: c-123');
      expect(e.details).toMatchObject({ resource: 'Cluster', id: 'c-123' });
    });

    it('merges extra details', () => {
      const e = new NotFoundError('Cluster', 'c-1', { tenant: 't-1' });
      expect(e.details).toMatchObject({
        resource: 'Cluster',
        id: 'c-1',
        tenant: 't-1',
      });
    });
  });

  describe('RateLimitError', () => {
    it('exposes retryAfterSec on the instance and in details', () => {
      const e = new RateLimitError(30);
      expect(e.statusCode).toBe(429);
      expect(e.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(e.retryAfterSec).toBe(30);
      expect(e.details).toMatchObject({ retryAfterSec: 30 });
    });
  });

  describe('toHttpResponse', () => {
    it('maps a DomainError to its status, code, message, and details', () => {
      const e = new ValidationError('bad', { field: 'email' });
      const res = toHttpResponse(e);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'VALIDATION_ERROR',
        message: 'bad',
        details: { field: 'email' },
      });
    });

    it('omits the details key entirely when none were supplied', () => {
      const e = new UnauthorizedError();
      const res = toHttpResponse(e);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: 'UNAUTHORIZED',
        message: 'Authentication required',
      });
      expect('details' in res.body).toBe(false);
    });

    it('includes retryAfterSec on rate-limit responses', () => {
      const res = toHttpResponse(new RateLimitError(15));
      expect(res.status).toBe(429);
      expect(res.body.error).toBe('RATE_LIMIT_EXCEEDED');
      expect(res.body.retryAfterSec).toBe(15);
      expect(res.body.details).toMatchObject({ retryAfterSec: 15 });
    });

    it('maps unknown errors to 500 INTERNAL_ERROR with no details', () => {
      const res = toHttpResponse(new Error('leaky internal'));
      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        error: 'INTERNAL_ERROR',
        message: 'Internal server error',
      });
    });

    it('maps non-Error throwables to 500 INTERNAL_ERROR', () => {
      const res = toHttpResponse('not even an error');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('INTERNAL_ERROR');
    });
  });
});
