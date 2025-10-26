import { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';
import { SecurityEventModel } from '../models';
import { SecurityEventType, SecurityEventSeverity } from '../types/auth.types';
import { config } from '../config';
import logger from '../utils/logger';

interface RateLimitConfig {
  windowMs: number;
  max: number;
  message?: string;
  standardHeaders?: boolean;
  legacyHeaders?: boolean;
  keyGenerator?: (req: Request) => string;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
  onLimitReached?: (req: Request, res: Response) => void;
}

interface RateLimitRecord {
  count: number;
  resetTime: number;
  lastAccess: number;
}

export class RateLimitMiddleware {
  private redis: Redis;
  private defaultConfig: RateLimitConfig;

  constructor(redis: Redis) {
    this.redis = redis;
    this.defaultConfig = {
      windowMs: config.security.rateLimit.windowMs,
      max: config.security.rateLimit.max,
      message: 'Too many requests, please try again later.',
      standardHeaders: true,
      legacyHeaders: false,
      skipSuccessfulRequests: false,
      skipFailedRequests: false
    };
  }

  // General rate limiting middleware
  rateLimit = (customConfig: Partial<RateLimitConfig> = {}) => {
    const finalConfig = { ...this.defaultConfig, ...customConfig };

    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const key = finalConfig.keyGenerator ? finalConfig.keyGenerator(req) : this.generateKey(req);
        const now = Date.now();
        const windowStart = now - finalConfig.windowMs;

        // Get current rate limit record
        const record = await this.getRateLimitRecord(key);

        if (!record) {
          // First request in window
          await this.setRateLimitRecord(key, {
            count: 1,
            resetTime: now + finalConfig.windowMs,
            lastAccess: now
          });
          this.setRateLimitHeaders(res, 1, finalConfig.max, now + finalConfig.windowMs);
          return next();
        }

        // Reset if window has expired
        if (now > record.resetTime) {
          const newRecord = {
            count: 1,
            resetTime: now + finalConfig.windowMs,
            lastAccess: now
          };
          await this.setRateLimitRecord(key, newRecord);
          this.setRateLimitHeaders(res, 1, finalConfig.max, newRecord.resetTime);
          return next();
        }

        // Check if limit exceeded
        if (record.count >= finalConfig.max) {
          await this.createRateLimitEvent(req, record.count, finalConfig);

          if (finalConfig.onLimitReached) {
            finalConfig.onLimitReached(req, res);
          } else {
            res.status(429).json({
              error: finalConfig.message || 'Too many requests',
              retryAfter: Math.ceil((record.resetTime - now) / 1000)
            });
          }
          return;
        }

        // Increment counter
        const newRecord = {
          ...record,
          count: record.count + 1,
          lastAccess: now
        };
        await this.setRateLimitRecord(key, newRecord);
        this.setRateLimitHeaders(res, newRecord.count, finalConfig.max, record.resetTime);

        next();
      } catch (error) {
        logger.error('Rate limiting middleware error', { error });
        // Fail open - allow request if rate limiting fails
        next();
      }
    };
  };

  // Strict rate limiting for authentication endpoints
  authRateLimit = this.rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 attempts per 15 minutes
    message: 'Too many authentication attempts, please try again later.',
    keyGenerator: (req) => this.generateAuthKey(req)
  });

  // Password reset rate limiting
  passwordResetRateLimit = this.rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 3, // 3 password reset attempts per hour
    message: 'Too many password reset attempts, please try again later.',
    keyGenerator: (req) => this.generateEmailKey(req)
  });

  // MFA verification rate limiting
  mfaRateLimit = this.rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 10, // 10 MFA attempts per 5 minutes
    message: 'Too many MFA verification attempts, please try again later.',
    keyGenerator: (req) => this.generateUserKey(req)
  });

  // API rate limiting for authenticated users
  apiRateLimit = this.rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100, // 100 requests per minute for authenticated users
    message: 'API rate limit exceeded, please try again later.',
    keyGenerator: (req) => this.generateUserKey(req)
  });

  // Strict API rate limiting for sensitive operations
  strictApiRateLimit = this.rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10, // 10 sensitive operations per minute
    message: 'Rate limit exceeded for sensitive operations, please try again later.',
    keyGenerator: (req) => this.generateUserKey(req)
  });

  // IP-based rate limiting for unauthenticated requests
  ipRateLimit = this.rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 20, // 20 requests per minute per IP
    message: 'IP rate limit exceeded, please try again later.',
    keyGenerator: (req) => this.generateIPKey(req)
  });

  // Progressive rate limiting - gets stricter with repeated violations
  progressiveRateLimit = (baseConfig: Partial<RateLimitConfig> = {}) => {
    const finalConfig = { ...this.defaultConfig, ...baseConfig };

    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const key = finalConfig.keyGenerator ? finalConfig.keyGenerator(req) : this.generateKey(req);
        const violationKey = `${key}:violations`;

        const violations = await this.getViolationCount(violationKey);
        const multiplier = Math.pow(2, Math.min(violations, 5)); // Max 32x multiplier

        const progressiveConfig = {
          ...finalConfig,
          max: Math.max(1, Math.floor(finalConfig.max! / multiplier)),
          windowMs: finalConfig.windowMs! * multiplier
        };

        // Apply the standard rate limit with progressive configuration
        const middleware = this.rateLimit(progressiveConfig);
        middleware(req, res, (err) => {
          if (err) {
            // Rate limit exceeded - increment violation count
            this.incrementViolationCount(violationKey);
          }
          next(err);
        });
      } catch (error) {
        logger.error('Progressive rate limiting middleware error', { error });
        next();
      }
    };
  };

  // Adaptive rate limiting based on request patterns
  adaptiveRateLimit = (baseConfig: Partial<RateLimitConfig> = {}) => {
    const finalConfig = { ...this.defaultConfig, ...baseConfig };

    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const key = finalConfig.keyGenerator ? finalConfig.keyGenerator(req) : this.generateKey(req);
        const riskScore = await this.calculateRiskScore(req);

        // Adjust limits based on risk score (0-100)
        const riskMultiplier = Math.max(0.1, 1 - (riskScore / 100));

        const adaptiveConfig = {
          ...finalConfig,
          max: Math.max(1, Math.floor(finalConfig.max! * riskMultiplier))
        };

        const middleware = this.rateLimit(adaptiveConfig);
        middleware(req, res, next);
      } catch (error) {
        logger.error('Adaptive rate limiting middleware error', { error });
        next();
      }
    };
  };

  // Rate limiting for specific endpoints based on sensitivity
  createEndpointRateLimit = (endpoint: string, config: Partial<RateLimitConfig>) => {
    return this.rateLimit({
      ...config,
      keyGenerator: (req) => `${this.generateKey(req)}:${endpoint}`
    });
  };

  // Get rate limit status for a given key
  async getRateLimitStatus(key: string): Promise<{
    remaining: number;
    resetTime: number;
    total: number;
  } | null> {
    try {
      const record = await this.getRateLimitRecord(key);
      if (!record) {
        return null;
      }

      return {
        remaining: Math.max(0, this.defaultConfig.max - record.count),
        resetTime: record.resetTime,
        total: this.defaultConfig.max
      };
    } catch (error) {
      logger.error('Failed to get rate limit status', { error, key });
      return null;
    }
  }

  // Reset rate limit for a specific key (admin function)
  async resetRateLimit(key: string): Promise<void> {
    try {
      await this.redis.del(`rate_limit:${key}`);
      logger.info('Rate limit reset', { key });
    } catch (error) {
      logger.error('Failed to reset rate limit', { error, key });
    }
  }

  // Cleanup expired rate limit records
  async cleanupExpiredRecords(): Promise<number> {
    try {
      const pattern = 'rate_limit:*';
      const keys = await this.redis.keys(pattern);
      let deletedCount = 0;

      for (const key of keys) {
        const record = await this.getRateLimitRecord(key.replace('rate_limit:', ''));
        if (record && Date.now() > record.resetTime) {
          await this.redis.del(key);
          deletedCount++;
        }
      }

      logger.info('Rate limit cleanup completed', { deletedCount, totalKeys: keys.length });
      return deletedCount;
    } catch (error) {
      logger.error('Rate limit cleanup failed', { error });
      return 0;
    }
  }

  private async getRateLimitRecord(key: string): Promise<RateLimitRecord | null> {
    try {
      const data = await this.redis.get(`rate_limit:${key}`);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      logger.error('Failed to get rate limit record', { error, key });
      return null;
    }
  }

  private async setRateLimitRecord(key: string, record: RateLimitRecord): Promise<void> {
    try {
      const ttl = Math.ceil((record.resetTime - Date.now()) / 1000);
      await this.redis.setex(`rate_limit:${key}`, ttl, JSON.stringify(record));
    } catch (error) {
      logger.error('Failed to set rate limit record', { error, key });
    }
  }

  private async getViolationCount(key: string): Promise<number> {
    try {
      const count = await this.redis.get(key);
      return count ? parseInt(count, 10) : 0;
    } catch (error) {
      logger.error('Failed to get violation count', { error, key });
      return 0;
    }
  }

  private async incrementViolationCount(key: string): Promise<void> {
    try {
      await this.redis.incr(key);
      await this.redis.expire(key, 24 * 60 * 60); // Reset violations after 24 hours
    } catch (error) {
      logger.error('Failed to increment violation count', { error, key });
    }
  }

  private async calculateRiskScore(req: Request): Promise<number> {
    let riskScore = 0;

    // Add risk for suspicious user agents
    const userAgent = req.headers['user-agent'] || '';
    if (this.isSuspiciousUserAgent(userAgent)) {
      riskScore += 20;
    }

    // Add risk for requests without proper headers
    if (!req.headers['accept-language']) {
      riskScore += 10;
    }

    // Add risk for requests from certain regions (would need geoIP service)
    // This is a placeholder for actual geographic risk assessment
    const clientIP = this.getClientIP(req);
    if (this.isHighRiskIP(clientIP)) {
      riskScore += 30;
    }

    // Add risk for requests with unusual patterns
    if (this.hasSuspiciousPattern(req)) {
      riskScore += 15;
    }

    return Math.min(100, riskScore);
  }

  private generateKey(req: Request): string {
    return this.getClientIP(req);
  }

  private generateAuthKey(req: Request): string {
    const ip = this.getClientIP(req);
    const userAgent = req.headers['user-agent'] || 'unknown';
    return `auth:${this.hashString(ip + userAgent)}`;
  }

  private generateEmailKey(req: Request): string {
    const email = req.body?.email || req.query?.email || '';
    return `email:${this.hashString(email)}`;
  }

  private generateUserKey(req: Request): string {
    const user = (req as any).user;
    if (user?._id) {
      return `user:${user._id}`;
    }
    return this.generateAuthKey(req);
  }

  private generateIPKey(req: Request): string {
    return `ip:${this.getClientIP(req)}`;
  }

  private getClientIP(req: Request): string {
    return req.ip ||
           req.connection.remoteAddress ||
           req.socket.remoteAddress ||
           (req.connection as any)?.socket?.remoteAddress ||
           '127.0.0.1';
  }

  private hashString(str: string): string {
    return require('crypto')
      .createHash('sha256')
      .update(str)
      .digest('hex')
      .substring(0, 16);
  }

  private isSuspiciousUserAgent(userAgent: string): boolean {
    const suspiciousPatterns = [
      /bot/i,
      /crawler/i,
      /spider/i,
      /scraper/i,
      /curl/i,
      /wget/i,
      /python/i,
      /java/i,
      /headless/i,
      /phantom/i,
      /selenium/i
    ];

    return suspiciousPatterns.some(pattern => pattern.test(userAgent));
  }

  private isHighRiskIP(ip: string): boolean {
    // In a real implementation, this would check against known malicious IP ranges
    // For now, just check if it's a private IP (which might be suspicious in certain contexts)
    const privateRanges = [
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
      /^192\.168\./,
      /^127\./
    ];

    return privateRanges.some(range => range.test(ip));
  }

  private hasSuspiciousPattern(req: Request): boolean {
    // Check for suspicious request patterns
    const suspiciousPatterns = [
      // SQL injection patterns
      /(\%27)|(\')|(\-\-)|(\%23)|(#)/i,
      /(\%3D)|(=)[^\n]*((\%27)|(\')|(\-\-)|(\%3B)|(;))/i,
      /\w*((\%27)|(\'))((\%6F)|o|(\%4F))((\%72)|r|(\%52))/i,
      // XSS patterns
      /((\%3C)|<)((\%2F)|\/)*[a-z0-9\%]+((\%3E)|>)/i,
      // Path traversal
      /(\.\.\/|\.\.\\)/i
    ];

    const url = req.url;
    const body = JSON.stringify(req.body);

    return suspiciousPatterns.some(pattern =>
      pattern.test(url) || pattern.test(body)
    );
  }

  private setRateLimitHeaders(res: Response, count: number, limit: number, resetTime: number): void {
    const remaining = Math.max(0, limit - count);
    const retryAfter = Math.ceil((resetTime - Date.now()) / 1000);

    res.set({
      'X-RateLimit-Limit': limit.toString(),
      'X-RateLimit-Remaining': remaining.toString(),
      'X-RateLimit-Reset': Math.ceil(resetTime / 1000).toString(),
      'Retry-After': retryAfter.toString()
    });
  }

  private async createRateLimitEvent(req: Request, count: number, config: RateLimitConfig): Promise<void> {
    try {
      await SecurityEventModel.createEvent(
        SecurityEventType.LOGIN_FAILURE,
        `Rate limit exceeded: ${count} requests`,
        this.getClientIP(req),
        req.headers['user-agent'] || 'unknown',
        {
          severity: SecurityEventSeverity.MEDIUM,
          details: {
            endpoint: req.path,
            method: req.method,
            count,
            limit: config.max,
            windowMs: config.windowMs
          }
        }
      );
    } catch (error) {
      logger.error('Failed to create rate limit security event', { error });
    }
  }
}