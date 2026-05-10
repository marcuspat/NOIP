import mongoose from 'mongoose';
import { logger } from '../utils/logger';

export interface MongoConfig {
  uri: string;
  dbName: string;
  options: mongoose.ConnectOptions;
  maxPoolSize?: number;
  minPoolSize?: number;
  maxIdleTimeMS?: number;
  serverSelectionTimeoutMS?: number;
  socketTimeoutMS?: number;
  connectTimeoutMS?: number;
  heartbeatFrequencyMS?: number;
  retryWrites?: boolean;
  retryReads?: boolean;
  bufferCommands?: boolean;
}

export class MongoDBConnection {
  private static instance: MongoDBConnection;
  private connection: mongoose.Connection | null = null;
  private config: MongoConfig;
  private isConnected: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectInterval: number = 5000; // 5 seconds

  private constructor(config: MongoConfig) {
    this.config = {
      ...config,
      options: {
        maxPoolSize: config.maxPoolSize || 10,
        minPoolSize: config.minPoolSize || 1,
        maxIdleTimeMS: config.maxIdleTimeMS || 30000,
        serverSelectionTimeoutMS: config.serverSelectionTimeoutMS || 5000,
        socketTimeoutMS: config.socketTimeoutMS || 45000,
        connectTimeoutMS: config.connectTimeoutMS || 10000,
        heartbeatFrequencyMS: config.heartbeatFrequencyMS || 10000,
        retryWrites: config.retryWrites !== false,
        retryReads: config.retryReads !== false,
        bufferCommands: config.bufferCommands !== false,
        ...config.options,
      },
    };
  }

  public static getInstance(config?: MongoConfig): MongoDBConnection {
    if (!MongoDBConnection.instance && config) {
      MongoDBConnection.instance = new MongoDBConnection(config);
    }
    return MongoDBConnection.instance;
  }

  public async connect(): Promise<void> {
    try {
      if (this.connection && this.connection.readyState === 1) {
        logger.info('MongoDB already connected');
        return;
      }

      logger.info('Connecting to MongoDB...', {
        uri: this.maskConnectionUri(this.config.uri),
        dbName: this.config.dbName,
      });

      await mongoose.connect(this.config.uri, {
        ...this.config.options,
        dbName: this.config.dbName,
      });

      this.connection = mongoose.connection;
      this.setupEventListeners();
      this.isConnected = true;
      this.reconnectAttempts = 0;

      logger.info('MongoDB connected successfully', {
        dbName: this.config.dbName,
        host: this.connection.host,
        port: this.connection.port,
      });

      // Run initial health check
      await this.healthCheck();
    } catch (error) {
      logger.error('Failed to connect to MongoDB', error);
      this.isConnected = false;
      throw error;
    }
  }

  public async disconnect(): Promise<void> {
    try {
      if (this.connection) {
        await mongoose.disconnect();
        this.connection = null;
        this.isConnected = false;
        logger.info('MongoDB disconnected successfully');
      }
    } catch (error) {
      logger.error('Error disconnecting from MongoDB', error);
      throw error;
    }
  }

  public getConnection(): mongoose.Connection | null {
    return this.connection;
  }

  public isHealthy(): boolean {
    return this.isConnected && this.connection?.readyState === 1;
  }

