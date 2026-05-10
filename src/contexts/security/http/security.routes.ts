// HTTP edge for the Security context.
//
// Endpoints per DDD-07:
//   - GET    /scan          (legacy: list/start scan)
//   - POST   /scan          (run a scan against a clusterId)
//   - GET    /scan/pods     (legacy)
//   - GET    /scan/network  (legacy)
//   - GET    /score         (cluster posture score)
//   - GET    /findings      (filter by severity/status)
//   - PATCH  /findings/:id  (acknowledge | suppress | resolve)
//   - GET    /policies
//   - POST   /policies
//   - PATCH  /policies/:id
//   - GET    /recommendations

import express, { type Request, type Response, type Router } from 'express';
import {
  toHttpResponse,
  ValidationError,
  isDomainError,
} from '../../../shared/errors';
import type {
  ClusterId,
  FindingId,
  Instant,
  PolicyId,
  UserId,
} from '../../../shared/kernel';
import { tryParseId } from '../../../shared/kernel';
import type { SecurityService } from '../application/security.service';
import type {
  FindingFilter,
  PolicyType,
  Scope,
  Severity,
} from '../domain/value-objects';

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

function parseClusterId(raw: string): ClusterId {
  const id = tryParseId<ClusterId>(raw);
  if (!id) throw new ValidationError('invalid cluster id', { id: raw });
  return id;
}
function parseFindingId(raw: string): FindingId {
  const id = tryParseId<FindingId>(raw);
  if (!id) throw new ValidationError('invalid finding id', { id: raw });
  return id;
}
function parsePolicyId(raw: string): PolicyId {
  const id = tryParseId<PolicyId>(raw);
  if (!id) throw new ValidationError('invalid policy id', { id: raw });
  return id;
}
function parseUserId(raw: unknown): UserId {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ValidationError('userId is required');
  }
  return raw as UserId;
}

function readScope(req: Request): Scope {
  const clusterRaw =
    typeof req.query['clusterId'] === 'string'
      ? req.query['clusterId']
      : typeof (req.body as Record<string, unknown>)?.['clusterId'] === 'string'
        ? ((req.body as Record<string, unknown>)['clusterId'] as string)
        : '';
  if (!clusterRaw) {
    throw new ValidationError('clusterId is required');
  }
  const scope: Scope = { clusterId: parseClusterId(clusterRaw) };
  const ns =
    typeof req.query['namespace'] === 'string'
      ? req.query['namespace']
      : undefined;
  if (ns) scope.namespace = ns;
  return scope;
}

const SEVERITY_VALUES: ReadonlySet<string> = new Set([
  'low',
  'medium',
  'high',
  'critical',
]);
const STATUS_VALUES: ReadonlySet<string> = new Set([
  'open',
  'acknowledged',
  'suppressed',
  'resolved',
]);

function readFilter(req: Request): FindingFilter {
  const filter: FindingFilter = {};
  const sev = req.query['severity'];
  if (typeof sev === 'string' && SEVERITY_VALUES.has(sev)) {
    filter.severity = sev as Severity;
  }
  const status = req.query['status'];
  if (typeof status === 'string' && STATUS_VALUES.has(status)) {
    filter.status = status as NonNullable<FindingFilter['status']>;
  }
  if (typeof req.query['limit'] === 'string') {
    const n = parseInt(req.query['limit'], 10);
    if (!Number.isNaN(n) && n > 0) filter.limit = n;
  }
  return filter;
}

export interface SecurityRoutesOptions {
  legacy?: boolean;
}

