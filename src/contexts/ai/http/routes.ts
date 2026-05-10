// HTTP edge for the AI Analysis context (DDD-08).
//
// Endpoints:
//   POST /analyze/infrastructure
//   POST /analyze/security
//   POST /analyze/compliance
//   POST /analyze/performance
//   POST /analyze/cost
//   GET  /insights?clusterId=...&type=...
//   POST /feedback/:analysisId
//
// Legacy back-compat: existing tests call /analyze/infrastructure with
// `{ data: ... }` and expect a `{ success, data }` envelope. We honour
// that contract while also exposing the new richer schema.

import express, {
  type NextFunction,
  type Request,
  type Response,
  type Router,
} from 'express';
import {
  isDomainError,
  toHttpResponse,
  ValidationError,
} from '../../../shared/errors';
import type { AnalysisId, ClusterId } from '../../../shared/kernel';
import { tryParseId } from '../../../shared/kernel';
import type { AIService } from '../application/ai.service';
import type { FeedbackService } from '../application/feedback.service';
import type { AnalysisType, Scope } from '../domain/value-objects';
import type { Analysis } from '../domain/analysis';

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

function readScope(req: Request): Scope {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const clusterRaw =
    typeof body['clusterId'] === 'string'
      ? (body['clusterId'] as string)
      : typeof req.query['clusterId'] === 'string'
        ? (req.query['clusterId'] as string)
        : '';
  if (!clusterRaw) {
    throw new ValidationError('clusterId is required');
  }
  const cid = tryParseId<ClusterId>(clusterRaw) ?? (clusterRaw as ClusterId);
  const scope: Scope = { clusterId: cid };
  const ns = body['namespace'] ?? req.query['namespace'];
  if (typeof ns === 'string' && ns.length > 0) scope.namespace = ns;
  return scope;
}

function projectAnalysis(a: Analysis): Record<string, unknown> {
  return {
    id: a.id,
    type: a.type,
    scope: a.scope,
    status: a.status,
    insights: a.insights,
    recommendations: a.recommendations,
    predictions: a.predictions,
    confidence: a.confidence,
    tokens: a.tokens,
    costEstimate: a.costEstimate,
    redaction: a.redaction,
    processingTimeMs: a.processingTimeMs,
    requestedAt: a.requestedAt,
    completedAt: a.completedAt,
    retrieved: a.retrieved,
    strategy: a.strategy,
  };
}

const ANALYSIS_TYPES: ReadonlySet<AnalysisType> = new Set<AnalysisType>([
  'security',
  'performance',
  'compliance',
  'cost',
  'comprehensive',
]);

export interface AIRoutesOptions {
  service: AIService;
  feedback: FeedbackService;
}

export function aiRoutes(opts: AIRoutesOptions): Router {
  const { service, feedback } = opts;
  const router = express.Router();

  // Helper to allow legacy `{ data: ... }` body with `clusterId` inside.
  const extractPayload = (req: Request): unknown => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if ('payload' in body) return body['payload'];
    if ('data' in body) return body['data'];
    if ('scanResults' in body) return { scanResults: body['scanResults'] };
    if ('resources' in body) return { resources: body['resources'] };
    return body;
  };

  const tryReadScopeFlexible = (req: Request): Scope => {
    try {
      return readScope(req);
    } catch {
      // Legacy tests don't always send clusterId; default to a synthetic one.
      const body = (req.body ?? {}) as Record<string, unknown>;
      const data = body['data'];
      if (data && typeof data === 'object') {
        const r = data as Record<string, unknown>;
        if (typeof r['clusterId'] === 'string') {
          return { clusterId: r['clusterId'] as ClusterId };
        }
      }
      return { clusterId: 'legacy' as ClusterId };
    }
  };

  router.post('/analyze/infrastructure', async (req, res) => {
    try {
      const scope = tryReadScopeFlexible(req);
      const a = await service.analyzeInfrastructure({
        scope,
        payload: extractPayload(req),
      });
      ok(res, projectAnalysis(a));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/analyze/security', async (req, res) => {
    try {
      const scope = tryReadScopeFlexible(req);
      const a = await service.analyzeSecurity({
        scope,
        payload: extractPayload(req),
      });
      ok(res, projectAnalysis(a));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/analyze/compliance', async (req, res) => {
    try {
      const scope = tryReadScopeFlexible(req);
      const a = await service.analyzeCompliance({
        scope,
        payload: extractPayload(req),
      });
      ok(res, projectAnalysis(a));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/analyze/performance', async (req, res) => {
    try {
      const scope = tryReadScopeFlexible(req);
      const a = await service.analyzePerformance({
        scope,
        payload: extractPayload(req),
      });
      ok(res, projectAnalysis(a));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/analyze/cost', async (req, res) => {
    try {
      const scope = tryReadScopeFlexible(req);
      const a = await service.analyzeCost({
        scope,
        payload: extractPayload(req),
      });
      ok(res, projectAnalysis(a));
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/insights', async (req, res) => {
    try {
      const scope = readScope(req);
      const t = req.query['type'];
      const type =
        typeof t === 'string' && ANALYSIS_TYPES.has(t as AnalysisType)
          ? (t as AnalysisType)
          : undefined;
      const insights = await service.getInsights(scope, type);
      ok(res, insights);
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/feedback/:analysisId', async (req, res) => {
    try {
      const id = (req.params['analysisId'] ?? '') as AnalysisId;
      if (!id) throw new ValidationError('analysisId is required');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const useful =
        typeof body['useful'] === 'boolean' ? body['useful'] : true;
      const comment =
        typeof body['comment'] === 'string' ? body['comment'] : undefined;
      const result = await feedback.record(id, useful, comment);
      ok(res, result);
    } catch (err) {
      fail(res, err);
    }
  });

  router.use(
    (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (isDomainError(err)) {
        fail(res, err);
        return;
      }
      fail(res, err);
    }
  );

  return router;
}

export default aiRoutes;
