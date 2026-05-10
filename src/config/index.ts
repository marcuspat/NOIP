import dotenv from 'dotenv';

dotenv.config();

export const config = {
  // Application
  app: {
    name: 'NOIP Platform',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT || '3000'),
    logLevel: process.env.LOG_LEVEL || 'info',
  },
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',

  // Services
  services: {
    auth: {
      enabled: process.env.AUTH_SERVICE_ENABLED !== 'false',
      tokenRotationInterval: parseInt(
        process.env.TOKEN_ROTATION_INTERVAL || '3600000'
      ), // 1 hour
      sessionTimeout: parseInt(process.env.SESSION_TIMEOUT || '86400000'), // 24 hours
      maxConcurrentSessions: parseInt(
        process.env.MAX_CONCURRENT_SESSIONS || '5'
      ),
      passwordExpiryDays: parseInt(process.env.PASSWORD_EXPIRY_DAYS || '90'),
      accountLockoutAttempts: parseInt(
        process.env.ACCOUNT_LOCKOUT_ATTEMPTS || '5'
      ),
      accountLockoutDuration: parseInt(
        process.env.ACCOUNT_LOCKOUT_DURATION || '7200000'
      ), // 2 hours
      mfaGracePeriod: parseInt(process.env.MFA_GRACE_PERIOD || '604800000'), // 7 days
    },
    discovery: {
      enabled: process.env.DISCOVERY_SERVICE_ENABLED !== 'false',
      scanInterval: parseInt(process.env.SCAN_INTERVAL || '300000'), // 5 minutes
      k8sEndpoint: process.env.K8S_ENDPOINT || 'http://localhost:8080',
    },
    security: {
      enabled: process.env.SECURITY_SERVICE_ENABLED !== 'false',
      scanInterval: parseInt(process.env.SECURITY_SCAN_INTERVAL || '600000'), // 10 minutes
      rulesPath:
        process.env.SECURITY_RULES_PATH || './config/security-rules.json',
    },
    ai: {
      enabled: process.env.AI_SERVICE_ENABLED !== 'false',
      apiKey: process.env.AI_API_KEY || '',
      endpoint: process.env.AI_ENDPOINT || 'https://api.anthropic.com',
      maxTokens: parseInt(process.env.AI_MAX_TOKENS || '4000'),
    },
    performance: {
      enabled: process.env.PERFORMANCE_SERVICE_ENABLED !== 'false',
      defaultConcurrency: parseInt(
        process.env.PERF_DEFAULT_CONCURRENCY || '10'
      ),
      defaultDurationSec: parseInt(
        process.env.PERF_DEFAULT_DURATION || '60'
      ),
      retentionDays: parseInt(process.env.PERF_RETENTION_DAYS || '30'),
    },
  },

  // Database
  database: {
    mongodb: {
      uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/noip',
      name: process.env.MONGODB_NAME || 'noip',
      maxPoolSize: parseInt(process.env.MONGODB_MAX_POOL_SIZE || '10'),
      minPoolSize: parseInt(process.env.MONGODB_MIN_POOL_SIZE || '1'),
      maxIdleTimeMS: parseInt(process.env.MONGODB_MAX_IDLE_TIME || '30000'),
      serverSelectionTimeoutMS: parseInt(
        process.env.MONGODB_SERVER_SELECTION_TIMEOUT || '5000'
      ),
      socketTimeoutMS: parseInt(process.env.MONGODB_SOCKET_TIMEOUT || '45000'),
      connectTimeoutMS: parseInt(
        process.env.MONGODB_CONNECT_TIMEOUT || '10000'
      ),
      heartbeatFrequencyMS: parseInt(
        process.env.MONGODB_HEARTBEAT_FREQUENCY || '10000'
      ),
      retryWrites: process.env.MONGODB_RETRY_WRITES !== 'false',
      retryReads: process.env.MONGODB_RETRY_READS !== 'false',
      bufferMaxEntries: parseInt(process.env.MONGODB_BUFFER_MAX_ENTRIES || '0'),
      bufferCommands: process.env.MONGODB_BUFFER_COMMANDS !== 'false',
    },
    redis: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD || '',
      db: parseInt(process.env.REDIS_DB || '0'),
      keyPrefix: process.env.REDIS_KEY_PREFIX || 'noip:',
      retryDelayOnFailover: parseInt(process.env.REDIS_RETRY_DELAY || '100'),
      maxRetriesPerRequest: parseInt(process.env.REDIS_MAX_RETRIES || '3'),
      lazyConnect: process.env.REDIS_LAZY_CONNECT !== 'false',
      keepAlive: parseInt(process.env.REDIS_KEEP_ALIVE || '30000'),
      family: parseInt(process.env.REDIS_FAMILY || '4'),
      connectTimeout: parseInt(process.env.REDIS_CONNECT_TIMEOUT || '10000'),
      commandTimeout: parseInt(process.env.REDIS_COMMAND_TIMEOUT || '5000'),
      maxLoadingTimeout: parseInt(
        process.env.REDIS_MAX_LOADING_TIMEOUT || '5000'
      ),
      enableReadyCheck: process.env.REDIS_ENABLE_READY_CHECK !== 'false',
      maxMemoryPolicy: process.env.REDIS_MAX_MEMORY_POLICY || 'allkeys-lru',
      clusterEnabled: process.env.REDIS_CLUSTER_ENABLED === 'true',
      clusterNodes: process.env.REDIS_CLUSTER_NODES
        ? JSON.parse(process.env.REDIS_CLUSTER_NODES)
        : undefined,
    },
    migrations: {
      autoRun: process.env.MIGRATIONS_AUTO_RUN !== 'false',
      lockTimeout: parseInt(process.env.MIGRATIONS_LOCK_TIMEOUT || '300000'), // 5 minutes
      maxRetries: parseInt(process.env.MIGRATIONS_MAX_RETRIES || '3'),
    },
  },

  // Security
  security: {
    jwt: {
      secret: process.env.JWT_SECRET || 'your-secret-key-change-in-production',
      accessTokenExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
      refreshTokenExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
      algorithm: 'HS256',
      issuer: process.env.JWT_ISSUER || 'NOIP Platform',
      audience: process.env.JWT_AUDIENCE || 'noip-client',
    },
    password: {
      minLength: parseInt(process.env.PASSWORD_MIN_LENGTH || '8'),
      requireUppercase: process.env.PASSWORD_REQUIRE_UPPERCASE !== 'false',
      requireLowercase: process.env.PASSWORD_REQUIRE_LOWERCASE !== 'false',
      requireNumbers: process.env.PASSWORD_REQUIRE_NUMBERS !== 'false',
      requireSpecialChars: process.env.PASSWORD_REQUIRE_SPECIAL !== 'false',
      preventReuse: parseInt(process.env.PASSWORD_PREVENT_REUSE || '5'),
      maxAge: parseInt(process.env.PASSWORD_MAX_AGE || '7776000000'), // 90 days in ms
    },
    mfa: {
      totpWindow: parseInt(process.env.MFA_TOTP_WINDOW || '2'),
      smsCodeLength: parseInt(process.env.MFA_SMS_CODE_LENGTH || '6'),
      emailCodeLength: parseInt(process.env.MFA_EMAIL_CODE_LENGTH || '6'),
      backupCodeCount: parseInt(process.env.MFA_BACKUP_CODE_COUNT || '10'),
      codeExpiry: parseInt(process.env.MFA_CODE_EXPIRY || '300000'), // 5 minutes
    },
    rateLimit: {
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW || '900000'), // 15 minutes
      max: parseInt(process.env.RATE_LIMIT_MAX || '100'),
      authWindowMs: parseInt(process.env.RATE_LIMIT_AUTH_WINDOW || '900000'), // 15 minutes
      authMax: parseInt(process.env.RATE_LIMIT_AUTH_MAX || '5'),
      passwordResetWindowMs: parseInt(
        process.env.RATE_LIMIT_PASSWORD_RESET_WINDOW || '3600000'
      ), // 1 hour
      passwordResetMax: parseInt(
        process.env.RATE_LIMIT_PASSWORD_RESET_MAX || '3'
      ),
      mfaWindowMs: parseInt(process.env.RATE_LIMIT_MFA_WINDOW || '300000'), // 5 minutes
      mfaMax: parseInt(process.env.RATE_LIMIT_MFA_MAX || '10'),
    },
    audit: {
      logLevel: process.env.AUDIT_LOG_LEVEL || 'detailed',
      maxBodySize: parseInt(process.env.AUDIT_MAX_BODY_SIZE || '10240'),
      retentionDays: parseInt(process.env.AUDIT_RETENTION_DAYS || '365'),
    },
    headers: {
      enableHSTS: process.env.ENABLE_HSTS !== 'false',
      enableCSP: process.env.ENABLE_CSP !== 'false',
      enableXFrameOptions: process.env.ENABLE_XFRAME !== 'false',
      enableXContentType: process.env.ENABLE_XCONTENT !== 'false',
    },
    cors: {
      enabled: process.env.CORS_ENABLED !== 'false',
      origins: process.env.CORS_ORIGINS
        ? process.env.CORS_ORIGINS.split(',')
        : ['http://localhost:3000'],
      credentials: process.env.CORS_CREDENTIALS !== 'false',
    },
  },

  // Monitoring
  monitoring: {
    enabled: process.env.MONITORING_ENABLED !== 'false',
    metricsEndpoint: process.env.METRICS_ENDPOINT || '/metrics',
    healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL || '30000'),
  },

  // Development
  development: {
    hotReload: process.env.HOT_RELOAD === 'true',
    debugMode: process.env.DEBUG_MODE === 'true',
    mockData: process.env.MOCK_DATA === 'true',
  },
};

export default config;