  public async healthCheck(): Promise<{
    status: 'healthy' | 'unhealthy';
    details: any;
  }> {
    try {
      if (!this.isHealthy()) {
        return {
          status: 'unhealthy',
          details: {
            reason: 'Not connected',
            readyState: this.connection?.readyState,
          },
        };
      }

      // Execute a simple command to test connectivity
      const adminDb = this.connection!.db!.admin();
      const serverStatus = await adminDb.serverStatus();

      return {
        status: 'healthy',
        details: {
          host: this.connection!.host,
          port: this.connection!.port,
          version: serverStatus.version,
          uptime: serverStatus.uptime,
          connections: serverStatus.connections,
          memory: serverStatus.mem,
          network: serverStatus.network,
        },
      };
    } catch (error) {
      logger.error('MongoDB health check failed', error);
      return {
        status: 'unhealthy',
        details: {
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  }

  public async getConnectionStats(): Promise<any> {
    try {
      if (!this.isHealthy()) {
        throw new Error('MongoDB not connected');
      }

      const adminDb = this.connection!.db!.admin();
      const serverStatus = await adminDb.serverStatus();

      return {
        connections: {
          current: serverStatus.connections.current,
          available: serverStatus.connections.available,
          totalCreated: serverStatus.connections.totalCreated,
        },
        operations: {
          insert: serverStatus.opcounters.insert,
          query: serverStatus.opcounters.query,
          update: serverStatus.opcounters.update,
          delete: serverStatus.opcounters.delete,
          getmore: serverStatus.opcounters.getmore,
          command: serverStatus.opcounters.command,
        },
        network: {
          bytesIn: serverStatus.network.bytesIn,
          bytesOut: serverStatus.network.bytesOut,
          numRequests: serverStatus.network.numRequests,
        },
        memory: {
          resident: serverStatus.mem.resident,
          virtual: serverStatus.mem.virtual,
          mapped: serverStatus.mem.mapped,
        },
        metrics: {
          document: serverStatus.metrics.document,
          cursor: serverStatus.metrics.cursor,
          getLastError: serverStatus.metrics.getLastError,
        },
      };
    } catch (error) {
      logger.error('Failed to get MongoDB connection stats', error);
      throw error;
    }
  }

  private setupEventListeners(): void {
    if (!this.connection) return;

    this.connection.on('connected', () => {
      logger.info('MongoDB connection established');
      this.isConnected = true;
      this.reconnectAttempts = 0;
    });

    this.connection.on('error', error => {
      logger.error('MongoDB connection error', error);
      this.isConnected = false;
    });

    this.connection.on('disconnected', () => {
      logger.warn('MongoDB connection lost');
      this.isConnected = false;
      this.attemptReconnect();
    });

    this.connection.on('reconnected', () => {
      logger.info('MongoDB connection reestablished');
      this.isConnected = true;
      this.reconnectAttempts = 0;
    });

    // Connection pool events
    this.connection.on('connectionPoolCreated', event => {
      logger.debug('MongoDB connection pool created', event);
    });

    this.connection.on('connectionCreated', event => {
      logger.debug('MongoDB connection created', event);
    });

    this.connection.on('connectionReady', event => {
      logger.debug('MongoDB connection ready', event);
    });

    this.connection.on('connectionClosed', event => {
      logger.debug('MongoDB connection closed', event);
    });

    this.connection.on('connectionPoolCleared', event => {
      logger.debug('MongoDB connection pool cleared', event);
    });
  }

  private async attemptReconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max MongoDB reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    logger.info(
      `Attempting MongoDB reconnection (${this.reconnectAttempts}/${this.maxReconnectAttempts})`
    );

    setTimeout(async () => {
      try {
        await this.connect();
      } catch (error) {
        logger.error(
          `MongoDB reconnection attempt ${this.reconnectAttempts} failed`,
          error
        );
        this.attemptReconnect();
      }
    }, this.reconnectInterval);
  }

  private maskConnectionUri(uri: string): string {
    try {
      const url = new URL(uri);
      return `${url.protocol}//${url.username ? '***:***@' : ''}${url.host}${url.pathname}`;
    } catch {
      return '***';
    }
  }

  // Database operations helper methods
  public async createIndexes(
    collection: string,
    indexes: any[]
  ): Promise<void> {
    try {
      if (!this.isHealthy()) {
        throw new Error('MongoDB not connected');
      }

      const db = this.connection!.db!;
      await db.collection(collection).createIndexes(indexes);
      logger.info(`Indexes created for collection: ${collection}`);
    } catch (error) {
      logger.error(
        `Failed to create indexes for collection: ${collection}`,
        error
      );
      throw error;
    }
  }

  public async dropCollection(collection: string): Promise<void> {
    try {
      if (!this.isHealthy()) {
        throw new Error('MongoDB not connected');
      }

      const db = this.connection!.db!;
      await db.collection(collection).drop();
      logger.info(`Collection dropped: ${collection}`);
    } catch (error) {
      logger.error(`Failed to drop collection: ${collection}`, error);
      throw error;
    }
  }

  public async getCollectionStats(collection: string): Promise<any> {
    try {
      if (!this.isHealthy()) {
        throw new Error('MongoDB not connected');
      }

      const db = this.connection!.db!;
      const stats = await db.command({ collStats: collection });
      return stats;
    } catch (error) {
      logger.error(`Failed to get stats for collection: ${collection}`, error);
      throw error;
    }
  }

  public async runCommand(command: any): Promise<any> {
    try {
      if (!this.isHealthy()) {
        throw new Error('MongoDB not connected');
      }

      const db = this.connection!.db!;
      return await db.command(command);
    } catch (error) {
      logger.error('Failed to run MongoDB command', { command, error });
      throw error;
    }
  }

  // Transaction support
  public async withTransaction<T>(
    operations: (session: mongoose.ClientSession) => Promise<T>
  ): Promise<T> {
    try {
      if (!this.isHealthy()) {
        throw new Error('MongoDB not connected');
      }

      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        const result = await operations(session);
        await session.commitTransaction();
        return result;
      } catch (error) {
        await session.abortTransaction();
        throw error;
      } finally {
        await session.endSession();
      }
    } catch (error) {
      logger.error('Transaction failed', error);
      throw error;
    }
  }
}

// Export default instance factory
export function createMongoDBConnection(
  config: MongoConfig
): MongoDBConnection {
  return MongoDBConnection.getInstance(config);
}
