import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import {
  JWTManager,
  type RedisLike,
  type PasswordChangedAtLoader,
} from '../utils/auth/jwt.manager';
import { SessionModel, UserModel, SecurityEventModel } from '../models';
import {
  JWTPayload,
  SecurityEventType,
  SecurityEventSeverity,
} from '../types/auth.types';
import logger from '../utils/logger';

export interface AuthenticatedRequest extends Request {
  user?: any;
  session?: any;
  tokenPayload?: JWTPayload;
}

/** Optional injection point for the JWT manager + Redis-backed denylist. */
export interface AuthMiddlewareOptions {
  jwtManager?: JWTManager;
  redis?: RedisLike;
  passwordChangedAtLoader?: PasswordChangedAtLoader;
}

/**
 * Default loader used by the middleware when one isn't injected: pulls
 * `passwordChangedAt` from the User model so that ADR-0006's
 * `token.iat < user.passwordChangedAt ⇒ revoked` rule is enforced.
 */
const userModelPasswordLoader: PasswordChangedAtLoader = async userId => {
  try {
    const u = await UserModel.findById(userId).select('passwordChangedAt');
    return u?.passwordChangedAt ?? null;
  } catch {
    return null;
  }
};

export class AuthMiddleware {
  private jwtManager: JWTManager;

  constructor(opts: AuthMiddlewareOptions = {}) {
    if (opts.jwtManager) {
      this.jwtManager = opts.jwtManager;
      if (opts.redis) {
        this.jwtManager.setRedis(opts.redis);
      }
    } else {
      const managerOpts: ConstructorParameters<typeof JWTManager>[0] = {
        passwordChangedAtLoader:
          opts.passwordChangedAtLoader ?? userModelPasswordLoader,
      };
      if (opts.redis) {
        managerOpts.redis = opts.redis;
      }
      this.jwtManager = new JWTManager(managerOpts);
    }
  }

