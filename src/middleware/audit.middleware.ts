import { Request, Response, NextFunction } from 'express';
import { AuditLog, SecurityEventType } from '../types/auth.types';
import { AuditLogModel, SecurityEventModel } from '../models';
import logger from '../utils/logger';

interface AuditConfig {
  logLevel: 'none' | 'basic' | 'detailed' | 'full';
  excludePaths: string[];
  includeHeaders: boolean;
  includeBody: boolean;
  sanitizeBody: boolean;
  maxBodySize: number;
}

export class AuditMiddleware {
  private config: AuditConfig;

  constructor(config?: Partial<AuditConfig>) {
    this.config = {
      logLevel: config?.logLevel || 'detailed',
      excludePaths: config?.excludePaths || [
        '/health',
        '/metrics',
        '/favicon.ico',
      ],
      includeHeaders: config?.includeHeaders || false,
      includeBody: config?.includeBody || true,
      sanitizeBody: config?.sanitizeBody !== false,
      maxBodySize: config?.maxBodySize || 10240, // 10KB
    };
  }

  // Main audit middleware
  audit = (req: Request, res: Response, next: NextFunction): void => {
    if (this.config.logLevel === 'none') {
      return next();
    }

    // Skip excluded paths
    if (this.shouldExcludePath(req.path)) {
      return next();
    }

    // Store original res.end to intercept response
    const originalEnd = res.end;
    let responseBody: any;

    res.end = function (this: Response, ...args: any[]) {
      // Capture response body if needed
      if (args[0]) {
        responseBody = args[0];
      }

      // Call original end
      originalEnd.apply(this, args);

      // Create audit entry after response is sent
      setImmediate(() => {
        createAuditEntry(req, res, responseBody);
      });
    };

    next();
  };

  // User action audit middleware
  auditUserAction = (action: string, resource: string) => {
    return (req: Request, res: Response, next: NextFunction): void => {
      // Store audit context in request
      (req as any).auditContext = {
        action,
        resource,
        resourceId: req.params.id || req.body?.id,
        timestamp: new Date(),
      };

      next();
    };
  };

  // Security event audit middleware
  auditSecurityEvent = (eventType: SecurityEventType, description: string) => {
    return (req: Request, res: Response, next: NextFunction): void => {
      // Store security event context
      (req as any).securityEventContext = {
        type: eventType,
        description,
        timestamp: new Date(),
      };

      next();
    };
  };

  // Data access audit middleware
  auditDataAccess = (
    operation: 'read' | 'write' | 'delete',
    resourceType: string
  ) => {
    return (req: Request, res: Response, next: NextFunction): void => {
      (req as any).dataAccessContext = {
        operation,
        resourceType,
        resourceIds: this.extractResourceIds(req),
        timestamp: new Date(),
      };

      next();
    };
  };

  // Administrative action audit middleware
  auditAdminAction = (action: string, targetResource: string) => {
    return (req: Request, res: Response, next: NextFunction): void => {
      (req as any).adminActionContext = {
        action,
        targetResource,
        targetId: req.params.id || req.body?.userId,
        adminId: (req as any).user?._id,
        timestamp: new Date(),
      };

      next();
    };
  };

  // Configuration change audit middleware
  auditConfigChange = (configSection: string) => {
    return (req: Request, res: Response, next: NextFunction): void => {
      // Capture original config values if possible
      const originalValues = this.captureOriginalValues(req);

      (req as any).configChangeContext = {
        section: configSection,
        originalValues,
        newValues: req.body,
        userId: (req as any).user?._id,
        timestamp: new Date(),
      };

      next();
    };
  };

  // Failed authentication audit middleware
  auditFailedAuth = (reason: string) => {
    return (req: Request, res: Response, next: NextFunction): void => {
      (req as any).failedAuthContext = {
        reason,
        attemptDetails: {
          username: req.body?.username || req.body?.email,
          ipAddress: this.getClientIP(req),
          userAgent: req.headers['user-agent'],
          timestamp: new Date(),
        },
      };

      next();
    };
  };

  // Session management audit middleware
  auditSessionManagement = (action: 'create' | 'destroy' | 'extend') => {
    return (req: Request, res: Response, next: NextFunction): void => {
      (req as any).sessionManagementContext = {
        action,
        sessionId: (req as any).session?.sessionId,
        userId: (req as any).user?._id,
        deviceInfo: this.extractDeviceInfo(req),
        timestamp: new Date(),
      };

      next();
    };
  };

