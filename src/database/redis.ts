import Redis, { Cluster, type RedisOptions } from 'ioredis';
import logger from '../utils/logger';

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
  keyPrefix?: string;
  retryDelayOnFailover?: number;
  maxRetriesPerRequest?: number;
  lazyConnect?: boolean;
  keepAlive?: number;
  family?: 4 | 6;
  connectTimeout?: number;
  commandTimeout?: number;
  maxLoadingTimeout?: number;
  enableReadyCheck?: boolean;
  maxMemoryPolicy?: string;
  clusterEnabled?: boolean;
  clusterNodes?: Array<{ host: string; port: number }>;
}

export class RedisManager {
  private static instance: RedisManager;
  private redis: Redis | null = null;
  private redisCluster: Cluster | null = null;
  private config: RedisConfig;
  private isConnected: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectInterval: number = 5000;

  private constructor(config: RedisConfig) {
    this.config = {
      ...config,
      retryDelayOnFailover: config.retryDelayOnFailover || 100,
      maxRetriesPerRequest: config.maxRetriesPerRequest || 3,
      lazyConnect: config.lazyConnect !== false,
      keepAlive: config.keepAlive || 30000,
      family: config.family || 4,
      connectTimeout: config.connectTimeout || 10000,
      commandTimeout: config.commandTimeout || 5000,
      maxLoadingTimeout: config.maxLoadingTimeout || 5000,
      enableReadyCheck: config.enableReadyCheck !== false,
      maxMemoryPolicy: config.maxMemoryPolicy || 'allkeys-lru',
      keyPrefix: config.keyPrefix || 'noip:',
      clusterEnabled: config.clusterEnabled || false,
    };
  }

  public static getInstance(config?: RedisConfig): RedisManager {
    if (!RedisManager.instance && config) {
      RedisManager.instance = new RedisManager(config);
    }
    return RedisManager.instance;
  }

  public async connect(): Promise<void> {
    try {
      if (this.isConnected && this.getClient().status === 'ready') {
        logger.info('Redis already connected');
        return;
      }

      logger.info('Connecting to Redis...', {
        host: this.config.host,
        port: this.config.port,
        db: this.config.db,
        cluster: this.config.clusterEnabled,
      });

      // `retryDelayOnFailover` and `maxMemoryPolicy` no longer exist on
      // `ioredis@5`'s `RedisOptions`. We retain them on our config
      // surface for back-compat (callers may still set them) but drop
      // them when building the driver options. `maxLoadingTimeout` was
      // renamed `maxLoadingRetryTime`.
      const sharedRedisOptions: RedisOptions = {
        ...(this.config.password !== undefined
          ? { password: this.config.password }
          : {}),
        ...(this.config.db !== undefined ? { db: this.config.db } : {}),
        ...(this.config.keyPrefix !== undefined
          ? { keyPrefix: this.config.keyPrefix }
          : {}),
        ...(this.config.maxRetriesPerRequest !== undefined
          ? { maxRetriesPerRequest: this.config.maxRetriesPerRequest }
          : {}),
        ...(this.config.lazyConnect !== undefined
          ? { lazyConnect: this.config.lazyConnect }
          : {}),
        ...(this.config.keepAlive !== undefined
          ? { keepAlive: this.config.keepAlive }
          : {}),
        ...(this.config.family !== undefined
          ? { family: this.config.family }
          : {}),
        ...(this.config.connectTimeout !== undefined
          ? { connectTimeout: this.config.connectTimeout }
          : {}),
        ...(this.config.commandTimeout !== undefined
          ? { commandTimeout: this.config.commandTimeout }
          : {}),
        ...(this.config.enableReadyCheck !== undefined
          ? { enableReadyCheck: this.config.enableReadyCheck }
          : {}),
      };

      if (this.config.clusterEnabled && this.config.clusterNodes) {
        // Connect to Redis Cluster
        this.redisCluster = new Cluster(this.config.clusterNodes, {
          redisOptions: sharedRedisOptions,
        });

        this.setupClusterEventListeners();
      } else {
        // Connect to single Redis instance
        this.redis = new Redis({
          host: this.config.host,
          port: this.config.port,
          ...sharedRedisOptions,
        });

        this.setupEventListeners();
      }

      // Test connection
      await this.getClient().ping();

      this.isConnected = true;
      this.reconnectAttempts = 0;

      logger.info('Redis connected successfully', {
        host: this.config.host,
        port: this.config.port,
        db: this.config.db,
        cluster: this.config.clusterEnabled,
      });

      // Run initial health check
      await this.healthCheck();
    } catch (error) {
      logger.error('Failed to connect to Redis', error);
      this.isConnected = false;
      throw error;
    }
  }

  public async disconnect(): Promise<void> {
    try {
      if (this.redis) {
        await this.redis.disconnect();
        this.redis = null;
      }

      if (this.redisCluster) {
        await this.redisCluster.disconnect();
        this.redisCluster = null;
      }

      this.isConnected = false;
      logger.info('Redis disconnected successfully');
    } catch (error) {
      logger.error('Error disconnecting from Redis', error);
      throw error;
    }
  }

