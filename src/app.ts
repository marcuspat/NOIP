import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import type { Redis } from 'ioredis';
import { config } from './config';
import logger from './utils/logger';
import { correlationMiddleware } from './middleware/correlation.middleware';
import { buildGlobalLimiter, buildAuthLimiter } from './utils/rate-limiter';
import { SessionCache, bindDefaultSessionCache } from './services/session-cache.service';
import { DiscoveryService } from './services/discovery.service';
import { SecurityService } from './services/security.service';
import { AIService } from './services/ai.service';
import { DashboardService } from './services/dashboard.service';
import { PerformanceService } from './services/performance.service';
import { ComplianceService } from './services/compliance.service';

// Import route handlers
import performanceRoutes from './routes/performance.routes';
import complianceRoutes from './routes/compliance.routes';
import authRoutes from './routes/auth.routes';

const app = express();

// Initialize services
const discoveryService = new DiscoveryService();
const securityService = new SecurityService();
const aiService = new AIService();
const dashboardService = new DashboardService();
const performanceService = new PerformanceService();
const complianceService = new ComplianceService();

// Correlation id MUST come before any logging or auditing middleware so the
// request lifetime is observable from the very first log line.
// Per ADR-0015.
app.use(correlationMiddleware());

// Middleware
app.use(helmet());
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting — Redis-backed per ADR-0014. The Redis handle is plumbed
// in by the bootstrap (src/index.ts) via `attachRateLimiters(app, redis)`;
// during tests `redis` is null and limiters fall back to in-memory with a
// loud warning.
let activeRedisClient: Redis | null = null;
export function attachRateLimiters(redis: Redis | null): void {
  activeRedisClient = redis;
  app.use(buildGlobalLimiter(redis));
  // The stricter /auth budget is mounted directly against /api/v1/auth so
  // it sees auth-only traffic (login, refresh, MFA challenge).
  app.use('/api/v1/auth', buildAuthLimiter(redis));
  app.use('/api/auth', buildAuthLimiter(redis));
}

// If the host hasn't called attachRateLimiters() by the time the first
// request lands (e.g. in unit tests), apply the in-memory fallback now.
app.use((req, res, next) => {
  if (activeRedisClient === null && !(app as unknown as { _limitersAttached?: boolean })._limitersAttached) {
    (app as unknown as { _limitersAttached?: boolean })._limitersAttached = true;
    attachRateLimiters(null);
  }
  next();
});

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

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
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

    const health = {
      status: 'healthy',
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

    res.json(health);
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date(),
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// API Routes — canonical /api/v1 prefix per ADR-0020.
const v1 = express.Router();
v1.use('/discovery', createDiscoveryRoutes(discoveryService));
v1.use('/security', createSecurityRoutes(securityService));
v1.use('/ai', createAIRoutes(aiService));
v1.use('/dashboard', createDashboardRoutes(dashboardService));
v1.use('/performance', performanceRoutes);
v1.use('/compliance', complianceRoutes);
v1.use('/auth', authRoutes);
app.use('/api/v1', v1);

// Auth is also exposed at the unprefixed /auth path used by clients and the
// integration test harness.
app.use('/auth', authRoutes);

// Legacy unprefixed paths kept alive for one major-version cycle. Every
// response carries Deprecation + Sunset headers per RFC 8594 / RFC 9745.
const legacy = express.Router();
legacy.use((_req, res, next) => {
  res.setHeader('Deprecation', 'true');
  res.setHeader('Sunset', new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toUTCString());
  res.setHeader('Link', '</api/v1>; rel="successor-version"');
  next();
});
legacy.use('/discovery', createDiscoveryRoutes(discoveryService));
legacy.use('/security', createSecurityRoutes(securityService));
legacy.use('/ai', createAIRoutes(aiService));
legacy.use('/dashboard', createDashboardRoutes(dashboardService));
legacy.use('/performance', performanceRoutes);
legacy.use('/compliance', complianceRoutes);
legacy.use('/auth', authRoutes);
app.use('/api', legacy);

// 404 handler — Express 5 / path-to-regexp v8 rejects the bare '*' path,
// so we match all unhandled requests with a pathless middleware. Registered
// before the error handler so unmatched routes get a clean 404.
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.originalUrl,
    timestamp: new Date(),
  });
});

