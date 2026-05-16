// HTTP edge for the Performance context.
//
// Endpoints per DDD-09:
//   - GET    /probes
//   - POST   /probes
//   - PATCH  /probes/:id
//   - DELETE /probes/:id
//   - POST   /probes/:id/run
//   - GET    /probes/:id/results?from=&to=&limit=
//   - POST   /load-tests
//   - GET    /load-tests
//   - GET    /load-tests/:id
//   - GET    /slos
//   - POST   /slos
//   - GET    /slos/:id

import express, { type Request, type Response, type Router } from 'express';
import {
  toHttpResponse,
  ValidationError,
  isDomainError,
} from '../../../shared/errors';
import type { LoadTestId, ProbeId, SLOId } from '../../../shared/kernel';
import { tryParseId } from '../../../shared/kernel';
import type { PerformanceService } from '../application/performance.service';
import type { ProbeKind } from '../domain/value-objects';

function send(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}
function ok(res: Response, data: unknown, status = 200): void {
  send(res, status, { success: true, data });
}
function fail(res: Response, err: unknown): void {
  const mapped = toHttpResponse(err);
  send(res, mapped.status, { success: false, ...mapped.body });
}

function parseProbeId(raw: string): ProbeId {
  const id = tryParseId<ProbeId>(raw);
  if (!id) throw new ValidationError('invalid probe id', { id: raw });
  return id;
}
function parseLoadTestId(raw: string): LoadTestId {
  const id = tryParseId<LoadTestId>(raw);
  if (!id) throw new ValidationError('invalid load test id', { id: raw });
  return id;
}
function parseSLOId(raw: string): SLOId {
  const id = tryParseId<SLOId>(raw);
  if (!id) throw new ValidationError('invalid SLO id', { id: raw });
  return id;
}

const VALID_KINDS = new Set<ProbeKind>(['http', 'tcp', 'dns', 'grpc']);

