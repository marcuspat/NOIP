// Audit middleware — captures one tamper-evident entry per request,
// emitted on the response `'finish'` event.
//
// Design:
//   - Capture is non-blocking: failures are logged and swallowed.
//   - Single hash per request (sanitiser stringifies the body once).
//   - Skip noisy paths (`/health/*`, `/metrics`) via `NON_AUDITED_PATHS`.
//   - Actor resolution: prefers `req.user`, then `req.serviceAccount`,
//     else `system: true` for unauthenticated routes that pass through
//     (e.g. probes — though those are usually skipped).
//
// Phase 1 wave 2 (ADR-0018): the middleware now publishes an
// `audit.request` DomainEvent on the EventBus instead of calling
// `HashChainAppender.append()` directly. The audit subscriber installed
// in `src/services/audit/event-subscribers.ts` performs the persist.
// Tests can still pass an explicit `appender` to bypass the bus and
// keep the legacy direct-append path; in production, callers pass a
// `bus` and the subscriber takes over.
//
// We also preserve a thin `AuditMiddleware` class with the
// `auditUserAction(action, resource)` factory because `src/routes/auth.routes.ts`
// already consumes that surface. Keeping it here as a back-compat shim
// avoids touching files outside this work's scope.

import type { Request, Response, NextFunction } from 'express';

import { AuditLogModel } from '../models';
import type { AuditCollection } from '../services/audit/hash-chain-appender.service';
import type { ActorRef } from '../models/audit-log.model';
import {
  HashChainAppender,
  type AuditEntryInput,
  type AuditLogger,
} from '../services/audit/hash-chain-appender.service';
import { sanitise, type SanitiseOptions } from '../services/audit/sanitiser';
import {
  compose,
  SystemClock,
  type Clock,
  type EventBus,
} from '../shared/kernel';
import { config } from '../config';
import logger from '../utils/logger';

/**
 * Request paths that should never reach the audit pipeline.
 *
 * The match semantics are "starts with" so trailing segments (e.g.
 * `/health/live`, `/health/ready`) are also excluded.
 */
export const NON_AUDITED_PATHS: ReadonlyArray<string> = ['/health', '/metrics'];

/** Minimal model surface required by `HashChainAppender`. */
function buildAuditCollection(): AuditCollection {
  return {
    async findOne(filter, options) {
      const q = AuditLogModel.findOne(filter);
      if (options?.sort) q.sort(options.sort);
      return (await q.lean<unknown>().exec()) as Awaited<
        ReturnType<AuditCollection['findOne']>
      >;
    },
    async insertOne(entry) {
      const created = await AuditLogModel.create(entry);
      return { insertedId: created._id };
    },
    async findRange(shard, fromSeq, toSeq) {
      const docs = await AuditLogModel.find({
        'chain.shard': shard,
        'chain.sequence': { $gte: fromSeq, $lte: toSeq },
      })
        .sort({ 'chain.sequence': 1 })
        .lean<unknown[]>()
        .exec();
      return docs as Awaited<ReturnType<AuditCollection['findRange']>>;
    },
  };
}

/**
 * Lazy default appender. Constructed on first use so that test code can
 * substitute its own via `setAuditAppender()` before the middleware fires.
 */
let _defaultAppender: HashChainAppender | null = null;
function getAppender(): HashChainAppender {
  if (_defaultAppender === null) {
    const auditLogger: AuditLogger = {
      info: (m, meta) => logger.info(m, meta),
      warn: (m, meta) => logger.warn(m, meta),
      error: (m, meta) => logger.error(m, meta),
    };
    _defaultAppender = new HashChainAppender({
      collection: buildAuditCollection(),
      clock: new SystemClock(),
      logger: auditLogger,
    });
  }
  return _defaultAppender;
}

export function setAuditAppender(appender: HashChainAppender | null): void {
  _defaultAppender = appender;
}

