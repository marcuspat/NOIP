// HTTP edge for the Dashboard context.
//
// Endpoints (DDD-10):
//   - GET    /                — list dashboards visible to the principal
//   - POST   /                — create
//   - GET    /:id             — single dashboard
//   - PATCH  /:id             — update
//   - DELETE /:id             — delete
//   - POST   /:id/share       — replace share policy
//   - GET    /widget/:id/data — resolve widget data
//
// Principal extraction: we read `x-user-id` and `x-user-roles` headers
// to keep this layer decoupled from IAM. The real IAM middleware will
// wrap requests and stamp `req.user` once it lands; until then the
// header convention is what the integration tests use.

import express, { type Request, type Response, type Router } from 'express';
import {
  isDomainError,
  toHttpResponse,
  ValidationError,
} from '../../../shared/errors';
import {
  tryParseId,
  type DashboardId,
  type UserId,
  type WidgetId,
} from '../../../shared/kernel';
import type { DashboardService } from '../application/dashboard.service';
import type { Principal } from '../application/access-checker';
import type { DashboardLayout, ShareVisibility } from '../domain/value-objects';

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

function parseDashboardId(raw: string): DashboardId {
  const id = tryParseId<DashboardId>(raw);
  if (!id) throw new ValidationError('invalid dashboard id', { id: raw });
  return id;
}

function parseWidgetId(raw: string): WidgetId {
  const id = tryParseId<WidgetId>(raw);
  if (!id) throw new ValidationError('invalid widget id', { id: raw });
  return id;
}

function readBody(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

export interface DashboardRoutesOptions {
  /** Override principal source (tests). */
  principal?: (req: Request) => Principal | null;
}

export function dashboardRoutes(
  service: DashboardService,
  opts: DashboardRoutesOptions = {}
): Router {
  const router = express.Router();
  const getPrincipal = opts.principal ?? readPrincipal;

  router.get('/', async (req, res) => {
    try {
      const principal = getPrincipal(req);
      const list = await service.listDashboards(principal);
      ok(
        res,
        list.map(d => d.toPersistence())
      );
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/', async (req, res) => {
    try {
      const principal = getPrincipal(req);
      if (!principal) throw new ValidationError('x-user-id header required');
      const body = readBody(req);
      const layout = body['layout'];
      if (layout !== 'grid' && layout !== 'flex') {
        throw new ValidationError('layout must be grid|flex', { layout });
      }
      const createInput: Parameters<typeof service.createDashboard>[0] = {
        name: String(body['name'] ?? ''),
        layout: layout as DashboardLayout,
        ownedBy: { userId: principal.userId },
      };
      if (typeof body['description'] === 'string') {
        createInput.description = body['description'];
      }
      if (typeof body['refreshIntervalSec'] === 'number') {
        createInput.refreshIntervalSec = body['refreshIntervalSec'];
      }
      if (Array.isArray(body['widgets'])) {
        createInput.widgets = body['widgets'] as never;
      }
      if (body['share'] && typeof body['share'] === 'object') {
        createInput.share = body['share'] as never;
      }
      const d = await service.createDashboard(createInput);
      ok(res, d.toPersistence(), 201);
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/widget/:id/data', async (req, res) => {
    try {
      const principal = getPrincipal(req);
      const widgetId = parseWidgetId(req.params['id'] ?? '');
      const dashboardIdRaw = req.query['dashboardId'];
      if (typeof dashboardIdRaw !== 'string') {
        throw new ValidationError('dashboardId query param required');
      }
      const data = await service.getWidgetData({
        dashboardId: parseDashboardId(dashboardIdRaw),
        widgetId,
        principal,
      });
      ok(res, data);
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const principal = getPrincipal(req);
      const id = parseDashboardId(req.params['id'] ?? '');
      const d = await service.getDashboard(id, principal);
      ok(res, d.toPersistence());
    } catch (err) {
      fail(res, err);
    }
  });

  router.patch('/:id', async (req, res) => {
    try {
      const principal = getPrincipal(req);
      const id = parseDashboardId(req.params['id'] ?? '');
      const body = readBody(req);
      const spec: Parameters<typeof service.updateDashboard>[1] = {};
      if (typeof body['name'] === 'string') spec.name = body['name'];
      if (typeof body['description'] === 'string') {
        spec.description = body['description'];
      }
      if (body['layout'] === 'grid' || body['layout'] === 'flex') {
        spec.layout = body['layout'];
      }
      if (typeof body['refreshIntervalSec'] === 'number') {
        spec.refreshIntervalSec = body['refreshIntervalSec'];
      }
      if (Array.isArray(body['widgets'])) {
        spec.widgets = body['widgets'] as never;
      }
      const d = await service.updateDashboard(id, spec, principal);
      ok(res, d.toPersistence());
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const principal = getPrincipal(req);
      const id = parseDashboardId(req.params['id'] ?? '');
      await service.deleteDashboard(id, principal);
      ok(res, { deleted: true });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/:id/share', async (req, res) => {
    try {
      const principal = getPrincipal(req);
      const id = parseDashboardId(req.params['id'] ?? '');
      const body = readBody(req);
      const visibility = body['visibility'];
      const visibilityStr = String(visibility);
      if (
        visibilityStr !== 'private' &&
        visibilityStr !== 'role-scoped' &&
        visibilityStr !== 'organisation'
      ) {
        throw new ValidationError('unsupported visibility', {
          visibility,
        });
      }
      const roles = Array.isArray(body['roles'])
        ? (body['roles'] as unknown[]).filter(
            (r): r is string => typeof r === 'string'
          )
        : undefined;
      const policy = roles
        ? {
            visibility: visibilityStr as ShareVisibility,
            roles,
          }
        : { visibility: visibilityStr as ShareVisibility };
      const d = await service.share(id, policy, principal);
      ok(res, d.toPersistence());
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

export default dashboardRoutes;
