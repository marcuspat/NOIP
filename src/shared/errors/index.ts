// Typed error hierarchy. Status codes and codes are fixed by
// docs/architecture/ddd/15-application-services.md and consumed by the
// HTTP edge to map domain failures onto consistent responses.
//
// `toHttpResponse` is a pure function — no Express, no Fastify, no
// framework imports. The HTTP layer wires it up.

export interface DomainErrorJSON {
  error: string;
  message: string;
  details?: Record<string, unknown>;
  retryAfterSec?: number;
}

export interface HttpResponse {
  status: number;
  body: DomainErrorJSON;
}

export class DomainError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    statusCode: number,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;
    if (details !== undefined) {
      this.details = details;
    }
    // Preserve a clean stack trace where supported (V8). On other
    // engines `Error` already captured one in the super() call.
    if (
      typeof (Error as unknown as { captureStackTrace?: unknown })
        .captureStackTrace === 'function'
    ) {
      (
        Error as unknown as {
          captureStackTrace: (
            target: object,
            ctor: new (...args: never[]) => unknown
          ) => void;
        }
      ).captureStackTrace(this, new.target);
    }
  }
}

export class ValidationError extends DomainError {
  constructor(
    message = 'Validation failed',
    details?: Record<string, unknown>
  ) {
    super(message, 'VALIDATION_ERROR', 400, details);
  }
}

export class UnauthorizedError extends DomainError {
  constructor(
    message = 'Authentication required',
    details?: Record<string, unknown>
  ) {
    super(message, 'UNAUTHORIZED', 401, details);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'Access denied', details?: Record<string, unknown>) {
    super(message, 'FORBIDDEN', 403, details);
  }
}

export class NotFoundError extends DomainError {
  constructor(
    resource: string,
    id?: string,
    details?: Record<string, unknown>
  ) {
    const message =
      id !== undefined && id !== ''
        ? `${resource} not found: ${id}`
        : `${resource} not found`;
    const merged: Record<string, unknown> = {
      resource,
      ...(id !== undefined ? { id } : {}),
      ...(details ?? {}),
    };
    super(message, 'NOT_FOUND', 404, merged);
  }
}

export class ConflictError extends DomainError {
  constructor(
    message = 'Resource conflict',
    details?: Record<string, unknown>
  ) {
    super(message, 'CONFLICT', 409, details);
  }
}

export class OptimisticLockError extends DomainError {
  constructor(
    message = 'Concurrent modification detected',
    details?: Record<string, unknown>
  ) {
    super(message, 'OPTIMISTIC_LOCK', 409, details);
  }
}

export class RateLimitError extends DomainError {
  public readonly retryAfterSec: number;

  constructor(
    retryAfterSec: number,
    message = 'Rate limit exceeded',
    details?: Record<string, unknown>
  ) {
    const merged: Record<string, unknown> = {
      retryAfterSec,
      ...(details ?? {}),
    };
    super(message, 'RATE_LIMIT_EXCEEDED', 429, merged);
    this.retryAfterSec = retryAfterSec;
  }
}

export class BackpressureError extends DomainError {
  constructor(
    message = 'Service is shedding load',
    details?: Record<string, unknown>
  ) {
    super(message, 'BACKPRESSURE', 503, details);
  }
}

export class ProviderError extends DomainError {
  constructor(
    message = 'Upstream provider failure',
    details?: Record<string, unknown>
  ) {
    super(message, 'PROVIDER_ERROR', 502, details);
  }
}

export class InternalError extends DomainError {
  constructor(
    message = 'Internal server error',
    details?: Record<string, unknown>
  ) {
    super(message, 'INTERNAL_ERROR', 500, details);
  }
}

export function isDomainError(e: unknown): e is DomainError {
  return e instanceof DomainError;
}

/**
 * Maps any error onto an HTTP response shape. Unknown errors collapse to
 * `INTERNAL_ERROR` with no details to avoid leaking internals.
 */
export function toHttpResponse(e: unknown): HttpResponse {
  if (isDomainError(e)) {
    const body: DomainErrorJSON = {
      error: e.code,
      message: e.message,
    };
    if (e.details !== undefined) {
      body.details = e.details;
    }
    if (e instanceof RateLimitError) {
      body.retryAfterSec = e.retryAfterSec;
    }
    return { status: e.statusCode, body };
  }
  return {
    status: 500,
    body: {
      error: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
  };
}