  public getClient(): Redis | Cluster {
    return (
      this.redisCluster ||
      this.redis ||
      (() => {
        throw new Error('Redis not connected');
      })()
    );
  }

  public isHealthy(): boolean {
    return this.isConnected && this.getClient().status === 'ready';
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
            status: this.getClient().status,
          },
        };
      }

      const client = this.getClient();
      const startTime = Date.now();

      // Test basic operations
      await client.ping();
      const latency = Date.now() - startTime;

      // Get Redis info
      const info = await client.info('server,memory,clients,stats');

      return {
        status: 'healthy',
        details: {
          latency,
          host: this.config.host,
          port: this.config.port,
          db: this.config.db,
          cluster: this.config.clusterEnabled,
          info: this.parseRedisInfo(info),
        },
      };
    } catch (error) {
      logger.error('Redis health check failed', error);
      return {
        status: 'unhealthy',
        details: {
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  }

  // Cache operations
  public async set(key: string, value: any, ttl?: number): Promise<void> {
    try {
      const client = this.getClient();
      const serializedValue = JSON.stringify(value);

      if (ttl) {
        await client.setex(key, ttl, serializedValue);
      } else {
        await client.set(key, serializedValue);
      }
    } catch (error) {
      logger.error('Redis SET operation failed', { key, error });
      throw error;
    }
  }

  public async get<T = any>(key: string): Promise<T | null> {
    try {
      const client = this.getClient();
      const value = await client.get(key);

      if (value === null) {
        return null;
      }

      return JSON.parse(value);
    } catch (error) {
      logger.error('Redis GET operation failed', { key, error });
      throw error;
    }
  }

  public async del(key: string): Promise<void> {
    try {
      const client = this.getClient();
      await client.del(key);
    } catch (error) {
      logger.error('Redis DEL operation failed', { key, error });
      throw error;
    }
  }

  public async exists(key: string): Promise<boolean> {
    try {
      const client = this.getClient();
      const result = await client.exists(key);
      return result === 1;
    } catch (error) {
      logger.error('Redis EXISTS operation failed', { key, error });
      throw error;
    }
  }

  public async expire(key: string, ttl: number): Promise<void> {
    try {
      const client = this.getClient();
      await client.expire(key, ttl);
    } catch (error) {
      logger.error('Redis EXPIRE operation failed', { key, ttl, error });
      throw error;
    }
  }

  public async ttl(key: string): Promise<number> {
    try {
      const client = this.getClient();
      return await client.ttl(key);
    } catch (error) {
      logger.error('Redis TTL operation failed', { key, error });
      throw error;
    }
  }

  // Hash operations
  public async hset(key: string, field: string, value: any): Promise<void> {
    try {
      const client = this.getClient();
      const serializedValue = JSON.stringify(value);
      await client.hset(key, field, serializedValue);
    } catch (error) {
      logger.error('Redis HSET operation failed', { key, field, error });
      throw error;
    }
  }

  public async hget<T = any>(key: string, field: string): Promise<T | null> {
    try {
      const client = this.getClient();
      const value = await client.hget(key, field);

      if (value === null) {
        return null;
      }

      return JSON.parse(value);
    } catch (error) {
      logger.error('Redis HGET operation failed', { key, field, error });
      throw error;
    }
  }

  public async hgetall<T = any>(key: string): Promise<Record<string, T>> {
    try {
      const client = this.getClient();
      const hash = await client.hgetall(key);

      const result: Record<string, T> = {};
      for (const [field, value] of Object.entries(hash)) {
        try {
          result[field] = JSON.parse(value);
        } catch {
          result[field] = value as T;
        }
      }

      return result;
    } catch (error) {
      logger.error('Redis HGETALL operation failed', { key, error });
      throw error;
    }
  }

  public async hdel(key: string, field: string): Promise<void> {
    try {
      const client = this.getClient();
      await client.hdel(key, field);
    } catch (error) {
      logger.error('Redis HDEL operation failed', { key, field, error });
      throw error;
    }
  }

  // Set operations
  public async sadd(key: string, member: string): Promise<void> {
    try {
      const client = this.getClient();
      await client.sadd(key, member);
    } catch (error) {
      logger.error('Redis SADD operation failed', { key, member, error });
      throw error;
    }
  }

  public async srem(key: string, member: string): Promise<void> {
    try {
      const client = this.getClient();
      await client.srem(key, member);
    } catch (error) {
      logger.error('Redis SREM operation failed', { key, member, error });
      throw error;
    }
  }

  public async smembers(key: string): Promise<string[]> {
    try {
      const client = this.getClient();
      return await client.smembers(key);
    } catch (error) {
      logger.error('Redis SMEMBERS operation failed', { key, error });
      throw error;
    }
  }

  public async sismember(key: string, member: string): Promise<boolean> {
    try {
      const client = this.getClient();
      const result = await client.sismember(key, member);
      return result === 1;
    } catch (error) {
      logger.error('Redis SISMEMBER operation failed', { key, member, error });
      throw error;
    }
  }

  // List operations
  public async lpush(key: string, value: any): Promise<void> {
    try {
      const client = this.getClient();
      const serializedValue = JSON.stringify(value);
      await client.lpush(key, serializedValue);
    } catch (error) {
      logger.error('Redis LPUSH operation failed', { key, error });
      throw error;
    }
  }

  public async rpush(key: string, value: any): Promise<void> {
    try {
      const client = this.getClient();
      const serializedValue = JSON.stringify(value);
      await client.rpush(key, serializedValue);
    } catch (error) {
      logger.error('Redis RPUSH operation failed', { key, error });
      throw error;
    }
  }

  public async lpop<T = any>(key: string): Promise<T | null> {
    try {
      const client = this.getClient();
      const value = await client.lpop(key);

      if (value === null) {
        return null;
      }

      return JSON.parse(value);
    } catch (error) {
      logger.error('Redis LPOP operation failed', { key, error });
      throw error;
    }
  }

  public async rpop<T = any>(key: string): Promise<T | null> {
    try {
      const client = this.getClient();
      const value = await client.rpop(key);

      if (value === null) {
        return null;
      }

      return JSON.parse(value);
    } catch (error) {
      logger.error('Redis RPOP operation failed', { key, error });
      throw error;
    }
  }

  public async llen(key: string): Promise<number> {
    try {
      const client = this.getClient();
      return await client.llen(key);
    } catch (error) {
      logger.error('Redis LLEN operation failed', { key, error });
      throw error;
    }
  }

  // Utility methods
  public async flushdb(): Promise<void> {
    try {
      const client = this.getClient();
      await client.flushdb();
      logger.info('Redis database flushed');
    } catch (error) {
      logger.error('Redis FLUSHDB operation failed', error);
      throw error;
    }
  }

  public async flushall(): Promise<void> {
    try {
      const client = this.getClient();
      await client.flushall();
      logger.info('All Redis databases flushed');
    } catch (error) {
      logger.error('Redis FLUSHALL operation failed', error);
      throw error;
    }
  }

  public async getStats(): Promise<any> {
    try {
      const client = this.getClient();
      const info = await client.info(
        'server,memory,clients,stats,replication,cpu,persistence'
      );
      return this.parseRedisInfo(info);
    } catch (error) {
      logger.error('Failed to get Redis stats', error);
      throw error;
    }
  }

  private setupEventListeners(): void {
    if (!this.redis) return;

    this.redis.on('connect', () => {
      logger.info('Redis connection established');
      this.isConnected = true;
      this.reconnectAttempts = 0;
    });

    this.redis.on('ready', () => {
      logger.info('Redis connection ready');
    });

    this.redis.on('error', error => {
      logger.error('Redis connection error', error);
      this.isConnected = false;
    });

    this.redis.on('close', () => {
      logger.warn('Redis connection closed');
      this.isConnected = false;
      this.attemptReconnect();
    });

    this.redis.on('reconnecting', (delay: number) => {
      logger.info(`Redis reconnecting in ${delay}ms`);
    });

    this.redis.on('end', () => {
      logger.info('Redis connection ended');
      this.isConnected = false;
    });
  }

  private setupClusterEventListeners(): void {
    if (!this.redisCluster) return;

    this.redisCluster.on('connect', () => {
      logger.info('Redis cluster connection established');
      this.isConnected = true;
      this.reconnectAttempts = 0;
    });

    this.redisCluster.on('ready', () => {
      logger.info('Redis cluster connection ready');
    });

    this.redisCluster.on('error', (error: Error) => {
      logger.error('Redis cluster connection error', error);
      this.isConnected = false;
    });

    this.redisCluster.on('close', () => {
      logger.warn('Redis cluster connection closed');
      this.isConnected = false;
      this.attemptReconnect();
    });

    this.redisCluster.on('reconnecting', (delay: number) => {
      logger.info(`Redis cluster reconnecting in ${delay}ms`);
    });

    this.redisCluster.on('end', () => {
      logger.info('Redis cluster connection ended');
      this.isConnected = false;
    });

    this.redisCluster.on(
      'node error',
      (error: Error, node: { options?: { host?: string; port?: number } }) => {
        logger.error('Redis cluster node error', { error, node });
      }
    );
  }

  private async attemptReconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max Redis reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    logger.info(
      `Attempting Redis reconnection (${this.reconnectAttempts}/${this.maxReconnectAttempts})`
    );

    setTimeout(async () => {
      try {
        await this.connect();
      } catch (error) {
        logger.error(
          `Redis reconnection attempt ${this.reconnectAttempts} failed`,
          error
        );
        this.attemptReconnect();
      }
    }, this.reconnectInterval);
  }

  private parseRedisInfo(info: string): Record<string, any> {
    const lines = info.split('\r\n');
    const result: Record<string, any> = {};

    for (const line of lines) {
      if (line.trim() === '' || line.startsWith('#')) {
        continue;
      }

      const [key, value] = line.split(':');
      if (key && value) {
        // Try to parse numeric values
        const numValue = Number(value);
        result[key] = isNaN(numValue) ? value : numValue;
      }
    }

    return result;
  }
}

// Export default instance factory
export function createRedisManager(config: RedisConfig): RedisManager {
  return RedisManager.getInstance(config);
}
