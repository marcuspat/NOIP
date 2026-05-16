import express from 'express';
import compression from 'compression';
import morgan from 'morgan';
import mongoose from 'mongoose';
import { config } from './config';
import logger from './utils/logger';
import {
  nonceMiddleware,
  securityHeadersMiddleware,
} from './middleware/security-headers.middleware';
import { corsAllowList } from './middleware/cors.middleware';
import {
  composeDiscovery,
  KubernetesAdapter,
  KubernetesClientFactory,
  type RawKubernetesClient,
} from './contexts/discovery/api';
import discoveryRoutes from './contexts/discovery/http/routes';
import { InMemoryRawKubernetesClient } from './contexts/discovery/infrastructure/kubernetes/in-memory-raw-client';
import { composeSecurity } from './contexts/security/api';
import { composeAI } from './contexts/ai/api';
import { DashboardService } from './services/dashboard.service';
import { composePerformance } from './contexts/performance/api';
import {
  InMemoryEventBus,
  SystemClock,
  type EventBus,
  type Unsubscribe,
} from './shared/kernel';
import { AuditLogModel, SecurityEventModel } from './models';
import {
  HashChainAppender,
  type AuditCollection,
  type AuditLogger,
} from './services/audit/hash-chain-appender.service';
import { SecurityEventService } from './services/audit/security-event.service';
import { installAuditSubscribers } from './services/audit/event-subscribers';
import { auditMiddleware } from './middleware/audit.middleware';
import { PermissionResolver } from './services/iam/permission-resolver.service';
import {
  mongooseRoleRepository,
  mongoosePermissionRepository,
} from './services/iam/composition';
import { RedisPermissionCache } from './services/iam/permission-cache';
import { installPermissionInvalidation } from './services/iam/permission-invalidation';
import {
  setDefaultPermissionResolver,
  setDefaultRequirePermissionLogger,
} from './middleware/require-permission.middleware';
import {
  requireMFAVerified,
  setDefaultMFAEnforcer,
} from './middleware/require-mfa-verified.middleware';
import {
  createSharedRedisClient,
  connectAndPing,
  pingWithTimeout,
  type SharedRedisClient,
} from './database/shared-redis';
import { createBucketLimiter } from './middleware/rate-limit-redis';
import { AuthService } from './services/auth.service';
import { JWTManager, MFAService, PasswordService } from './utils/auth';
import { adaptRedisManager } from './utils/auth/jwt.manager';
import { createAuthRouter } from './routes/auth.routes';

// Import route handlers
import { createHealthRoutes } from './routes/health.routes';

const app = express();

// ---------------------------------------------------------------------------
// Composition root (ADR-0018 Phase 1 wave 2)
// ---------------------------------------------------------------------------
// Exactly one in-process EventBus per pod. IAM producers (JWT manager,
// AuthService) publish here; the audit subscribers persist the resulting
// `iam.*`/`security.*`/etc. events into Mongo.
//
// Construction order matters:
//   1. EventBus (no deps).
//   2. SecurityEventService + HashChainAppender (the audit-side persistors).
//   3. installAuditSubscribers() — registers handlers against the bus.
//   4. Middleware/services that publish into the bus pick it up via
//      `getEventBus()` (or constructor DI in tests).
const eventClock = new SystemClock();
const eventBus: EventBus = new InMemoryEventBus(logger);

const auditLogger: AuditLogger = {
  info: (m, meta) => logger.info(m, meta),
  warn: (m, meta) => logger.warn(m, meta),
  error: (m, meta) => logger.error(m, meta),
};