  // API key usage audit middleware
  auditApiKeyUsage = () => {
    return (req: Request, res: Response, next: NextFunction): void => {
      const apiKey = req.headers['x-api-key'] as string;

      if (apiKey) {
        (req as any).apiKeyUsageContext = {
          apiKeyHash: this.hashApiKey(apiKey),
          endpoint: req.path,
          method: req.method,
          timestamp: new Date(),
        };
      }

      next();
    };
  };

  // Custom audit middleware
  customAudit = (auditData: Record<string, any>) => {
    return (req: Request, res: Response, next: NextFunction): void => {
      (req as any).customAuditContext = {
        ...auditData,
        timestamp: new Date(),
      };

      next();
    };
  };

  // Get audit logs
  async getAuditLogs(filters: {
    userId?: string;
    action?: string;
    resource?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  }): Promise<{ logs: AuditLog[]; total: number }> {
    try {
      const query: any = {};

      if (filters.userId) {
        query.userId = filters.userId;
      }

      if (filters.action) {
        query.action = filters.action;
      }

      if (filters.resource) {
        query.resource = filters.resource;
      }

      if (filters.startDate || filters.endDate) {
        query.timestamp = {};
        if (filters.startDate) {
          query.timestamp.$gte = filters.startDate;
        }
        if (filters.endDate) {
          query.timestamp.$lte = filters.endDate;
        }
      }

      const total = await AuditLogModel.countDocuments(query);
      const logs = await AuditLogModel.find(query)
        .sort({ timestamp: -1 })
        .limit(filters.limit || 100)
        .skip(filters.offset || 0)
        .exec();

      return { logs, total };
    } catch (error) {
      logger.error('Failed to get audit logs', { error, filters });
      throw error;
    }
  }

  // Search audit logs
  async searchAuditLogs(
    searchQuery: string,
    filters: any = {}
  ): Promise<AuditLog[]> {
    try {
      const query = {
        ...filters,
        $or: [
          { action: { $regex: searchQuery, $options: 'i' } },
          { resource: { $regex: searchQuery, $options: 'i' } },
          { 'details.message': { $regex: searchQuery, $options: 'i' } },
        ],
      };

      return await AuditLogModel.find(query)
        .sort({ timestamp: -1 })
        .limit(100)
        .exec();
    } catch (error) {
      logger.error('Failed to search audit logs', { error, searchQuery });
      throw error;
    }
  }

  // Export audit logs
  async exportAuditLogs(
    filters: any,
    format: 'json' | 'csv' = 'json'
  ): Promise<string> {
    try {
      const logs = await this.getAuditLogs({ ...filters, limit: 10000 });

      if (format === 'csv') {
        return this.convertToCSV(logs.logs);
      }

      return JSON.stringify(logs.logs, null, 2);
    } catch (error) {
      logger.error('Failed to export audit logs', { error, filters, format });
      throw error;
    }
  }

  // Cleanup old audit logs
  async cleanupOldLogs(daysToKeep: number = 365): Promise<number> {
    try {
      const cutoffDate = new Date(
        Date.now() - daysToKeep * 24 * 60 * 60 * 1000
      );
      const result = await AuditLogModel.deleteMany({
        timestamp: { $lt: cutoffDate },
      });

      logger.info('Audit log cleanup completed', {
        deletedCount: result.deletedCount,
        cutoffDate,
      });

      return result.deletedCount;
    } catch (error) {
      logger.error('Audit log cleanup failed', { error });
      throw error;
    }
  }

  private shouldExcludePath(path: string): boolean {
    return this.config.excludePaths.some(excludedPath =>
      path.startsWith(excludedPath)
    );
  }

  private extractResourceIds(req: Request): string[] {
    const ids: string[] = [];

    // Extract ID from URL params
    if (req.params.id) {
      ids.push(req.params.id);
    }

    // Extract IDs from request body
    if (req.body?.id) {
      ids.push(req.body.id);
    }

    // Extract IDs from query params
    if (req.query?.id) {
      ids.push(req.query.id as string);
    }

    return ids.filter(id => id && typeof id === 'string');
  }

  private extractDeviceInfo(req: Request): any {
    return {
      userAgent: req.headers['user-agent'],
      ipAddress: this.getClientIP(req),
      platform: req.headers['sec-ch-ua-platform'],
      browser: req.headers['sec-ch-ua'],
    };
  }

  private captureOriginalValues(req: Request): any {
    // In a real implementation, this would capture current config values
    // before they are changed
    return {};
  }