export interface AuditMiddlewareOptions {
  /** Override the default skip list; useful in tests. */
  skipPaths?: ReadonlyArray<string>;
  sanitiseOptions?: SanitiseOptions;
  /**
   * Direct-append path (legacy, retained for tests + early-boot uses).
   * If `bus` is also supplied, `bus` wins and the appender is ignored.
   */
  appender?: HashChainAppender;
  /**
   * Event bus to publish `audit.request` on. The audit subscriber
   * (installed in `event-subscribers.ts`) handles the persist. This is
   * the preferred wiring in production; the constructor argument exists
   * so callers don't need to reach for module-globals.
   */
  bus?: EventBus;
  /** Clock used to stamp `occurredAt` on emitted DomainEvents. */
  clock?: Clock;
}

/**
 * Express middleware factory. The returned handler attaches a `'finish'`
 * listener and returns immediately — request latency is unaffected.
 *
 * When `opts.bus` is provided the entry is wrapped in an `audit.request`
 * DomainEvent and published; an audit subscriber persists it. Otherwise
 * the legacy direct-append path runs against `opts.appender` (or the
 * default lazy appender), preserving back-compat with tests that don't
 * wire a bus.
 */
export function auditMiddleware(
  opts: AuditMiddlewareOptions = {}
): (req: Request, res: Response, next: NextFunction) => void {
  const skip = opts.skipPaths ?? NON_AUDITED_PATHS;
  const sanitiseOpts: SanitiseOptions = opts.sanitiseOptions ?? {
    maxBodySize: config.security.audit.maxBodySize,
  };
  const clock = opts.clock ?? new SystemClock();

  return (req, res, next) => {
    if (shouldSkip(req.path, skip)) {
      next();
      return;
    }

    // Snapshot at request-start; `finish` only needs `res.statusCode`.
    const captured = sanitise(
      {
        method: req.method,
        path: req.path,
        url: req.originalUrl,
        headers: req.headers as Record<string, unknown>,
        body: (req as unknown as { body?: unknown }).body,
        query: req.query,
        params: req.params as Record<string, unknown>,
      },
      undefined,
      sanitiseOpts
    );

    res.once('finish', () => {
      const entry = buildEntry(req, res, captured.request);

      if (opts.bus) {
        try {
          const event = compose<AuditEntryInput>(
            {
              type: 'audit.request',
              context: 'audit',
              aggregateType: 'request',
              aggregateId:
                entry.resourceId ?? `${entry.action}:${entry.ipAddress}`,
              ...(entry.actor.userId !== undefined
                ? { actor: { type: 'user', id: entry.actor.userId } }
                : entry.actor.serviceAccountId !== undefined
                  ? {
                      actor: {
                        type: 'service',
                        id: entry.actor.serviceAccountId,
                      },
                    }
                  : { actor: { type: 'system' } }),
              payload: entry,
            },
            clock
          );
          opts.bus.publish(event);
        } catch (err: unknown) {
          logger.error('noip_audit_publish_failed_total', {
            metric: 'noip_audit_publish_failed_total',
            increment: 1,
            action: entry.action,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      // Legacy direct-append fallback (tests, pre-bus boot order).
      const appender = opts.appender ?? getAppender();
      void appender.append(entry).catch((err: unknown) => {
        logger.error('noip_audit_persist_failed_total', {
          metric: 'noip_audit_persist_failed_total',
          increment: 1,
          action: entry.action,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    next();
  };
}

function shouldSkip(path: string, skipPaths: ReadonlyArray<string>): boolean {
  for (const prefix of skipPaths) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

interface CapturedRequest {
  method: string;
  path: string;
  query?: unknown;
  params?: Record<string, unknown>;
  headers: Record<string, unknown>;
  body?: unknown;
  bodyTruncated?: boolean;
  bodyOriginalBytes?: number;
}

function buildEntry(
  req: Request,
  res: Response,
  sanitisedReq: CapturedRequest
): AuditEntryInput {
  const actor = resolveActor(req);
  const ipAddress = getClientIp(req);
  const userAgent =
    (req.headers['user-agent'] as string | undefined) ?? 'unknown';
  const sessionId = (req as unknown as { session?: { sessionId?: string } })
    .session?.sessionId;

  const params = req.params as Record<string, string | undefined> | undefined;
  const reqBody = (req as unknown as { body?: Record<string, unknown> }).body;
  const resourceId = params?.['id'] ?? pickStringField(reqBody, 'id');

  // The route can refine the action / resource by setting fields on the
  // request via `auditUserAction()` (back-compat surface) or assigning
  // `req.auditAction` / `req.auditResource` directly.
  const ctx = (req as unknown as { auditContext?: AuditContext }).auditContext;
  const action =
    ctx?.action ??
    pickStringField(req as unknown as Record<string, unknown>, 'auditAction') ??
    `http.${req.method.toLowerCase()}.${req.path}`;
  const resource = ctx?.resource ?? req.path;

  const details: Record<string, unknown> = {
    method: sanitisedReq.method,
    path: sanitisedReq.path,
    statusCode: res.statusCode,
    query: sanitisedReq.query,
    headers: sanitisedReq.headers,
    body: sanitisedReq.body,
  };
  if (sanitisedReq.bodyTruncated) {
    details['bodyTruncated'] = true;
    details['bodyOriginalBytes'] = sanitisedReq.bodyOriginalBytes;
  }

  const out: AuditEntryInput = {
    actor,
    action,
    resource,
    details,
    ipAddress,
    userAgent,
  };
  if (resourceId !== undefined) out.resourceId = resourceId;
  if (sessionId !== undefined) out.sessionId = sessionId;
  return out;
}

function resolveActor(req: Request): ActorRef {
  const reqAny = req as unknown as {
    user?: { _id?: unknown; id?: unknown };
    serviceAccount?: { _id?: unknown; id?: unknown };
  };
  const userId = stringifyId(reqAny.user?._id ?? reqAny.user?.id);
  if (userId !== undefined) return { userId };
  const svcId = stringifyId(
    reqAny.serviceAccount?._id ?? reqAny.serviceAccount?.id
  );
  if (svcId !== undefined) return { serviceAccountId: svcId };
  return { system: true };
}

function stringifyId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  return String(value);
}

function getClientIp(req: Request): string {
  if (typeof req.ip === 'string' && req.ip.length > 0) return req.ip;
  const sock = (req as unknown as { socket?: { remoteAddress?: string } })
    .socket;
  return sock?.remoteAddress ?? '127.0.0.1';
}

function pickStringField(
  obj: Record<string, unknown> | undefined,
  field: string
): string | undefined {
  if (obj === undefined || obj === null) return undefined;
  const v = obj[field];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Adds `req.startTime` so downstream code (e.g. timing metrics) can
 * measure handler duration. Kept for API compatibility with the previous
 * middleware surface.
 */
export const addRequestTiming = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  (req as unknown as { startTime: number }).startTime = Date.now();
  next();
};

// ---------------------------------------------------------------------------
// Back-compat surface: `AuditMiddleware` class
// ---------------------------------------------------------------------------
// Existing route files (`src/routes/auth.routes.ts`) call methods on an
// `AuditMiddleware` instance. We retain the minimal subset they use so we
// don't have to touch route wiring in this change. The implementations
// route through the new functional middleware where appropriate.

interface AuditContext {
  action: string;
  resource: string;
  resourceId?: string;
}

export class AuditMiddleware {
  /**
   * Tag the request with `auditContext` so the response-finish handler in
   * `auditMiddleware()` records `action` / `resource` accurately. This is
   * the routing-level handoff for action labels.
   */
  auditUserAction(action: string, resource: string) {
    return (req: Request, _res: Response, next: NextFunction): void => {
      const params = req.params as
        | Record<string, string | undefined>
        | undefined;
      const body = (req as unknown as { body?: Record<string, unknown> }).body;
      const resourceId =
        params?.['id'] ?? pickStringField(body, 'id') ?? undefined;
      const ctx: AuditContext = { action, resource };
      if (resourceId !== undefined) ctx.resourceId = resourceId;
      (req as unknown as { auditContext: AuditContext }).auditContext = ctx;
      next();
    };
  }

  /**
   * Wraps `auditMiddleware()` so call sites that prefer the class shape
   * keep working. The actual capture logic lives in the functional path.
   */
  audit = auditMiddleware();
}
