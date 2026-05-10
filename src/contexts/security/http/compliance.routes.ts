// HTTP edge for the Compliance side of the Security context.
//
// Endpoints per DDD-07:
//   - GET    /frameworks
//   - GET    /frameworks/:id/controls
//   - POST   /reports                 (generate)
//   - GET    /reports                 (list)
//   - GET    /reports/:id
//   - POST   /reports/:id/sign

import express, { type Request, type Response, type Router } from 'express';
import {
  toHttpResponse,
  ValidationError,
  isDomainError,
} from '../../../shared/errors';
import type { ClusterId, ReportId, UserId } from '../../../shared/kernel';
import { tryParseId } from '../../../shared/kernel';
import type { ComplianceService } from '../application/compliance.service';
import type { ComplianceFramework, Scope } from '../domain/value-objects';

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

const FRAMEWORKS: ReadonlySet<string> = new Set([
  'SOC2',
  'ISO27001',
  'HIPAA',
  'PCI-DSS',
  'GDPR',
]);

function parseFramework(raw: string): ComplianceFramework {
  if (!FRAMEWORKS.has(raw)) {
    throw new ValidationError('unknown compliance framework', {
      framework: raw,
    });
  }
  return raw as ComplianceFramework;
}

function parseClusterId(raw: string): ClusterId {
  const id = tryParseId<ClusterId>(raw);
  if (!id) throw new ValidationError('invalid cluster id', { id: raw });
  return id;
}

function parseReportId(raw: string): ReportId {
  const id = tryParseId<ReportId>(raw);
  if (!id) throw new ValidationError('invalid report id', { id: raw });
  return id;
}

function parseUserId(raw: unknown): UserId {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ValidationError('userId is required');
  }
  return raw as UserId;
}

function readScope(body: Record<string, unknown>): Scope {
  const cluster = body['clusterId'];
  if (typeof cluster !== 'string' || cluster.length === 0) {
    throw new ValidationError('clusterId is required');
  }
  const scope: Scope = { clusterId: parseClusterId(cluster) };
  if (typeof body['namespace'] === 'string') {
    scope.namespace = body['namespace'];
  }
  return scope;
}

export function complianceRoutes(service: ComplianceService): Router {
  const router = express.Router();

  router.get('/frameworks', (_req, res) => {
    try {
      ok(res, service.listFrameworks());
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/frameworks/:id/controls', (req, res) => {
    try {
      const fw = parseFramework(req.params['id'] ?? '');
      ok(res, service.listControls(fw));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/reports', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const fw =
        typeof body['framework'] === 'string'
          ? parseFramework(body['framework'])
          : (() => {
              throw new ValidationError('framework is required');
            })();
      const scope = readScope(body);
      const report = await service.generateReport(fw, scope);
      ok(res, report.toPersistence(), 201);
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/reports', async (req, res) => {
    try {
      const fw =
        typeof req.query['framework'] === 'string'
          ? parseFramework(req.query['framework'])
          : undefined;
      let scope: Scope | undefined;
      if (typeof req.query['clusterId'] === 'string') {
        scope = { clusterId: parseClusterId(req.query['clusterId']) };
      }
      const list = await service.listReports(fw, scope);
      ok(
        res,
        list.map(r => r.toPersistence())
      );
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/reports/:id', async (req, res) => {
    try {
      const id = parseReportId(req.params['id'] ?? '');
      const r = await service.getReport(id);
      ok(res, r.toPersistence());
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/reports/:id/sign', async (req, res) => {
    try {
      const id = parseReportId(req.params['id'] ?? '');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const userId = parseUserId(body['userId']);
      const r = await service.signReport(id, userId);
      ok(res, r.toPersistence());
    } catch (err) {
      fail(res, err);
    }
  });

  // Legacy aliases — keep the existing /api/compliance contract for
  // dashboards that haven't migrated yet.
  router.get('/health', async (_req, res) => {
    try {
      ok(res, await service.healthCheck());
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/dashboard', async (_req, res) => {
    try {
      const frameworks = service.listFrameworks();
      const summaries = frameworks.map(name => ({
        name,
        controls: service.listControls(name).length,
      }));
      ok(res, {
        overview: {
          totalFrameworks: frameworks.length,
          lastUpdated: new Date(),
          status: 'healthy',
        },
        frameworkSummaries: summaries,
      });
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

export default complianceRoutes;