  private getClientIP(req: Request): string {
    return (
      req.ip ||
      req.connection.remoteAddress ||
      req.socket.remoteAddress ||
      (req.connection as any)?.socket?.remoteAddress ||
      '127.0.0.1'
    );
  }

  private hashApiKey(apiKey: string): string {
    return require('crypto')
      .createHash('sha256')
      .update(apiKey)
      .digest('hex')
      .substring(0, 16);
  }

  private sanitizeBody(body: any): any {
    if (!body || typeof body !== 'object') {
      return body;
    }

    const sensitiveFields = [
      'password',
      'token',
      'secret',
      'key',
      'credential',
      'auth',
      'authorization',
      'csrf',
      'session',
    ];

    const sanitized = { ...body };

    for (const field of sensitiveFields) {
      if (field in sanitized) {
        sanitized[field] = '[REDACTED]';
      }
    }

    // Recursively sanitize nested objects
    for (const key in sanitized) {
      if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
        sanitized[key] = this.sanitizeBody(sanitized[key]);
      }
    }

    return sanitized;
  }

  private truncateBody(body: any): any {
    const bodyString = JSON.stringify(body);
    if (bodyString.length > this.config.maxBodySize) {
      return { body: '[BODY TOO LARGE - TRUNCATED]' };
    }
    return body;
  }

  private convertToCSV(logs: AuditLog[]): string {
    const headers = [
      'timestamp',
      'userId',
      'action',
      'resource',
      'resourceId',
      'ipAddress',
      'userAgent',
      'details',
    ];

    const csvRows = [headers.join(',')];

    for (const log of logs) {
      const row = [
        log.timestamp.toISOString(),
        log.userId || '',
        log.action,
        log.resource,
        log.resourceId || '',
        log.ipAddress,
        `"${log.userAgent}"`,
        `"${JSON.stringify(log.details).replace(/"/g, '""')}"`,
      ];
      csvRows.push(row.join(','));
    }

    return csvRows.join('\n');
  }
}

// Helper function to create audit entry
async function createAuditEntry(
  req: Request,
  res: Response,
  responseBody: any
): Promise<void> {
  try {
    const auditMiddleware = new AuditMiddleware();

    const auditLog: Partial<AuditLog> = {
      action: 'HTTP_REQUEST',
      resource: req.path,
      resourceId: req.params.id,
      details: {
        method: req.method,
        statusCode: res.statusCode,
        responseTime: Date.now() - (req as any).startTime,
        userAgent: req.headers['user-agent'],
        ipAddress: auditMiddleware['getClientIP'](req),
      },
      ipAddress: auditMiddleware['getClientIP'](req),
      userAgent: req.headers['user-agent'] || 'unknown',
      timestamp: new Date(),
    };

    // Add user context if available
    if ((req as any).user) {
      auditLog.userId = (req as any).user._id;
    }

    // Add service account context if available
    if ((req as any).serviceAccount) {
      auditLog.serviceAccountId = (req as any).serviceAccount._id;
    }

    // Add request body if configured
    if (auditMiddleware['config'].includeBody && req.body) {
      let bodyToLog = req.body;

      if (auditMiddleware['config'].sanitizeBody) {
        bodyToLog = auditMiddleware['sanitizeBody'](req.body);
      }

      bodyToLog = auditMiddleware['truncateBody'](bodyToLog);

      auditLog.details!.requestBody = bodyToLog;
    }

    // Add response body if configured and not too large
    if (responseBody && typeof responseBody === 'string') {
      try {
        const parsedBody = JSON.parse(responseBody);
        auditLog.details!.responseBody =
          auditMiddleware['truncateBody'](parsedBody);
      } catch (error) {
        // Response body is not JSON, skip it
      }
    }

    // Add custom audit contexts
    const contexts = [
      'auditContext',
      'securityEventContext',
      'dataAccessContext',
      'adminActionContext',
      'configChangeContext',
      'failedAuthContext',
      'sessionManagementContext',
      'apiKeyUsageContext',
      'customAuditContext',
    ];

    for (const context of contexts) {
      if ((req as any)[context]) {
        auditLog.details![context] = (req as any)[context];
      }
    }

    await AuditLogModel.create(auditLog);
  } catch (error) {
    logger.error('Failed to create audit entry', { error });
  }
}

// Middleware to add start time to request
export const addRequestTiming = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  (req as any).startTime = Date.now();
  next();
};
