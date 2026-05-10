import { Router, Request, Response } from 'express';

/**
 * Dependencies the health router needs to inspect runtime state.
 *
 * See ADR-0020 (`docs/architecture/adr/0020-health-check-and-graceful-shutdown.md`)
 * for endpoint semantics. Keep these probes cheap; `/health/ready` is hit by
 * Kubernetes every few seconds and must not perform expensive work.
 */
export interface HealthRouteDeps {
  /** Bootstrap finished (config validated, services initialised, migrations done). */
  isStartupComplete(): boolean;
  /** Cheap readiness check; must not throw. */
  isReady(): Promise<boolean>;
  /** Process-level liveness; false only when the process should be killed. */
  isLive(): boolean;
  /** Optional rich composite payload for humans / `/health`. */
  composite?: () => Promise<unknown>;
}

/**
 * Create the four health-probe routes mandated by ADR-0020.
 *
 * - `GET /health/live`    process responsiveness
 * - `GET /health/ready`   ok to receive traffic
 * - `GET /health/startup` bootstrap finished
 * - `GET /health`         composite payload (preserves prior behaviour)
 */
export function createHealthRoutes(deps: HealthRouteDeps): Router {
  const router = Router();

  router.get('/health/live', (_req: Request, res: Response) => {
    const live = deps.isLive();
    res
      .status(live ? 200 : 503)
      .json({ status: live ? 'live' : 'shutting-down' });
  });

  router.get('/health/startup', (_req: Request, res: Response) => {
    const started = deps.isStartupComplete();
    res
      .status(started ? 200 : 503)
      .json({ status: started ? 'started' : 'starting' });
  });

  router.get('/health/ready', async (_req: Request, res: Response) => {
    if (!deps.isStartupComplete()) {
      res.status(503).json({ status: 'not-ready', reason: 'starting' });
      return;
    }

    let ready = false;
    try {
      ready = await deps.isReady();
    } catch {
      ready = false;
    }

    res
      .status(ready ? 200 : 503)
      .json({ status: ready ? 'ready' : 'not-ready' });
  });

  router.get('/health', async (_req: Request, res: Response) => {
    if (!deps.composite) {
      const ok = deps.isLive() && deps.isStartupComplete();
      res.status(ok ? 200 : 503).json({ status: ok ? 'healthy' : 'unhealthy' });
      return;
    }

    try {
      const payload = await deps.composite();
      res.status(200).json(payload);
    } catch (error) {
      res.status(503).json({
        status: 'unhealthy',
        timestamp: new Date(),
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}

export default createHealthRoutes;
