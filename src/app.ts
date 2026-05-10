import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import mongoose from 'mongoose';
import { config } from './config';
import logger from './utils/logger';
import {
  composeDiscovery,
  KubernetesAdapter,
  KubernetesClientFactory,
  type RawKubernetesClient,
} from './contexts/discovery/api';
import discoveryRoutes from './contexts/discovery/http/routes';
import { InMemoryRawKubernetesClient } from './contexts/discovery/infrastructure/kubernetes/in-memory-raw-client';
import { SecurityService } from './services/security.service';
import { AIService } from './services/ai.service';
import { DashboardService } from './services/dashboard.service';
import { PerformanceService } from './services/performance.service';
import { ComplianceService } from './services/compliance.service';
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

// Import route handlers
import performanceRoutes from './routes/performance.routes';
import complianceRoutes from './routes/compliance.routes';
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

// Initialize services
const securityService = new SecurityService();
const aiService = new AIService();
const dashboardService = new DashboardService();
const performanceService = new PerformanceService();
const complianceService = new ComplianceService();

// Middleware
app.use(helmet());
app.use(cors());
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
app.use('/api/security', createSecurityRoutes(securityService));
app.use('/api/ai', createAIRoutes(aiService));
app.use('/api/dashboard', createDashboardRoutes(dashboardService));
app.use('/api/performance', performanceRoutes);
app.use('/api/compliance', complianceRoutes);

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
// directly above. The legacy /cluster, /resources, /namespaces, /nodes
// paths are preserved as aliases inside that module so the existing
// integration suite keeps passing.
function createSecurityRoutes(service: SecurityService): express.Router {
  const router = express.Router();

  router.get('/scan', async (req, res) => {
    try {
      const { resources } = req.body;
      const results = await service.scanResources(resources || []);
      res.json({ success: true, data: results });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.get('/scan/pods', async (_req, res) => {
    try {
      const results = await service.scanPodSecurity();
      res.json({ success: true, data: results });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.get('/scan/network', async (_req, res) => {
    try {
      const results = await service.scanNetworkPolicies();
      res.json({ success: true, data: results });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.get('/score', async (_req, res) => {
    try {
      const score = await service.getSecurityScore();
      res.json({ success: true, data: { score } });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.get('/recommendations', async (_req, res) => {
    try {
      const recommendations = await service.getSecurityRecommendations();
      res.json({ success: true, data: recommendations });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}

function createAIRoutes(service: AIService): express.Router {
  const router = express.Router();

  router.post('/analyze/infrastructure', async (req, res) => {
    try {
      const { data } = req.body;
      const result = await service.analyzeInfrastructure(data);
      res.json({ success: true, data: result });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.post('/analyze/security', async (req, res) => {
    try {
      const { scanResults } = req.body;
      const result = await service.analyzeSecurity(scanResults);
      res.json({ success: true, data: result });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.post('/analyze/compliance', async (req, res) => {
    try {
      const { resources } = req.body;
      const result = await service.analyzeCompliance(resources);
      res.json({ success: true, data: result });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}

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
      aiService.initialize(),
      dashboardService.initialize(),
      performanceService.initialize(),
      complianceService.initialize(),
    ]);

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

  // Detach audit + permission-invalidation subscribers so any in-flight
  // publishes during teardown don't try to hit a torn-down Mongo connection.
  for (const unsubscribe of [
    ...auditSubscriberHandles,
    ...permissionInvalidationHandles,
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
