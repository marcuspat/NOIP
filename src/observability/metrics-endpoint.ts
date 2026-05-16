// `/metrics` endpoint — ADR-0023.
//
// Operators (Prometheus, kube-state, sidecars) scrape this; cluster
// network policy is the gate, so the route is intentionally GET-only
// and unauthenticated. Mount via:
//
//   app.get('/metrics', metricsEndpoint());

import type { Request, Response, RequestHandler } from 'express';

import { register } from './registry';

/**
 * Express handler returning the registry serialised in the Prometheus
 * text exposition format. Errors during serialisation surface as a
 * 500 with a plain-text body so the scraper sees something parseable.
 */
export function metricsEndpoint(): RequestHandler {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      const body = await register.metrics();
      res.setHeader('Content-Type', register.contentType);
      res.status(200).send(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.setHeader('Content-Type', 'text/plain; version=0.0.4');
      res.status(500).send(`# metrics serialisation failed: ${message}\n`);
    }
  };
}
