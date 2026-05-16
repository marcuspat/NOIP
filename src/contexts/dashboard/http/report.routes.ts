// HTTP edge for `/api/reports/*`.
//
// Endpoints (DDD-10):
//   - POST /          generate a report (kind + scope + format)
//   - GET  /          list reports (filterable by kind/format)
//   - GET  /:id       fetch metadata
//   - GET  /:id/artifact   stream the generated artifact bytes

import express, { type Request, type Response, type Router } from 'express';
import {
  isDomainError,
  toHttpResponse,
  ValidationError,
} from '../../../shared/errors';
import {
  tryParseId,
  type ClusterId,
  type ReportId,
  type UserId,
} from '../../../shared/kernel';
import type { ReportService } from '../application/report.service';
import type { Principal } from '../application/access-checker';
import type { Format, ReportKind, Scope } from '../domain/value-objects';

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

function readPrincipal(req: Request): Principal | null {
  const idHeader = req.header('x-user-id');
  if (!idHeader) return null;
  const id = tryParseId<UserId>(idHeader);
  if (!id) return null;
  const rolesHeader = req.header('x-user-roles');
  const roles =
    typeof rolesHeader === 'string' && rolesHeader.length > 0
      ? rolesHeader
          .split(',')
          .map(r => r.trim())
          .filter(r => r.length > 0)
      : [];
  return { userId: id, roles };
}

function parseReportId(raw: string): ReportId {
  const id = tryParseId<ReportId>(raw);
  if (!id) throw new ValidationError('invalid report id', { id: raw });
  return id;
}

const KIND_VALUES: ReadonlySet<string> = new Set([
  'executive_summary',
  'posture',
  'compliance',
  'incident',
]);

const FORMAT_VALUES: ReadonlySet<string> = new Set([
  'pdf',
  'html',
  'json',
  'csv',
]);

function readScope(raw: unknown): Scope {
  const out: Scope = {};
  if (typeof raw !== 'object' || raw === null) return out;
  const obj = raw as Record<string, unknown>;
  if (typeof obj['clusterId'] === 'string') {
    out.clusterId = obj['clusterId'] as ClusterId;
  }
  if (typeof obj['namespace'] === 'string') out.namespace = obj['namespace'];
  if (typeof obj['framework'] === 'string') out.framework = obj['framework'];
  if (typeof obj['windowDays'] === 'number') {
    out.windowDays = obj['windowDays'];
  }
  return out;
}

export interface ReportRoutesOptions {
  principal?: (req: Request) => Principal | null;
}

export function reportRoutes(
  service: ReportService,
  opts: ReportRoutesOptions = {}
): Router {
  const router = express.Router();
  const getPrincipal = opts.principal ?? readPrincipal;

  router.post('/', async (req, res) => {
    try {
      const principal = getPrincipal(req);
      if (!principal) throw new ValidationError('x-user-id header required');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const kind = String(body['kind'] ?? '');
      const format = String(body['format'] ?? '');
      if (!KIND_VALUES.has(kind)) {
        throw new ValidationError('unsupported report kind', { kind });
      }
      if (!FORMAT_VALUES.has(format)) {
        throw new ValidationError('unsupported report format', { format });
      }
      const report = await service.generateReport({
        kind: kind as ReportKind,
        format: format as Format,
        scope: readScope(body['scope']),
        generatedBy: { userId: principal.userId },
      });
      ok(res, report.toPersistence(), 201);
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/', async (req, res) => {
    try {
      const principal = getPrincipal(req);
      const filter: Parameters<typeof service.listReports>[0] = {};
      const kindQ = req.query['kind'];
      if (typeof kindQ === 'string' && KIND_VALUES.has(kindQ)) {
        filter.kind = kindQ as ReportKind;
      }
      const fmtQ = req.query['format'];
      if (typeof fmtQ === 'string' && FORMAT_VALUES.has(fmtQ)) {
        filter.format = fmtQ as Format;
      }
      const limit = req.query['limit'];
      if (typeof limit === 'string') {
        const n = parseInt(limit, 10);
        if (!Number.isNaN(n) && n > 0) filter.limit = n;
      }
      const rows = await service.listReports(filter, principal);
      ok(
        res,
        rows.map(r => r.toPersistence())
      );
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const principal = getPrincipal(req);
      const id = parseReportId(req.params['id'] ?? '');
      const r = await service.getReport(id, principal);
      ok(res, r.toPersistence());
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/:id/artifact', async (req, res) => {
    try {
      const principal = getPrincipal(req);
      const id = parseReportId(req.params['id'] ?? '');
      const { report, stream } = await service.getArtifact(id, principal);
      res.status(200);
      const fmt = report.format;
      const ctMap: Record<Format, string> = {
        pdf: 'application/pdf',
        html: 'text/html; charset=utf-8',
        json: 'application/json; charset=utf-8',
        csv: 'text/csv; charset=utf-8',
      };
      res.setHeader('content-type', ctMap[fmt]);
      res.setHeader(
        'content-disposition',
        `attachment; filename="${report.id}.${fmt}"`
      );
      stream.on('error', err => {
        if (!res.headersSent) fail(res, err);
        else res.end();
      });
      stream.pipe(res);
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

export default reportRoutes;
