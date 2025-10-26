import { Migration } from './migration';

export const initialSchemaMigration: Migration = {
  id: '001_initial_schema',
  name: 'Initial Database Schema',
  version: '1.0.0',
  description: 'Create initial collections and indexes for NOIP platform',
  dependencies: [],

  async up(db) {
    // Users collection
    await db.createCollection('users');
    await db.collection('users').createIndexes([
      { key: { email: 1 }, unique: true },
      { key: { username: 1 }, unique: true },
      { key: { roles: 1 } },
      { key: { createdAt: 1 } },
      { key: { lastLoginAt: 1 } },
      { key: { isActive: 1 } },
    ]);

    // User sessions collection
    await db.createCollection('user_sessions');
    await db.collection('user_sessions').createIndexes([
      { key: { userId: 1 } },
      { key: { token: 1 }, unique: true },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
      { key: { createdAt: 1 } },
      { key: { lastAccessedAt: 1 } },
    ]);

    // Infrastructure scans collection
    await db.createCollection('infrastructure_scans');
    await db.collection('infrastructure_scans').createIndexes([
      { key: { scanId: 1 }, unique: true },
      { key: { type: 1 } },
      { key: { status: 1 } },
      { key: { createdAt: 1 } },
      { key: { clusterId: 1 } },
      { key: { namespace: 1 } },
    ]);

    // Security scan results collection
    await db.createCollection('security_scans');
    await db.collection('security_scans').createIndexes([
      { key: { scanId: 1 }, unique: true },
      { key: { severity: 1 } },
      { key: { category: 1 } },
      { key: { status: 1 } },
      { key: { createdAt: 1 } },
      { key: { resourceIds: 1 } },
      { key: { clusterId: 1 } },
    ]);

    // AI analysis results collection
    await db.createCollection('ai_analysis');
    await db.collection('ai_analysis').createIndexes([
      { key: { analysisId: 1 }, unique: true },
      { key: { type: 1 } },
      { key: { scanId: 1 } },
      { key: { createdAt: 1 } },
      { key: { confidence: 1 } },
      { key: { clusterId: 1 } },
    ]);

    // Dashboard configurations collection
    await db.createCollection('dashboards');
    await db.collection('dashboards').createIndexes([
      { key: { dashboardId: 1 }, unique: true },
      { key: { userId: 1 } },
      { key: { name: 1 } },
      { key: { isPublic: 1 } },
      { key: { createdAt: 1 } },
      { key: { updatedAt: 1 } },
    ]);

    // Widget configurations collection
    await db.createCollection('widgets');
    await db.collection('widgets').createIndexes([
      { key: { widgetId: 1 }, unique: true },
      { key: { dashboardId: 1 } },
      { key: { type: 1 } },
      { key: { position: 1 } },
      { key: { createdAt: 1 } },
    ]);

    // Audit logs collection
    await db.createCollection('audit_logs');
    await db.collection('audit_logs').createIndexes([
      { key: { logId: 1 }, unique: true },
      { key: { userId: 1 } },
      { key: { action: 1 } },
      { key: { resource: 1 } },
      { key: { timestamp: 1 } },
      { key: { severity: 1 } },
      { key: { ipAddress: 1 } },
      { key: { userAgent: 1 } },
    ]);

    // System configuration collection
    await db.createCollection('system_config');
    await db.collection('system_config').createIndexes([
      { key: { key: 1 }, unique: true },
      { key: { category: 1 } },
      { key: { isPublic: 1 } },
      { key: { updatedAt: 1 } },
    ]);

    // Cluster information collection
    await db.createCollection('clusters');
    await db.collection('clusters').createIndexes([
      { key: { clusterId: 1 }, unique: true },
      { key: { name: 1 } },
      { key: { endpoint: 1 } },
      { key: { status: 1 } },
      { key: { lastScanAt: 1 } },
      { key: { createdAt: 1 } },
    ]);

    // Performance metrics collection
    await db.createCollection('performance_metrics');
    await db.collection('performance_metrics').createIndexes([
      { key: { metricId: 1 }, unique: true },
      { key: { type: 1 } },
      { key: { clusterId: 1 } },
      { key: { timestamp: 1 } },
      { key: { source: 1 } },
      // TTL index for automatic cleanup after 90 days
      { key: { timestamp: 1 }, expireAfterSeconds: 90 * 24 * 60 * 60 },
    ]);

    // Alerts collection
    await db.createCollection('alerts');
    await db.collection('alerts').createIndexes([
      { key: { alertId: 1 }, unique: true },
      { key: { severity: 1 } },
      { key: { status: 1 } },
      { key: { type: 1 } },
      { key: { clusterId: 1 } },
      { key: { createdAt: 1 } },
      { key: { resolvedAt: 1 } },
    ]);

    // API keys collection
    await db.createCollection('api_keys');
    await db.collection('api_keys').createIndexes([
      { key: { keyId: 1 }, unique: true },
      { key: { keyHash: 1 }, unique: true },
      { key: { userId: 1 } },
      { key: { name: 1 } },
      { key: { permissions: 1 } },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
      { key: { createdAt: 1 } },
      { key: { lastUsedAt: 1 } },
    ]);

    // Create default system configuration
    await db.collection('system_config').insertMany([
      {
        key: 'security.scan_interval',
        value: 300000, // 5 minutes in milliseconds
        category: 'security',
        description: 'Security scan interval in milliseconds',
        isPublic: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        key: 'discovery.scan_interval',
        value: 60000, // 1 minute in milliseconds
        category: 'discovery',
        description: 'Discovery scan interval in milliseconds',
        isPublic: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        key: 'ai.max_tokens',
        value: 4000,
        category: 'ai',
        description: 'Maximum tokens for AI analysis',
        isPublic: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        key: 'dashboard.default_refresh_interval',
        value: 30000, // 30 seconds in milliseconds
        category: 'dashboard',
        description: 'Default dashboard refresh interval',
        isPublic: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        key: 'system.version',
        value: '1.0.0',
        category: 'system',
        description: 'Current system version',
        isPublic: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    // Create default admin user (placeholder - should be created during setup)
    await db.collection('users').insertOne({
      userId: 'admin',
      email: 'admin@noip.local',
      username: 'admin',
      passwordHash: '$2b$10$placeholder_hash_change_me', // This should be set during initial setup
      roles: ['admin', 'user'],
      permissions: ['read', 'write', 'delete', 'admin'],
      profile: {
        firstName: 'System',
        lastName: 'Administrator',
        department: 'IT',
        position: 'System Administrator',
      },
      preferences: {
        theme: 'light',
        timezone: 'UTC',
        language: 'en',
        notifications: {
          email: true,
          inApp: true,
          security: true,
        },
      },
      isActive: true,
      isEmailVerified: true,
      lastLoginAt: null,
      passwordChangedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    console.log('Initial database schema created successfully');
  },

  async down(db) {
    // Drop all collections in reverse order of dependencies
    const collections = [
      'api_keys',
      'alerts',
      'performance_metrics',
      'clusters',
      'system_config',
      'audit_logs',
      'widgets',
      'dashboards',
      'ai_analysis',
      'security_scans',
      'infrastructure_scans',
      'user_sessions',
      'users',
    ];

    for (const collectionName of collections) {
      try {
        await db.collection(collectionName).drop();
        console.log(`Dropped collection: ${collectionName}`);
      } catch (error) {
        console.warn(`Collection ${collectionName} does not exist or could not be dropped:`, error);
      }
    }

    console.log('Initial database schema rollback completed');
  },
};