const auditCollection: AuditCollection = {
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

const hashChainAppender = new HashChainAppender({
  collection: auditCollection,
  clock: eventClock,
  logger: auditLogger,
  eventBus,
});

const securityEventService = new SecurityEventService({
  store: SecurityEventModel as unknown as ConstructorParameters<
    typeof SecurityEventService
  >[0]['store'],
  logger: auditLogger,
});

const auditSubscriberHandles: Unsubscribe[] = installAuditSubscribers({
  bus: eventBus,
  securityEvents: securityEventService,
  appender: hashChainAppender,
  logger: auditLogger,
});

// ---------------------------------------------------------------------------
// Shared Redis client (ADR-0005 Phase 1 wave 3)
// ---------------------------------------------------------------------------
// Exactly one ioredis client per pod, used for: rate-limit counters
// (`noip:rl:*`), JWT denylist (`noip:deny:*`), refresh-token family
// state (`noip:fam:*`), permission cache (`noip:cache:perm:*`), MFA
// challenges (`noip:mfa:*`), and sessions (`noip:sess:*`). The client
// is constructed lazily here and `connect()`-ed inside
// `initializeServices()` so a Redis outage at boot keeps `/health/ready`
// at 503 instead of letting the pod accept traffic it can't serve.
const redisClient: SharedRedisClient = createSharedRedisClient();

// ---------------------------------------------------------------------------
// IAM authorisation (ADR-0008 Phase 1 wave 2 wireup)
// ---------------------------------------------------------------------------
// PermissionResolver materialises a user's effective permission set by
// flattening the role DAG and unioning direct grants. Wave 3 swaps the
// no-op cache placeholder for the real Redis-backed cache.
//
// `setDefaultPermissionResolver` registers the live resolver so route
// definitions can call `requirePermission('user', 'read')` without threading
// the resolver through every router.
//
// `installPermissionInvalidation` wires the resolver into the EventBus so
// `iam.permission.escalated` / `iam.role.updated` / etc. flush the cache.
const permissionCache = new RedisPermissionCache({
  // The shared ioredis client satisfies `PermissionCacheRedis` directly
  // (its `get`/`setex`/`set`/`del`/`scan` signatures match). We cast to
  // the narrower interface so the resolver only sees what it needs.
  redis: redisClient,
  logger: auditLogger,
});

const permissionResolver = new PermissionResolver({
  roles: mongooseRoleRepository,
  permissions: mongoosePermissionRepository,
  cache: permissionCache,
  logger: auditLogger,
});
setDefaultPermissionResolver(permissionResolver);
setDefaultRequirePermissionLogger(auditLogger);

const permissionInvalidationHandles: Unsubscribe[] =
  installPermissionInvalidation(eventBus, permissionResolver, auditLogger);

// ---------------------------------------------------------------------------
// MFA enforcer (ADR-0009 Phase 1 wave 3 wireup)
// ---------------------------------------------------------------------------
// Routes that mutate state or expose sensitive data should mount
// `requireMFAVerifiedDefault` after `authenticate`. The default enforcer
// honours the MFA_GRACE_PERIOD env var (7 days fresh-account window) and
// reads `mfaVerified` from the JWT payload.
setDefaultMFAEnforcer(
  requireMFAVerified({
    availableMethods: ['totp', 'backup'],
  })
);

// ---------------------------------------------------------------------------
// IAM service composition (deferred from Phase 1 wave 3)
// ---------------------------------------------------------------------------
// Compose the AuthService once per pod with the full DI surface:
//   - Shared Redis client → JWT denylist (ADR-0006) + MFA challenges (ADR-0009)
//   - EventBus            → `iam.*` DomainEvents (ADR-0018)
//   - Shared PasswordService → backs MFA backup-code Argon2id hashing
//
// The composed instance is exported via `getAuthService()` so the auth
// router factory (`createAuthRouter`) and any future controller that
// needs an explicit handle can reuse the same singleton instead of
// constructing a fresh service per request (which would skip the
// denylist + challenge wiring).
//
// This block is intentionally isolated so the parallel Phase 5 agent
// merging changes to other sections of app.ts has zero ambiguity about
// ordering: it lands AFTER the MFA enforcer setup and BEFORE the bus
// accessor exports. The Auth router is mounted further down under the
// `// API Routes` block.
const sharedPasswordService = new PasswordService();
const sharedJwtManager = new JWTManager({
  eventBus,
  redis: adaptRedisManager(redisClient),
});
// The shared ioredis client's `set` signature is the full variadic
// overload set; `MFARedisClient.set` is the narrow subset MFAService
// actually invokes (`set(key, value, 'EX', seconds)`). The cast is
// safe because the variadic overload structurally subsumes the narrow
// form, but TS cannot prove that without an explicit assertion.
const mfaRedisAdapter: import('./utils/auth').MFARedisClient = {
  get: key => redisClient.get(key),
  set: (key, value, mode, seconds) =>
    mode === 'EX' && seconds !== undefined
      ? redisClient.set(key, value, 'EX', seconds)
      : redisClient.set(key, value),
  del: key => redisClient.del(key),
  incr: key => redisClient.incr(key),
  expire: (key, seconds) => redisClient.expire(key, seconds),
  ttl: key => redisClient.ttl(key),
};
const sharedMfaService = new MFAService({
  redis: mfaRedisAdapter,
  hasher: sharedPasswordService,
});
const authService = new AuthService({
  eventBus,
  eventClock,
  jwtManager: sharedJwtManager,
  mfaService: sharedMfaService,
  passwordService: sharedPasswordService,
});
// Defensive re-wire of the bus through the JWT manager: composition
// order means the constructor already saw it, but `setEventBus` is the
// documented escape hatch and exercising it here keeps the manager and
// the AuthService bus in sync if someone swaps the bus at runtime.
authService.setEventBus(eventBus);

/** Accessor for the singleton AuthService composed above. */
export function getAuthService(): AuthService {
  return authService;
}

/** Accessors so other modules (controllers, tests) can grab the live bus. */
export function getEventBus(): EventBus {
  return eventBus;
}

export function getHashChainAppender(): HashChainAppender {
  return hashChainAppender;
}

export function getSecurityEventService(): SecurityEventService {
  return securityEventService;
}

// ---------------------------------------------------------------------------
// Discovery context (DDD-06 Phase 2 wireup)
// ---------------------------------------------------------------------------
// We try to load a real kube config (in-cluster service account or default
// kubeconfig) and fall back to an empty in-memory client when no config is
// available. Phase 2 ships the contract; operators flip
// `K8S_KUBECONFIG_PATH` or run inside the cluster to switch to live data.
function buildKubeRawClient(): RawKubernetesClient {
  try {
    return KubernetesClientFactory.fromConfig({
      ...(process.env['K8S_KUBECONFIG_PATH']
        ? { kubeconfigPath: process.env['K8S_KUBECONFIG_PATH'] }
        : {}),
      inCluster: process.env['K8S_IN_CLUSTER'] === 'true',
    });
  } catch (err) {
    logger.warn('Falling back to in-memory kube client (no kubeconfig found)', {
      err: err instanceof Error ? err.message : String(err),
    });
    return new InMemoryRawKubernetesClient();
  }
}

const discoveryK8s = new KubernetesAdapter({
  raw: buildKubeRawClient(),
  clock: eventClock,
  logger: auditLogger,
});

const composedDiscovery = composeDiscovery({
  k8s: discoveryK8s,
  bus: eventBus,
  clock: eventClock,
  logger: auditLogger,
});
const discoveryService = composedDiscovery.service;
const discoveryScheduler = composedDiscovery.scheduler;
const discoveryPublicApi = composedDiscovery.publicApi;

// ---------------------------------------------------------------------------
// Security & Compliance context (DDD-07 Phase 3 wireup)
// ---------------------------------------------------------------------------
// The composed bundle owns repos, scanner, scoring service, the scan
// orchestrator (which subscribes to discovery.cluster.scanned and
// discovery.drift.detected), and both HTTP routers. The composition
// root holds the unsubscribe handles and tears them down on SIGTERM.
const composedSecurity = composeSecurity({
  bus: eventBus,
  clock: eventClock,
  logger: auditLogger,
  discovery: {
    getLatestSnapshot: async scope => {
      const snap = await discoveryPublicApi.getLatestSnapshot(scope);
      return {
        id: snap.id,
        clusterId: snap.clusterId,
        hash: snap.hash,
        takenAt: snap.takenAt,
        records: snap.records,
      };
    },
  },
});
const securityService = composedSecurity.service;
const complianceService = composedSecurity.compliance;
const securitySubscriptions = composedSecurity.subscriptions;

// ---------------------------------------------------------------------------
// AI Analysis context (DDD-08 Phase 4 wireup)
// ---------------------------------------------------------------------------
// composeAI wires the AI service, orchestrator (subscribes to
// security.scan.completed / security.finding.opened /
// compliance.report.generated / discovery.cluster.scanned), feedback
// service, public API barrel, and HTTP router. The composition root
// holds the unsubscribe handles and tears them down on SIGTERM.
//
// Provider configuration:
//   - LLM client: AnthropicAdapter falls back to stub mode when
//     AI_API_KEY is empty, so dev/test pods don't need network access.
//   - RAG store: InMemoryRagStore by default; set RAG_PROVIDER=chroma
//     to switch to ChromaAdapter (the adapter speaks Chroma's HTTP API
//     directly, so no `@chroma-core/chromadb` dep is required).
//   - Ingestion: NoOpIngestionBridge by default; the PythonRagBridge
//     spawns scripts/update_rag.py when configured.
const composedAI = composeAI({
  bus: eventBus,
  clock: eventClock,
  logger: auditLogger,
  redis: redisClient as unknown as NonNullable<
    Parameters<typeof composeAI>[0]['redis']
  >,
  discovery: discoveryPublicApi,
  security: composedSecurity.publicApi,
  compliance: composedSecurity.compliancePublicApi,
});
const aiService = composedAI.service;
const aiSubscriptions = composedAI.subscriptions;

// Initialize services
const dashboardService = new DashboardService();

// Performance context (DDD-09): composePerformance wires the
// SLOComputer, probe runner, load-test engines, Prometheus client,
// and Mongoose repositories behind a single composePerformance() call.
const composedPerformance = composePerformance({
  bus: eventBus,
  clock: eventClock,
  logger: auditLogger,
});
const performanceService = composedPerformance.service;

// Middleware
// ADR-0024: explicit Helmet policy + CORS allow-list. nonceMiddleware
// must run before securityHeadersMiddleware so the CSP script-src
// callback can read res.locals.cspNonce.
app.use(nonceMiddleware());
app.use(securityHeadersMiddleware());
app.use(corsAllowList(config.security.cors.origins));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ---------------------------------------------------------------------------
// Operational lifecycle state (ADR-0020)
// ---------------------------------------------------------------------------
// `startupComplete` flips to true once `initializeServices()` resolves.
// `shuttingDown` flips to true on SIGTERM/SIGINT so readiness fails fast and
// the load balancer drains the pod before in-flight work is cancelled.
let startupComplete = false;
let shuttingDown = false;

// Mount health probes BEFORE the rate limiter so Kubernetes (and any other
// scrapers) are never rejected with HTTP 429. ADR-0020 mandates these probes
// stay cheap and unauthenticated.
app.use(
  createHealthRoutes({
    isStartupComplete: () => startupComplete,
    isLive: () => !shuttingDown,
    // ADR-0020: readiness must reflect the health of every dependency we
    // touch in the request path. We honour Mongo's `readyState` (cheap,
    // local) and a bounded `PING` to Redis (200ms ceiling so a slow
    // Redis can't make the probe itself a bottleneck).
    isReady: async () => {
      if (!startupComplete || shuttingDown) return false;
      const mongoReady = mongoose.connection.readyState === 1;
      if (!mongoReady) return false;
      return pingWithTimeout(redisClient, 200);
    },
    composite: async () => {
      const [
        discoveryHealth,
        securityHealth,
        aiHealth,
        dashboardHealth,
        performanceHealth,
        complianceHealth,
      ] = await Promise.all([
        discoveryService.healthCheck(),
        securityService.healthCheck(),
        aiService.healthCheck(),
        dashboardService.healthCheck(),
        performanceService.healthCheck(),
        complianceService.healthCheck(),
      ]);

      return {
        status: shuttingDown ? 'shutting-down' : 'healthy',
        timestamp: new Date(),
        version: config.app.version,
        environment: config.app.environment,
        phase: 'Phase 3 - Production Ready (100%)',
        services: {
          discovery: discoveryHealth,
          security: securityHealth,
          ai: aiHealth,
          dashboard: dashboardHealth,
          performance: performanceHealth,
          compliance: complianceHealth,
        },
        capabilities: {
          advancedAI: true,
          performanceTesting: true,
          complianceFramework: true,
          loadTesting: true,
          predictiveAnalytics: true,
          contextAwareAnalysis: true,
        },
      };
    },
  })
);

// Rate limiting (ADR-0016 Phase 1 wave 3).
// The global limiter is now Redis-backed via the shared ioredis client.
// Counter keys land at `noip:rl:*` (the shared client's keyPrefix
// "noip:" plus the store's "rl:" prefix). Per ADR-0016 the general
// API bucket fails OPEN on a Redis outage — log + allow, trusting the
// upstream WAF / ingress to cap blast radius.
//
// TODO Phase 1 wave 3 follow-up: mount per-bucket limiters on the auth
// /password-reset /MFA /AI route groups using `createBucketLimiter` with
// the appropriate `bucket: 'auth' | 'password-reset' | 'mfa' | 'ai'`
// argument. Those buckets fail-CLOSED on outage; the auth router needs
// to be plumbed through this composition root before we can mount them
// there.
const globalLimiter = createBucketLimiter(
  {
    bucket: 'general',
    windowMs: config.security.rateLimit.windowMs,
    max: config.security.rateLimit.max,
    message: 'Too many requests from this IP',
  },
  { redis: redisClient }
);
app.use(globalLimiter);

// Logging
if (config.app.environment !== 'test') {
  app.use(
    morgan('combined', {
      stream: {
        write: (message: string) => logger.info(message.trim()),
      },
    })
  );
}

// Audit middleware: publishes `audit.request` events; the audit
// subscriber persists them via `HashChainAppender`. Mounted after
// parsers so `req.body` is populated when the sanitiser runs, and
// after `morgan` so request logs and audit entries align.
app.use(auditMiddleware({ bus: eventBus, clock: eventClock }));

// API Routes
app.use('/api/discovery', discoveryRoutes(discoveryService));
app.use('/api/security', composedSecurity.routers.security);
app.use('/api/ai', composedAI.router);
app.use('/api/dashboard', createDashboardRoutes(dashboardService));
app.use('/api/performance', composedPerformance.router);
app.use('/api/compliance', composedSecurity.routers.compliance);
app.use(
  '/api/auth',
  createAuthRouter({
    authService,
    redisClient,
  })
);

// Error handling middleware
app.use(
  (
    err: Error,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    logger.error('Unhandled error', err);

    res.status(500).json({
      error: 'Internal server error',
      timestamp: new Date(),
      requestId: req.headers['x-request-id'] || 'unknown',
    });
  }
);

// 404 handler. Express 5 changed the path-to-regexp syntax: a bare `*`
// is no longer a legal path. Use a named wildcard parameter instead.
app.use('/{*splat}', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.originalUrl,
    timestamp: new Date(),
  });
});

