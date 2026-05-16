// HTTP metrics middleware — ADR-0023.
//
// Mounted early in the middleware chain (after CORS / compression but
// before audit + business handlers) so we observe every request that
// makes it past transport-layer filtering, including those that fail
// auth.
//
// Cardinality is bounded by preferring `req.route.path` — the
// parameterised template Express attaches once routing has matched —
// over `req.path`, which contains the concrete request URL. A 404 (no
// matched route) falls back to the raw path; we collapse that into a
// single `__unmatched__` label below to keep cardinality finite even
// under crawler traffic.

import type { Request, Response, NextFunction, RequestHandler } from 'express';

import { httpRequestDurationSeconds, httpRequestsTotal } from './metrics';

/** Anything else (404 / pre-route error) is rolled up under this label. */
const UNMATCHED_ROUTE_LABEL = '__unmatched__';

/**
 * Prefer the parameterised route template (`/users/:id`) over the
 * concrete request path (`/users/abc-123`). Falling back to the raw
 * path on a 404 risks unbounded label cardinality, so we collapse the
 * unmatched case to a single bucket.
 */
export function resolveRouteLabel(req: Request): string {
  // `req.route` is populated by Express after the router resolves the
  // handler. Express 5 stores the parameterised template on
  // `req.route.path`. When the middleware is mounted under a sub-router
  // we also prefer `req.baseUrl` + the route path so dashboards see the
  // full mounted path (`/api/users/:id`) not just `/:id`.
  const routeLike = req as Request & {
    route?: { path?: string };
    baseUrl?: string;
  };
  const routePath = routeLike.route?.path;
  if (typeof routePath === 'string' && routePath.length > 0) {
    const base = routeLike.baseUrl ?? '';
    return `${base}${routePath}` || routePath;
  }
  // No matched route — almost always a 404. Collapse to a sentinel so a
  // scanning bot can't blow up the histogram cardinality.
  return UNMATCHED_ROUTE_LABEL;
}

/**
 * Express middleware factory. The returned handler attaches a single
 * `'finish'` listener per request, recording both the counter and the
 * histogram in one place so the two metrics never disagree.
 */
export function httpMetricsMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startNs = process.hrtime.bigint();

    res.once('finish', () => {
      // hrtime.bigint() avoids the float drift of Date.now() across
      // long-running requests; convert to seconds for the histogram.
      const elapsedSec =
        Number(process.hrtime.bigint() - startNs) / 1_000_000_000;
      const route = resolveRouteLabel(req);
      const method = req.method.toUpperCase();
      const status = String(res.statusCode);

      httpRequestsTotal.labels({ method, route, status }).inc();
      httpRequestDurationSeconds.labels({ route }).observe(elapsedSec);
    });

    next();
  };
}