export function performanceRoutes(service: PerformanceService): Router {
  const router = express.Router();

  // ---------------------------------------------------------------------------
  // Probes
  // ---------------------------------------------------------------------------

  router.get('/probes', async (_req, res) => {
    try {
      const list = await service.listProbes();
      ok(
        res,
        list.map(p => p.toPersistence())
      );
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/probes', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body['name'] === 'string' ? body['name'] : '';
      const kind =
        typeof body['kind'] === 'string' ? (body['kind'] as ProbeKind) : 'http';
      if (!VALID_KINDS.has(kind)) {
        throw new ValidationError(
          `probe kind must be one of ${[...VALID_KINDS].join('|')}`,
          { kind }
        );
      }
      const target = typeof body['target'] === 'string' ? body['target'] : '';
      const sched = body['schedule'];
      if (
        typeof sched !== 'object' ||
        sched === null ||
        typeof (sched as { intervalMs?: unknown }).intervalMs !== 'number'
      ) {
        throw new ValidationError('schedule.intervalMs is required');
      }
      const probe = await service.createProbe({
        name,
        kind,
        target,
        schedule: sched as { intervalMs: number; timeoutMs?: number },
        labels:
          typeof body['labels'] === 'object' && body['labels'] !== null
            ? (body['labels'] as Record<string, string>)
            : {},
        config:
          typeof body['config'] === 'object' && body['config'] !== null
            ? (body['config'] as Record<string, unknown>)
            : {},
        enabled: typeof body['enabled'] === 'boolean' ? body['enabled'] : true,
        ...(typeof body['sloId'] === 'string' ? { sloId: body['sloId'] } : {}),
      });
      ok(res, probe.toPersistence(), 201);
    } catch (err) {
      fail(res, err);
    }
  });

  router.patch('/probes/:id', async (req, res) => {
    try {
      const id = parseProbeId(req.params['id'] ?? '');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const spec: Parameters<typeof service.updateProbe>[1] = {};
      if (typeof body['name'] === 'string') spec.name = body['name'];
      if (typeof body['target'] === 'string') spec.target = body['target'];
      if (typeof body['enabled'] === 'boolean') spec.enabled = body['enabled'];
      if (typeof body['labels'] === 'object' && body['labels'] !== null) {
        spec.labels = body['labels'] as Record<string, string>;
      }
      if (typeof body['config'] === 'object' && body['config'] !== null) {
        spec.config = body['config'] as Record<string, unknown>;
      }
      if (
        typeof body['schedule'] === 'object' &&
        body['schedule'] !== null &&
        typeof (body['schedule'] as { intervalMs?: unknown }).intervalMs ===
          'number'
      ) {
        spec.schedule = body['schedule'] as {
          intervalMs: number;
          timeoutMs?: number;
        };
      }
      if (typeof body['sloId'] === 'string') spec.sloId = body['sloId'];
      const probe = await service.updateProbe(id, spec);
      ok(res, probe.toPersistence());
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete('/probes/:id', async (req, res) => {
    try {
      const id = parseProbeId(req.params['id'] ?? '');
      await service.deleteProbe(id);
      send(res, 204, '');
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/probes/:id/run', async (req, res) => {
    try {
      const id = parseProbeId(req.params['id'] ?? '');
      const result = await service.runProbeNow(id);
      ok(res, result.toPersistence(), 202);
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/probes/:id/results', async (req, res) => {
    try {
      const id = parseProbeId(req.params['id'] ?? '');
      const filter: Parameters<typeof service.listProbeResults>[1] = {};
      if (typeof req.query['from'] === 'string') {
        filter.from = new Date(req.query['from']);
      }
      if (typeof req.query['to'] === 'string') {
        filter.to = new Date(req.query['to']);
      }
      if (typeof req.query['limit'] === 'string') {
        const n = parseInt(req.query['limit'], 10);
        if (!Number.isNaN(n) && n > 0) filter.limit = n;
      }
      const list = await service.listProbeResults(id, filter);
      ok(
        res,
        list.map(r => r.toPersistence())
      );
    } catch (err) {
      fail(res, err);
    }
  });

  // ---------------------------------------------------------------------------
  // Load tests
  // ---------------------------------------------------------------------------

  router.post('/load-tests', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body['name'] === 'string' ? body['name'] : '';
      const script = typeof body['script'] === 'string' ? body['script'] : '';
      const target = typeof body['target'] === 'string' ? body['target'] : '';
      const engine =
        typeof body['engine'] === 'string' ? body['engine'] : 'autocannon';
      const profile = body['profile'];
      if (
        typeof profile !== 'object' ||
        profile === null ||
        typeof (profile as { durationSec?: unknown }).durationSec !== 'number'
      ) {
        throw new ValidationError('profile.durationSec is required');
      }
      const result = await service.submitLoadTest({
        name,
        script,
        target,
        engine,
        profile: profile as Parameters<
          typeof service.submitLoadTest
        >[0]['profile'],
      });
      ok(res, result.toPersistence(), 202);
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/load-tests', async (_req, res) => {
    try {
      const list = await service.listLoadTests();
      ok(
        res,
        list.map(t => t.toPersistence())
      );
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/load-tests/:id', async (req, res) => {
    try {
      const id = parseLoadTestId(req.params['id'] ?? '');
      const test = await service.getLoadTest(id);
      ok(res, test.toPersistence());
    } catch (err) {
      fail(res, err);
    }
  });

  // ---------------------------------------------------------------------------
  // SLOs
  // ---------------------------------------------------------------------------

  router.get('/slos', async (_req, res) => {
    try {
      const list = await service.listSLOs();
      ok(
        res,
        list.map(s => s.toPersistence())
      );
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/slos', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body['name'] === 'string' ? body['name'] : '';
      const target = body['target'];
      const window = body['window'];
      const indicators = body['indicators'];
      if (
        typeof target !== 'object' ||
        target === null ||
        typeof (target as { kind?: unknown }).kind !== 'string'
      ) {
        throw new ValidationError('target.{kind,value} is required');
      }
      if (
        typeof window !== 'object' ||
        window === null ||
        typeof (window as { rollingDays?: unknown }).rollingDays !== 'number'
      ) {
        throw new ValidationError('window.rollingDays is required');
      }
      if (!Array.isArray(indicators)) {
        throw new ValidationError('indicators must be an array');
      }
      const slo = await service.defineSLO({
        name,
        target: target as Parameters<typeof service.defineSLO>[0]['target'],
        window: window as Parameters<typeof service.defineSLO>[0]['window'],
        indicators: indicators as Parameters<
          typeof service.defineSLO
        >[0]['indicators'],
      });
      ok(res, slo.toPersistence(), 201);
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/slos/:id', async (req, res) => {
    try {
      const id = parseSLOId(req.params['id'] ?? '');
      const snapshot = await service.getSLOStatus(id);
      ok(res, snapshot);
    } catch (err) {
      fail(res, err);
    }
  });

  router.use(
    (
      err: unknown,
      _req: Request,
      res: Response,
      _next: express.NextFunction
    ) => {
      if (isDomainError(err)) {
        fail(res, err);
        return;
      }
      fail(res, err);
    }
  );

  return router;
}

export default performanceRoutes;
