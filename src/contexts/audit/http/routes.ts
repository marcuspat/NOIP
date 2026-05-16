// HTTP edge for the Audit & Observability context (DDD-11).
//
// Endpoints (all privileged — callers must already be authenticated +
// authorised by upstream middleware):
//   - GET    /logs?actor=&action=&from=&to=&resource=&resourceId=&limit=&offset=
//   - GET    /logs/:id
//   - POST   /logs/verify-chain   { from?, to?, shard? }
//   - GET    /events?userId=&type=&severity=&resolved=&limit=
//   - PATCH  /events/:id          { resolved: true, by, note? }
//
// All errors route through the shared `toHttpResponse` mapper so we
// never leak stack traces. Param validation lives in this file
// because the audit context has its own small, single-purpose
// schema-free contracts.

import express, { type Request, type Response, type Router } from 'express';
import { toHttpResponse, ValidationError } from '../../../shared/errors';
import type { AuditService } from '../application/audit.service';
import type { AuditFilter, SecurityEventFilter } from '../domain/value-objects';

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

function parseLimit(value: unknown, fallback = 50, cap = 1000): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ValidationError('limit must be a positive number', { value });
  }
  return Math.min(cap, Math.floor(n));
}

function parseOffset(value: unknown, fallback = 0): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new ValidationError('offset must be a non-negative number', {
      value,
    });
  }
  return Math.floor(n);
}

function parseDate(value: unknown, name: string): Date | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new ValidationError(`${name} must be an ISO date string`, { value });
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError(`${name} is not a valid date`, { value });
  }
  return d;
}

function parseBool(value: unknown): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  throw new ValidationError('boolean parameter must be true|false', { value });
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function createAuditRouter(deps: { service: AuditService }): Router {
  const router = express.Router();
  const { service } = deps;

  router.get('/logs', async (req: Request, res: Response) => {
    try {
      const q = req.query;
      const filter: AuditFilter = {};
      const actorUserId = pickString(q['actor']);
      if (actorUserId !== undefined) filter.actor = { userId: actorUserId };
      const action = pickString(q['action']);
      if (action !== undefined) filter.action = action;
      const resource = pickString(q['resource']);
      if (resource !== undefined) filter.resource = resource;
      const resourceId = pickString(q['resourceId']);
      if (resourceId !== undefined) filter.resourceId = resourceId;
      const shard = pickString(q['shard']);
      if (shard !== undefined) filter.shard = shard;
      const from = parseDate(q['from'], 'from');
      if (from !== undefined) filter.from = from;
      const to = parseDate(q['to'], 'to');
      if (to !== undefined) filter.to = to;
      filter.limit = parseLimit(q['limit']);
      filter.offset = parseOffset(q['offset']);
      const page = await service.query(filter);
      ok(res, page);
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/logs/:id', async (req: Request, res: Response) => {
    try {
      const id = req.params['id'];
      if (typeof id !== 'string' || id.length === 0) {
        throw new ValidationError('id is required', { id });
      }
      const entry = await service.getEntry(id);
      if (!entry) {
        send(res, 404, {
          success: false,
          error: 'NOT_FOUND',
          message: `audit log not found: ${id}`,
        });
        return;
      }
      ok(res, entry);
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/logs/verify-chain', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        from?: unknown;
        to?: unknown;
        shard?: unknown;
      };
      const from = parseDate(body.from, 'from') ?? new Date(0);
      const to = parseDate(body.to, 'to') ?? new Date();
      const shard = pickString(body.shard);
      const report = await service.verifyChainIntegrity(
        shard !== undefined ? { from, to, shard } : { from, to }
      );
      ok(res, report);
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/events', async (req: Request, res: Response) => {
    try {
      const q = req.query;
      const filter: SecurityEventFilter = {};
      const userId = pickString(q['userId']);
      if (userId !== undefined) filter.userId = userId;
      const type = pickString(q['type']);
      if (type !== undefined) filter.type = type;
      const severityStr = pickString(q['severity']);
      if (severityStr !== undefined) {
        if (
          severityStr !== 'LOW' &&
          severityStr !== 'MEDIUM' &&
          severityStr !== 'HIGH' &&
          severityStr !== 'CRITICAL'
        ) {
          throw new ValidationError(
            'severity must be LOW|MEDIUM|HIGH|CRITICAL',
            {
              severity: severityStr,
            }
          );
        }
        filter.severity = severityStr;
      }
      const resolved = parseBool(q['resolved']);
      if (resolved !== undefined) filter.resolved = resolved;
      const from = parseDate(q['from'], 'from');
      if (from !== undefined) filter.from = from;
      const to = parseDate(q['to'], 'to');
      if (to !== undefined) filter.to = to;
      filter.limit = parseLimit(q['limit'], 100, 1000);
      const events = await service.listSecurityEvents(filter);
      ok(res, events);
    } catch (err) {
      fail(res, err);
    }
  });

  router.patch('/events/:id', async (req: Request, res: Response) => {
    try {
      const id = req.params['id'];
      if (typeof id !== 'string' || id.length === 0) {
        throw new ValidationError('id is required', { id });
      }
      const body = (req.body ?? {}) as {
        resolved?: unknown;
        by?: unknown;
        note?: unknown;
      };
      if (body.resolved !== true) {
        throw new ValidationError(
          'only `resolved: true` updates are supported',
          {
            resolved: body.resolved,
          }
        );
      }
      const by = pickString(body.by);
      if (by === undefined) {
        throw new ValidationError('`by` (resolving user id) is required');
      }
      const note = pickString(body.note);
      const updated = await service.resolveSecurityEvent(id, by, note);
      if (!updated) {
        send(res, 404, {
          success: false,
          error: 'NOT_FOUND',
          message: `security event not found: ${id}`,
        });
        return;
      }
      ok(res, updated);
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