// Route creators
// Note: createDiscoveryRoutes was removed in Phase 2 — the discovery
// router lives at `src/contexts/discovery/http/routes.ts` and is mounted
// directly above. createSecurityRoutes / complianceRoutes were removed
// in Phase 3 — both routers now live under
// `src/contexts/security/http/` and are produced by `composeSecurity`.
// createAIRoutes was removed in Phase 4 — the AI router lives at
// `src/contexts/ai/http/routes.ts` and is produced by `composeAI`.

function createDashboardRoutes(service: DashboardService): express.Router {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    try {
      const dashboards = await service.getAllDashboards();
      res.json({ success: true, data: dashboards });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const dashboard = await service.getDashboard(req.params.id);
      if (!dashboard) {
        res.status(404).json({
          success: false,
          error: 'Dashboard not found',
        });
        return;
      }
      res.json({ success: true, data: dashboard });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const dashboard = await service.createDashboard(req.body);
      res.status(201).json({ success: true, data: dashboard });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.get('/widget/:id/data', async (req, res) => {
    try {
      const data = await service.getWidgetData(req.params.id);
      res.json({ success: true, data });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}

// Initialize services
async function initializeServices() {
  try {
    // ADR-0020 boot ordering: dial Redis + Mongo *before* flipping
    // `startupComplete`. If either is unreachable we throw and the
    // process supervisor handles it; readiness stays at 503 in the
    // meantime.
    await connectAndPing(redisClient);
    await mongoose.connect(config.database.mongodb.uri, {
      dbName: config.database.mongodb.name,
      maxPoolSize: config.database.mongodb.maxPoolSize,
      minPoolSize: config.database.mongodb.minPoolSize,
      serverSelectionTimeoutMS:
        config.database.mongodb.serverSelectionTimeoutMS,
      socketTimeoutMS: config.database.mongodb.socketTimeoutMS,
    });
    logger.info('Mongo + Redis connected');

    await Promise.all([
      discoveryService.initialize(),
      securityService.initialize(),
      dashboardService.initialize(),
      // Performance context (DDD-09) is self-bootstrapping via composePerformance().
      complianceService.initialize(),
    ]);

    // Phase 3: ensure SecurityPolicy rows exist for every builtin
    // check. Idempotent — runs once per pod boot.
    try {
      await securityService.seedBuiltinPolicies();
    } catch (err) {
      logger.warn('failed to seed builtin security policies', {
        err: err instanceof Error ? err.message : String(err),
      });
    }

    // Discovery scheduler — kicks off the periodic scan loop.
    // Disabled when DISCOVERY_SERVICE_ENABLED=false so unit tests and
    // local dev don't hammer the apiserver.
    if (config.services.discovery.enabled) {
      discoveryScheduler.start(config.services.discovery.scanInterval);
    }

    logger.info('All services initialized successfully');
    logger.info(
      'Phase 3 Production Ready - Advanced AI, Performance Testing, and Compliance Framework enabled'
    );

    // ADR-0020: only flip readiness once every dependency has finished
    // bootstrapping. Until this point `/health/ready` returns 503 and the
    // load balancer keeps the pod out of rotation.
    startupComplete = true;
  } catch (error) {
    logger.error('Failed to initialize services', error);
    throw error;
  }
}

// Start server
async function startServer() {
  try {
    await initializeServices();

    app.listen(config.app.port, () => {
      logger.info(`NOIP Platform started on port ${config.app.port}`);
      logger.info(`Environment: ${config.app.environment}`);
      logger.info(`Version: ${config.app.version}`);
    });
  } catch (error) {
    logger.error('Failed to start server', error);
    process.exit(1);
  }
}

// Graceful shutdown (ADR-0020).
// Flip `shuttingDown` first so `/health/ready` immediately returns 503 and
// the load balancer drains us before we tear down the underlying services.
async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down gracefully`);
  shuttingDown = true;

  // Detach audit + permission-invalidation + security subscribers so
  // any in-flight publishes during teardown don't try to hit a
  // torn-down Mongo connection.
  for (const unsubscribe of [
    ...auditSubscriberHandles,
    ...permissionInvalidationHandles,
    ...securitySubscriptions,
    ...aiSubscriptions,
  ]) {
    try {
      unsubscribe();
    } catch (err) {
      logger.warn('Failed to unsubscribe handler', { err });
    }
  }

  // Discovery scheduler must stop before the service does so a
  // concurrent tick can't fire after we tear down the bus / repos.
  try {
    discoveryScheduler.stop();
  } catch (err) {
    logger.warn('Failed to stop discovery scheduler', { err });
  }
  await Promise.all([discoveryService.stop(), securityService.stop()]);

  // ADR-0005 + ADR-0020: close shared infra last so subscribers / stop()
  // hooks above can still write final audit entries.
  try {
    await redisClient.quit();
  } catch (err) {
    logger.warn('Failed to quit redis client', { err });
  }
  try {
    await mongoose.disconnect();
  } catch (err) {
    logger.warn('Failed to disconnect mongoose', { err });
  }

  process.exit(0);
}

process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void gracefulShutdown('SIGINT');
});

// Start server if this file is run directly
if (require.main === module) {
  startServer();
}

export default app;
export { startServer, initializeServices };