// Error handling middleware (must be last). Distinguishes client-side body
// parse failures (malformed JSON / oversized payloads) from server faults.
app.use(
  (
    err: Error & { type?: string; status?: number },
    req: express.Request,
    res: express.Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    next: express.NextFunction
  ) => {
    if (err.type === 'entity.parse.failed') {
      res.status(400).json({
        error: 'Invalid JSON in request body',
        timestamp: new Date(),
      });
      return;
    }
    if (err.type === 'entity.too.large') {
      res.status(413).json({
        error: 'Request body too large',
        timestamp: new Date(),
      });
      return;
    }

    logger.error('Unhandled error', err);
    res.status(500).json({
      error: 'Internal server error',
      timestamp: new Date(),
      requestId: req.headers['x-request-id'] || 'unknown',
    });
  }
);

// Route creators
function createDiscoveryRoutes(service: DiscoveryService): express.Router {
  const router = express.Router();

  router.get('/cluster', async (req, res) => {
    try {
      const clusterInfo = await service.scanCluster();
      res.json({ success: true, data: clusterInfo });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.get('/resources', async (req, res) => {
    try {
      const { namespace } = req.query;
      const resources = await service.getResources(namespace as string);
      res.json({ success: true, data: resources });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.get('/namespaces', async (req, res) => {
    try {
      const namespaces = await service.getNamespaces();
      res.json({ success: true, data: namespaces });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.get('/nodes', async (req, res) => {
    try {
      const nodes = await service.getNodeInfo();
      res.json({ success: true, data: nodes });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}

function createSecurityRoutes(service: SecurityService): express.Router {
  const router = express.Router();

  // Scanning accepts a resource list in the body, so it is a POST. A GET
  // alias is kept for backward compatibility with existing clients.
  const scanHandler = async (req: express.Request, res: express.Response) => {
    try {
      const { resources } = req.body ?? {};
      const results = await service.scanResources(resources || []);
      res.json({ success: true, data: results });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };
  router.post('/scan', scanHandler);
  router.get('/scan', scanHandler);

  router.get('/scan/pods', async (req, res) => {
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

  router.get('/scan/network', async (req, res) => {
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

  router.get('/score', async (req, res) => {
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

  router.get('/recommendations', async (req, res) => {
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

  router.get('/', async (req, res) => {
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
    await Promise.all([
      discoveryService.initialize(),
      securityService.initialize(),
      aiService.initialize(),
      dashboardService.initialize(),
      performanceService.initialize(),
      complianceService.initialize(),
    ]);

    logger.info('All services initialized successfully');
    logger.info(
      'Phase 3 Production Ready - Advanced AI, Performance Testing, and Compliance Framework enabled'
    );
  } catch (error) {
    logger.error('Failed to initialize services', error);
    throw error;
  }
}

// Start server
async function startServer() {
  try {
    // Connect MongoDB first — the durable store every service depends on.
    const mongoose = (await import('mongoose')).default;
    await mongoose.connect(config.database.mongodb.uri);
    logger.info('MongoDB connected', { uri: config.database.mongodb.uri });

    // Seed default roles and permissions (idempotent) so registration works.
    const { AuthService } = await import('./services/auth.service');
    await new AuthService().initialize();

    // Bootstrap Redis — optional; if unavailable we run without caching.
    let redisClient: Redis | null = null;
    try {
      const { Redis: IORedis } = await import('ioredis');
      const redisCfg = config.database.redis;
      const rc = new IORedis({
        host: redisCfg.host,
        port: redisCfg.port,
        password: redisCfg.password || undefined,
        db: redisCfg.db,
        keyPrefix: redisCfg.keyPrefix,
        maxRetriesPerRequest: redisCfg.maxRetriesPerRequest,
        lazyConnect: true,
      });
      await rc.connect();
      redisClient = rc;
      logger.info('Redis connected');
    } catch (err) {
      logger.warn('Redis unavailable — running without cache/rate-limit store', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Bind the process-wide session cache before services start.
    bindDefaultSessionCache(new SessionCache({ redis: redisClient }));

    // Attach Redis-backed rate limiters (falls back to in-memory if null).
    attachRateLimiters(redisClient);

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

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down gracefully');

  await Promise.all([discoveryService.stop(), securityService.stop()]);

  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down gracefully');

  await Promise.all([discoveryService.stop(), securityService.stop()]);

  process.exit(0);
});

// Start server if this file is run directly
if (require.main === module) {
  startServer();
}

/**
 * Returns the configured Express application. The app is a process singleton
 * (routes/middleware are wired once at module load), so this hands back that
 * instance — convenient for test harnesses that call `createApp().listen(0)`.
 */
export function createApp(): express.Application {
  return app;
}

export default app;
export { startServer, initializeServices };