  authenticate = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const token = this.extractToken(req);
      if (!token) {
        await this.createSecurityEvent(
          req,
          SecurityEventType.LOGIN_FAILURE,
          'Missing authentication token'
        );
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      // Verify JWT token
      const payload = await this.jwtManager.verifyToken(token, 'access');
      if (!payload) {
        await this.createSecurityEvent(
          req,
          SecurityEventType.LOGIN_FAILURE,
          'Invalid authentication token'
        );
        res.status(401).json({ error: 'Invalid or expired token' });
        return;
      }

      // Check if token is revoked
      const isRevoked = await this.jwtManager.isTokenRevoked(token);
      if (isRevoked) {
        await this.createSecurityEvent(
          req,
          SecurityEventType.TOKEN_REVOKED,
          'Attempted use of revoked token'
        );
        res.status(401).json({ error: 'Token has been revoked' });
        return;
      }

      // Verify session exists and is active
      const session = await SessionModel.findOne({
        userId: payload.sub,
        sessionId: payload.sessionId,
        isActive: true,
        expiresAt: { $gt: new Date() },
      });

      if (!session) {
        await this.createSecurityEvent(
          req,
          SecurityEventType.LOGIN_FAILURE,
          'Invalid or expired session'
        );
        res.status(401).json({ error: 'Session expired or invalid' });
        return;
      }

      // Get user
      const user = await UserModel.findById(payload.sub).populate(
        'roles permissions'
      );
      if (!user || user.status !== 'active') {
        await this.createSecurityEvent(
          req,
          SecurityEventType.LOGIN_FAILURE,
          'User not found or inactive',
          { userId: payload.sub }
        );
        res.status(401).json({ error: 'User not found or inactive' });
        return;
      }

      // Update session activity
      await session.updateLastActivity();

      // Attach user and session to request
      req.user = user;
      req.session = session;
      req.tokenPayload = payload;

      next();
    } catch (error) {
      logger.error('Authentication middleware error', { error });
      await this.createSecurityEvent(
        req,
        SecurityEventType.LOGIN_FAILURE,
        'Authentication middleware error'
      );
      res.status(500).json({ error: 'Authentication failed' });
    }
  };

  optionalAuth = async (
    req: AuthenticatedRequest,
    _res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const token = this.extractToken(req);
      if (!token) {
        next();
        return;
      }

      const payload = await this.jwtManager.verifyToken(token, 'access');
      if (!payload) {
        next();
        return;
      }

      const session = await SessionModel.findOne({
        userId: payload.sub,
        sessionId: payload.sessionId,
        isActive: true,
        expiresAt: { $gt: new Date() },
      });

      if (!session) {
        next();
        return;
      }

      const user = await UserModel.findById(payload.sub).populate(
        'roles permissions'
      );
      if (!user || user.status !== 'active') {
        next();
        return;
      }

      await session.updateLastActivity();

      req.user = user;
      req.session = session;
      req.tokenPayload = payload;

      next();
    } catch (error) {
      logger.error('Optional authentication middleware error', { error });
      next(); // Continue without authentication for optional auth
    }
  };

  requireMFA = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      if (req.user.mfaEnabled && !req.session?.mfaVerified) {
        res.status(403).json({ error: 'MFA verification required' });
        return;
      }

      next();
    } catch (error) {
      logger.error('MFA middleware error', { error });
      res.status(500).json({ error: 'MFA verification failed' });
    }
  };

  requireRole = (requiredRole: string) => {
    return async (
      req: AuthenticatedRequest,
      res: Response,
      next: NextFunction
    ): Promise<void> => {
      try {
        if (!req.user) {
          res.status(401).json({ error: 'Authentication required' });
          return;
        }

        const hasRole = req.user.roles?.some(
          (role: any) => role.name === requiredRole
        );
        if (!hasRole) {
          await this.createSecurityEvent(
            req,
            SecurityEventType.PERMISSION_ESCALATION,
            `Access denied - missing role: ${requiredRole}`
          );
          res.status(403).json({ error: 'Insufficient permissions' });
          return;
        }

        next();
      } catch (error) {
        logger.error('Role middleware error', { error });
        res.status(500).json({ error: 'Authorization failed' });
      }
    };
  };

  requirePermission = (resource: string, action: string) => {
    return async (
      req: AuthenticatedRequest,
      res: Response,
      next: NextFunction
    ): Promise<void> => {
      try {
        if (!req.user) {
          res.status(401).json({ error: 'Authentication required' });
          return;
        }

        const hasPermission = await this.checkPermission(
          req.user,
          resource,
          action,
          req
        );
        if (!hasPermission) {
          await this.createSecurityEvent(
            req,
            SecurityEventType.PERMISSION_ESCALATION,
            `Access denied - missing permission: ${resource}:${action}`
          );
          res.status(403).json({ error: 'Insufficient permissions' });
          return;
        }

        next();
      } catch (error) {
        logger.error('Permission middleware error', { error });
        res.status(500).json({ error: 'Authorization failed' });
      }
    };
  };

  requireOwnership = (resourceParam: string = 'id') => {
    return async (
      req: AuthenticatedRequest,
      res: Response,
      next: NextFunction
    ): Promise<void> => {
      try {
        if (!req.user) {
          res.status(401).json({ error: 'Authentication required' });
          return;
        }

        const resourceId = req.params[resourceParam];
        if (!resourceId) {
          res.status(400).json({ error: 'Resource ID required' });
          return;
        }

        // Check if user owns the resource or has admin permissions
        const isOwner = await this.checkOwnership(
          req.user._id,
          resourceId,
          req.route?.path || ''
        );
        const isAdmin = req.user.roles?.some((role: any) =>
          ['admin', 'super_admin'].includes(role.name)
        );

        if (!isOwner && !isAdmin) {
          await this.createSecurityEvent(
            req,
            SecurityEventType.PERMISSION_ESCALATION,
            `Access denied - not owner of resource: ${resourceId}`
          );
          res.status(403).json({ error: 'Access denied' });
          return;
        }

        next();
      } catch (error) {
        logger.error('Ownership middleware error', { error });
        res.status(500).json({ error: 'Authorization failed' });
      }
    };
  };

  requireEmailVerification = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      if (!req.user.emailVerified) {
        res.status(403).json({ error: 'Email verification required' });
        return;
      }

      next();
    } catch (error) {
      logger.error('Email verification middleware error', { error });
      res.status(500).json({ error: 'Authorization failed' });
    }
  };

  validateSession = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      if (!req.session) {
        res.status(401).json({ error: 'Valid session required' });
        return;
      }

      // Check if session is still active
      if (req.session.isExpired()) {
        await req.session.revoke();
        res.status(401).json({ error: 'Session expired' });
        return;
      }

      // Check for suspicious activity
      const currentFingerprint = this.extractDeviceFingerprint(req);
      if (req.session.deviceFingerprint !== currentFingerprint) {
        await this.createSecurityEvent(
          req,
          SecurityEventType.SUSPICIOUS_LOGIN,
          'Device fingerprint mismatch'
        );
        // Optionally require re-authentication
        res.status(403).json({
          error: 'Session validation failed - please re-authenticate',
        });
        return;
      }

      next();
    } catch (error) {
      logger.error('Session validation middleware error', { error });
      res.status(500).json({ error: 'Session validation failed' });
    }
  };

  private extractToken(req: Request): string | null {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }
    return null;
  }

  private extractDeviceFingerprint(req: Request): string {
    // In a real implementation, this would generate a fingerprint from various request headers
    const userAgent = req.headers['user-agent'] || 'unknown';
    const acceptLanguage = req.headers['accept-language'] || 'unknown';
    const acceptEncoding = req.headers['accept-encoding'] || 'unknown';

    return crypto
      .createHash('sha256')
      .update(`${userAgent}|${acceptLanguage}|${acceptEncoding}`)
      .digest('hex');
  }

  private async checkPermission(
    user: any,
    resource: string,
    action: string,
    req: Request
  ): Promise<boolean> {
    // Check direct permissions
    const directPermission = user.permissions?.find(
      (perm: any) => perm.resource === resource && perm.action === action
    );

    if (directPermission) {
      // Check if permission has conditions that need to be evaluated
      if (
        directPermission.conditions &&
        Object.keys(directPermission.conditions).length > 0
      ) {
        return this.evaluatePermissionConditions(
          directPermission.conditions,
          req,
          user
        );
      }
      return true;
    }

    // Check permissions from roles
    for (const role of user.roles || []) {
      const rolePermission = role.permissions?.find(
        (perm: any) => perm.resource === resource && perm.action === action
      );

      if (rolePermission) {
        if (
          rolePermission.conditions &&
          Object.keys(rolePermission.conditions).length > 0
        ) {
          return this.evaluatePermissionConditions(
            rolePermission.conditions,
            req,
            user
          );
        }
        return true;
      }
    }

    // Check for admin permissions
    const isAdmin = user.roles?.some((role: any) =>
      ['admin', 'super_admin'].includes(role.name)
    );
    if (isAdmin && resource === 'admin') {
      return true;
    }

    return false;
  }

  private evaluatePermissionConditions(
    conditions: any,
    req: Request,
    user: any
  ): boolean {
    try {
      // Evaluate permission conditions based on context
      for (const [key, condition] of Object.entries(conditions)) {
        if (!this.evaluateCondition(key, condition, req, user)) {
          return false;
        }
      }
      return true;
    } catch (error) {
      logger.error('Failed to evaluate permission conditions', {
        error,
        conditions,
      });
      return false; // Fail securely
    }
  }

  private evaluateCondition(
    key: string,
    condition: any,
    req: Request,
    user: any
  ): boolean {
    const contextValue = this.getContextValue(key, req, user);

    if (typeof condition === 'object' && condition !== null) {
      if (condition.operator && condition.value) {
        return this.evaluateOperator(
          condition.operator,
          contextValue,
          condition.value
        );
      }
    }

    return contextValue === condition;
  }

  private getContextValue(key: string, req: Request, user: any): any {
    const keys = key.split('.');
    let value: any = { req, user };

    for (const keyPart of keys) {
      if (value && typeof value === 'object' && keyPart in value) {
        value = value[keyPart];
      } else {
        return undefined;
      }
    }

    return value;
  }

  private evaluateOperator(
    operator: string,
    contextValue: any,
    conditionValue: any
  ): boolean {
    switch (operator) {
      case 'equals':
        return contextValue === conditionValue;
      case 'not_equals':
        return contextValue !== conditionValue;
      case 'in':
        return (
          Array.isArray(conditionValue) && conditionValue.includes(contextValue)
        );
      case 'not_in':
        return (
          Array.isArray(conditionValue) &&
          !conditionValue.includes(contextValue)
        );
      case 'contains':
        return (
          typeof contextValue === 'string' &&
          contextValue.includes(conditionValue)
        );
      case 'greater_than':
        return Number(contextValue) > Number(conditionValue);
      case 'less_than':
        return Number(contextValue) < Number(conditionValue);
      default:
        return false;
    }
  }

  private async checkOwnership(
    _userId: string,
    _resourceId: string,
    _resourcePath: string
  ): Promise<boolean> {
    // In a real implementation, this would check if the user owns the resource
    // This would involve database queries specific to the resource type
    return false; // Mock implementation
  }

  private async createSecurityEvent(
    req: Request,
    type: SecurityEventType,
    description: string,
    details?: any
  ): Promise<void> {
    try {
      await SecurityEventModel.createEvent(
        type,
        description,
        this.getClientIP(req),
        req.headers['user-agent'] || 'unknown',
        {
          userId: (req as AuthenticatedRequest).user?._id,
          sessionId: (req as AuthenticatedRequest).session?._id,
          severity: this.getEventSeverity(type),
          details,
        }
      );
    } catch (error) {
      logger.error('Failed to create security event', { error, type });
    }
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

  private getEventSeverity(type: SecurityEventType): SecurityEventSeverity {
    switch (type) {
      case SecurityEventType.PERMISSION_ESCALATION:
      case SecurityEventType.TOKEN_REVOKED:
        return SecurityEventSeverity.HIGH;
      case SecurityEventType.LOGIN_FAILURE:
      case SecurityEventType.SUSPICIOUS_LOGIN:
        return SecurityEventSeverity.MEDIUM;
      default:
        return SecurityEventSeverity.LOW;
    }
  }
}