export function securityRoutes(
  service: SecurityService,
  opts: SecurityRoutesOptions = {}
): Router {
  const router = express.Router();
  const legacy = opts.legacy !== false;

  // ---------------------------------------------------------------------------
  // /scan
  // ---------------------------------------------------------------------------
  router.get('/scan', async (req, res) => {
    try {
      // Legacy `GET /scan` runs a scan against `req.body.resources` (no
      // domain scope; serves the historical contract).
      const body = (req.body ?? {}) as { resources?: unknown };
      const resources = Array.isArray(body.resources) ? body.resources : [];
      const data = await service.scanResources(
        resources as Parameters<typeof service.scanResources>[0]
      );
      ok(res, data);
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/scan', async (req, res) => {
    try {
      const scope = readScope(req);
      const result = await service.runScan(scope);
      ok(res, result, 202);
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/scan/pods', async (_req, res) => {
    try {
      const data = await service.scanPodSecurity();
      ok(res, data);
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/scan/network', async (_req, res) => {
    try {
      const data = await service.scanNetworkPolicies();
      ok(res, data);
    } catch (err) {
      fail(res, err);
    }
  });

  // ---------------------------------------------------------------------------
  // /score, /findings, /recommendations
  // ---------------------------------------------------------------------------
  router.get('/score', async (req, res) => {
    try {
      // When `clusterId` is provided, return a per-cluster score; else
      // fall back to the legacy single-number form.
      if (typeof req.query['clusterId'] === 'string') {
        const scope = readScope(req);
        const data = await service.getScore(scope);
        ok(res, data);
        return;
      }
      const score = await service.getSecurityScore();
      ok(res, { score });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/findings', async (req, res) => {
    try {
      const scope = readScope(req);
      const data = await service.listFindings(scope, readFilter(req));
      ok(
        res,
        data.map(f => f.toPersistence())
      );
    } catch (err) {
      fail(res, err);
    }
  });

  router.patch('/findings/:id', async (req, res) => {
    try {
      const id = parseFindingId(req.params['id'] ?? '');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const action = typeof body['action'] === 'string' ? body['action'] : '';
      const userId = parseUserId(body['userId']);
      switch (action) {
        case 'acknowledge': {
          const note =
            typeof body['note'] === 'string'
              ? (body['note'] as string)
              : undefined;
          const f = await service.acknowledgeFinding(id, userId, note);
          ok(res, f.toPersistence());
          return;
        }
        case 'suppress': {
          const until =
            typeof body['until'] === 'string'
              ? (body['until'] as Instant)
              : ('' as Instant);
          const justification =
            typeof body['justification'] === 'string'
              ? (body['justification'] as string)
              : '';
          const f = await service.suppressFinding(
            id,
            userId,
            until,
            justification
          );
          ok(res, f.toPersistence());
          return;
        }
        case 'resolve': {
          const f = await service.resolveFinding(id, userId);
          ok(res, f.toPersistence());
          return;
        }
        default:
          throw new ValidationError(
            'action must be one of acknowledge|suppress|resolve',
            { action }
          );
      }
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/recommendations', async (req, res) => {
    try {
      // When `clusterId` is provided, scope the recommendations.
      if (typeof req.query['clusterId'] === 'string') {
        const scope = readScope(req);
        ok(res, await service.getRecommendations(scope));
        return;
      }
      ok(res, await service.getSecurityRecommendations());
    } catch (err) {
      fail(res, err);
    }
  });

  // ---------------------------------------------------------------------------
  // /policies
  // ---------------------------------------------------------------------------
  router.get('/policies', async (_req, res) => {
    try {
      const data = await service.listPolicies();
      ok(
        res,
        data.map(p => p.toPersistence())
      );
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/policies', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body['name'] === 'string' ? body['name'] : '';
      const type = typeof body['type'] === 'string' ? body['type'] : '';
      const config =
        typeof body['config'] === 'object' && body['config'] !== null
          ? (body['config'] as Record<string, unknown>)
          : {};
      const priority =
        typeof body['priority'] === 'number' ? body['priority'] : 100;
      const enabled =
        typeof body['enabled'] === 'boolean' ? body['enabled'] : true;
      if (!type) throw new ValidationError('policy type is required');
      const p = await service.createPolicy({
        name,
        type: type as PolicyType,
        config,
        priority,
        enabled,
      });
      ok(res, p.toPersistence(), 201);
    } catch (err) {
      fail(res, err);
    }
  });

  router.patch('/policies/:id', async (req, res) => {
    try {
      const id = parsePolicyId(req.params['id'] ?? '');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const changes: Parameters<typeof service.updatePolicy>[1] = {};
      if (typeof body['name'] === 'string') changes.name = body['name'];
      if (typeof body['priority'] === 'number') {
        changes.priority = body['priority'];
      }
      if (typeof body['enabled'] === 'boolean') {
        changes.enabled = body['enabled'];
      }
      if (typeof body['config'] === 'object' && body['config'] !== null) {
        changes.config = body['config'] as NonNullable<
          Parameters<typeof service.updatePolicy>[1]['config']
        >;
      }
      const p = await service.updatePolicy(id, changes);
      ok(res, p.toPersistence());
    } catch (err) {
      fail(res, err);
    }
  });

  // Catch-all error handler.
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

  // We accept legacy aliases like /scan when called without scope (already wired above).
  void legacy;

  return router;
}

export default securityRoutes;
