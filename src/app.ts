import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import morgan from 'morgan';
import { config } from './config';
import logger from './utils/logger';
import { DiscoveryService } from './services/discovery.service';
import { SecurityService } from './services/security.service';
import { AIService } from './services/ai.service';
import { DashboardService } from './services/dashboard.service';
import { PerformanceService } from './services/performance.service';
import { ComplianceService } from './services/compliance.service';

// Import route handlers
import performanceRoutes from './routes/performance.routes';
import complianceRoutes from './routes/compliance.routes';
import { createHealthRoutes } from './routes/health.routes';

const app = express();

// Initialize services
const discoveryService = new DiscoveryService();
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
app.use(createHealthRoutes({
  isStartupComplete: () => startupComplete,
  isLive: () => !shuttingDown,
  // TODO: once shared Mongo / Redis clients are wired in, ping them here.
  // For now readiness only reflects bootstrap + shutdown state.
  isReady: async () => startupComplete && !shuttingDown,
  composite: async () => {
    const [discoveryHealth, securityHealth, aiHealth, dashboardHealth, performanceHealth, complianceHealth] = await Promise.all([
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
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: config.security.rateLimit.windowMs,
  max: config.security.rateLimit.max,
  message: { error: 'Too many requests from this IP' },
});
app.use(limiter);

// Logging
if (config.app.environment !== 'test') {
  app.use(morgan('combined', {
    stream: {
      write: (message: string) => logger.info(message.trim()),
    },
  }));
}

// API Routes
app.use('/api/discovery', createDiscoveryRoutes(discoveryService));
app.use('/api/security', createSecurityRoutes(securityService));
app.use('/api/ai', createAIRoutes(aiService));
app.use('/api/dashboard', createDashboardRoutes(dashboardService));
app.use('/api/performance', performanceRoutes);
app.use('/api/compliance', complianceRoutes);

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error', err);

  res.status(500).json({
    error: 'Internal server error',
    timestamp: new Date(),
    requestId: req.headers['x-request-id'] || 'unknown',
  });
});

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
function createDiscoveryRoutes(service: DiscoveryService): express.Router {
  const router = express.Router();

  router.get('/cluster', async (_req, res) => {
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

  router.get('/namespaces', async (_req, res) => {
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

  router.get('/nodes', async (_req, res) => {
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
    await Promise.all([
      discoveryService.initialize(),
      securityService.initialize(),
      aiService.initialize(),
      dashboardService.initialize(),
      performanceService.initialize(),
      complianceService.initialize(),
    ]);

    logger.info('All services initialized successfully');
    logger.info('Phase 3 Production Ready - Advanced AI, Performance Testing, and Compliance Framework enabled');

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
process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down gracefully');
  shuttingDown = true;

  await Promise.all([
    discoveryService.stop(),
    securityService.stop(),
  ]);

  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down gracefully');
  shuttingDown = true;

  await Promise.all([
    discoveryService.stop(),
    securityService.stop(),
  ]);

  process.exit(0);
});

// Start server if this file is run directly
if (require.main === module) {
  startServer();
}

export default app;
export { startServer, initializeServices };