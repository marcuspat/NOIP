import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { runWithContext } from '../utils/request-context';

const CORRELATION_HEADER = 'x-correlation-id';
const CORRELATION_HEADER_OUT = 'X-Correlation-Id';

/**
 * Per-request correlation-id middleware.
 *
 * - Reads X-Correlation-Id from the inbound request, or generates one.
 * - Attaches a RequestContext (correlationId + startedAt) to AsyncLocalStorage
 *   so any downstream log/audit call inherits the id without explicit plumbing.
 * - Echoes the id on the response.
 *
 * Per ADR-0015.
 */
export function correlationMiddleware() {
  return function correlation(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    const incoming = req.header(CORRELATION_HEADER);
    const correlationId =
      typeof incoming === 'string' && incoming.length > 0 && incoming.length < 200
        ? incoming
        : randomUUID();

    res.setHeader(CORRELATION_HEADER_OUT, correlationId);
    (req as Request & { correlationId?: string }).correlationId = correlationId;

    runWithContext(
      {
        correlationId,
        routePath: req.path,
        startedAt: Date.now(),
      },
      () => next()
    );
  };
}
