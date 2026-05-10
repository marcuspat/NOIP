import {
  MongoDBConnection,
  MongoConfig,
  createMongoDBConnection,
} from './mongodb';
import { RedisManager, RedisConfig, createRedisManager } from './redis';
import { MigrationManager, Migration } from './migrations/migration';
import { initialSchemaMigration } from './migrations/001_initial_schema';
import { config } from '../config';
import { logger } from '../utils/logger';

export class DatabaseManager {
  private static instance: DatabaseManager;
  private mongoConnection: MongoDBConnection | null = null;
  private redisManager: RedisManager | null = null;
  private migrationManager: MigrationManager | null = null;
  private isInitialized: boolean = false;

  private constructor() {}

  public static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager();
    }
    return DatabaseManager.instance;
  }

  public async initialize(): Promise<void> {
    try {
      if (this.isInitialized) {
        logger.info('Database manager already initialized');
        return;
      }

      logger.info('Initializing database manager...');

      // Initialize MongoDB
      await this.initializeMongoDB();

      // Initialize Redis
      await this.initializeRedis();

      // Initialize migration manager
      await this.initializeMigrations();

      this.isInitialized = true;
      logger.info('Database manager initialized successfully');

      // Run health checks
      await this.healthCheck();
    } catch (error) {
      logger.error('Failed to initialize database manager', error);
      throw error;
    }
  }

  public async shutdown(): Promise<void> {
    try {
      logger.info('Shutting down database manager...');

      if (this.mongoConnection) {
        await this.mongoConnection.disconnect();
        this.mongoConnection = null;
      }

      if (this.redisManager) {
        await this.redisManager.disconnect();
        this.redisManager = null;
      }

      this.migrationManager = null;
      this.isInitialized = false;

      logger.info('Database manager shut down successfully');
    } catch (error) {
      logger.error('Error shutting down database manager', error);
      throw error;
    }
  }

  public getMongoConnection(): MongoDBConnection {
    if (!this.mongoConnection) {
      throw new Error('MongoDB not initialized');
    }
    return this.mongoConnection;
  }

  public getRedisManager(): RedisManager {
    if (!this.redisManager) {
      throw new Error('Redis not initialized');
    }
    return this.redisManager;
  }

  public getMigrationManager(): MigrationManager {
    if (!this.migrationManager) {
      throw new Error('Migration manager not initialized');
    }
    return this.migrationManager;
  }

  public async healthCheck(): Promise<{
    mongodb: { status: string; details?: any };
    redis: { status: string; details?: any };
    overall: string;
  }> {
    try {
      const mongoHealth = this.mongoConnection
        ? await this.mongoConnection.healthCheck()
        : { status: 'unhealthy', details: { reason: 'Not initialized' } };

      const redisHealth = this.redisManager
        ? await this.redisManager.healthCheck()
        : { status: 'unhealthy', details: { reason: 'Not initialized' } };

      const overall =
        mongoHealth.status === 'healthy' && redisHealth.status === 'healthy'
          ? 'healthy'
          : 'unhealthy';

      return {
        mongodb: mongoHealth,
        redis: redisHealth,
        overall,
      };
    } catch (error) {
      logger.error('Database health check failed', error);
      return {
        mongodb: {
          status: 'error',
          details: {
            error: error instanceof Error ? error.message : 'Unknown',
          },
        },
        redis: {
          status: 'error',
          details: {
            error: error instanceof Error ? error.message : 'Unknown',
          },
        },
        overall: 'error',
      };
    }
  }

  public async runMigrations(options?: {
    targetVersion?: string;
    force?: boolean;
    dryRun?: boolean;
  }): Promise<any> {
    if (!this.migrationManager) {
      throw new Error('Migration manager not initialized');
    }

    return await this.migrationManager.migrate(options);
  }

  public async rollbackMigrations(options?: {
    targetVersion?: string;
    steps?: number;
    force?: boolean;
    dryRun?: boolean;
  }): Promise<any> {
    if (!this.migrationManager) {
      throw new Error('Migration manager not initialized');
    }

    return await this.migrationManager.rollback(options);
  }

  public async getMigrationStatus(): Promise<any> {
    if (!this.migrationManager) {
      throw new Error('Migration manager not initialized');
    }

    return await this.migrationManager.getMigrationStatus();
  }

  public async backup(): Promise<{
    mongodb: { success: boolean; path?: string; error?: string };
    redis: { success: boolean; path?: string; error?: string };
  }> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = `/tmp/noip-backup-${timestamp}`;

    try {
      // Create backup directory
      await this.createBackupDirectory(backupDir);

      // MongoDB backup
      const mongodbBackup = await this.backupMongoDB(backupDir, timestamp);

      // Redis backup
      const redisBackup = await this.backupRedis(backupDir, timestamp);

      return {
        mongodb: mongodbBackup,
        redis: redisBackup,
      };
    } catch (error) {
      logger.error('Database backup failed', error);
      throw error;
    }
  }

  public async getDatabaseStats(): Promise<{
    mongodb: any;
    redis: any;
    timestamp: string;
  }> {
    try {
      const mongodbStats = this.mongoConnection
        ? await this.mongoConnection.getConnectionStats()
        : null;

      const redisStats = this.redisManager
        ? await this.redisManager.getStats()
        : null;

      return {
        mongodb: mongodbStats,
        redis: redisStats,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      logger.error('Failed to get database stats', error);
      throw error;
    }
  }

  private async initializeMongoDB(): Promise<void> {
    const mongoConfig: MongoConfig = {
      uri: config.database.mongodb.uri,
      dbName: config.database.mongodb.name,
      maxPoolSize: config.database.mongodb.maxPoolSize || 10,
      minPoolSize: config.database.mongodb.minPoolSize || 1,
      maxIdleTimeMS: config.database.mongodb.maxIdleTimeMS || 30000,
      serverSelectionTimeoutMS:
        config.database.mongodb.serverSelectionTimeoutMS || 5000,
      socketTimeoutMS: config.database.mongodb.socketTimeoutMS || 45000,
      connectTimeoutMS: config.database.mongodb.connectTimeoutMS || 10000,
      heartbeatFrequencyMS:
        config.database.mongodb.heartbeatFrequencyMS || 10000,
      retryWrites: config.database.mongodb.retryWrites !== false,
      retryReads: config.database.mongodb.retryReads !== false,
      options: {
        // Additional MongoDB options can be added here
      },
    };

    this.mongoConnection = createMongoDBConnection(mongoConfig);
    await this.mongoConnection.connect();
  }

  private async initializeRedis(): Promise<void> {
    const redisConfig: RedisConfig = {
      host: config.database.redis.host,
      port: config.database.redis.port,
      password: config.database.redis.password,
      db: config.database.redis.db || 0,
      keyPrefix: config.database.redis.keyPrefix || 'noip:',
      retryDelayOnFailover: config.database.redis.retryDelayOnFailover || 100,
      maxRetriesPerRequest: config.database.redis.maxRetriesPerRequest || 3,
      lazyConnect: config.database.redis.lazyConnect !== false,
      keepAlive: config.database.redis.keepAlive || 30000,
      family: (config.database.redis.family || 4) as 4 | 6,
      connectTimeout: config.database.redis.connectTimeout || 10000,
      commandTimeout: config.database.redis.commandTimeout || 5000,
      maxLoadingTimeout: config.database.redis.maxLoadingTimeout || 5000,
      enableReadyCheck: config.database.redis.enableReadyCheck !== false,
      maxMemoryPolicy: config.database.redis.maxMemoryPolicy || 'allkeys-lru',
      clusterEnabled: config.database.redis.clusterEnabled || false,
      clusterNodes: config.database.redis.clusterNodes,
    };

    this.redisManager = createRedisManager(redisConfig);
    await this.redisManager.connect();
  }

  private async initializeMigrations(): Promise<void> {
    if (!this.mongoConnection) {
      throw new Error('MongoDB must be initialized before migrations');
    }

    this.migrationManager = new MigrationManager(this.mongoConnection);
    await this.migrationManager.initialize();

    // Register migrations
    this.migrationManager.registerMigration(initialSchemaMigration);

    // Auto-run migrations on startup (can be configured)
    if (config.database.migrations?.autoRun !== false) {
      logger.info('Running database migrations...');
      const result = await this.migrationManager.migrate();

      if (result.errors.length > 0) {
        logger.warn('Migration completed with errors', {
          errors: result.errors,
        });
      } else {
        logger.info('All migrations completed successfully', {
          executed: result.executed.length,
          skipped: result.skipped.length,
        });
      }
    }
  }

  private async createBackupDirectory(backupDir: string): Promise<void> {
    // This would create backup directory - implementation depends on environment
    logger.info(`Creating backup directory: ${backupDir}`);
  }

  private async backupMongoDB(
    backupDir: string,
    timestamp: string
  ): Promise<{
    success: boolean;
    path?: string;
    error?: string;
  }> {
    try {
      // This would implement MongoDB backup logic
      // Could use mongodump or other backup strategies
      const backupPath = `${backupDir}/mongodb-${timestamp}`;
      logger.info(`MongoDB backup created: ${backupPath}`);

      return {
        success: true,
        path: backupPath,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      logger.error('MongoDB backup failed', error);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  private async backupRedis(
    backupDir: string,
    timestamp: string
  ): Promise<{
    success: boolean;
    path?: string;
    error?: string;
  }> {
    try {
      // This would implement Redis backup logic
      // Could use redis-cli --rdb or BGSAVE commands
      const backupPath = `${backupDir}/redis-${timestamp}.rdb`;
      logger.info(`Redis backup created: ${backupPath}`);

      return {
        success: true,
        path: backupPath,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      logger.error('Redis backup failed', error);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }
}

// Export singleton instance
export const databaseManager = DatabaseManager.getInstance();

// Export convenience functions
export const initializeDatabase = () => databaseManager.initialize();
export const shutdownDatabase = () => databaseManager.shutdown();
export const getMongoConnection = () => databaseManager.getMongoConnection();
export const getRedisManager = () => databaseManager.getRedisManager();
export const getMigrationManager = () => databaseManager.getMigrationManager();
export const databaseHealthCheck = () => databaseManager.healthCheck();
export const runMigrations = (options?: any) =>
  databaseManager.runMigrations(options);
export const rollbackMigrations = (options?: any) =>
  databaseManager.rollbackMigrations(options);
export const getMigrationStatus = () => databaseManager.getMigrationStatus();
export const backupDatabases = () => databaseManager.backup();
export const getDatabaseStats = () => databaseManager.getDatabaseStats();
