import { Request, Response, NextFunction } from 'express';
import { AuthMiddleware, AuthenticatedRequest } from '../../src/middleware/auth.middleware';
import { JWTManager } from '../../src/utils/auth/jwt.manager';
import { SessionModel, UserModel, SecurityEventModel } from '../../src/models';
import { UserStatus, SecurityEventType } from '../../src/types/auth.types';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

describe('AuthMiddleware', () => {
  let authMiddleware: AuthMiddleware;
  let jwtManager: JWTManager;
  let mongoServer: MongoMemoryServer;
  let testUser: any;
  let testSession: any;
  let validToken: string;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);

    authMiddleware = new AuthMiddleware();
    jwtManager = new JWTManager();

    // Create test user
    testUser = await UserModel.create({
      username: 'testuser',
      email: 'test@example.com',
      passwordHash: 'hashedpassword',
      firstName: 'Test',
      lastName: 'User',
      status: UserStatus.ACTIVE
    });

    // Create test session
    testSession = await SessionModel.create({
      userId: testUser._id,
      sessionId: 'test-session-id',
      deviceFingerprint: 'test-fingerprint',
      deviceInfo: {
        platform: 'test',
        browser: 'test',
        version: '1.0',
        mobile: false,
        trusted: false,
        lastSeen: new Date()
      },
      ipAddress: '127.0.0.1',
      userAgent: 'test-agent',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
      isActive: true
    });

    // Generate valid JWT token
    const payload = {
      sub: testUser._id.toString(),
      username: testUser.username,
      email: testUser.email,
      roles: ['user'],
      permissions: ['user:read:own'],
      sessionId: testSession.sessionId,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + (15 * 60), // 15 minutes
      iss: 'NOIP Platform',
      aud: 'noip-client',
      type: 'access' as const
    };

    validToken = await jwtManager.signToken(payload, 'access');
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await SecurityEventModel.deleteMany({});
  });

  describe('authenticate', () => {
    it('should authenticate user with valid token', async () => {
      const req = {
        headers: {
          authorization: `Bearer ${validToken}`
        }
      } as AuthenticatedRequest;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      } as any;

      const next = jest.fn();

      await authMiddleware.authenticate(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeDefined();
      expect(req.user._id.toString()).toBe(testUser._id.toString());
      expect(req.session).toBeDefined();
      expect(req.session.sessionId).toBe(testSession.sessionId);
      expect(req.tokenPayload).toBeDefined();
    });

    it('should reject request without token', async () => {
      const req = {
        headers: {}
      } as AuthenticatedRequest;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      } as any;

      const next = jest.fn();

      await authMiddleware.authenticate(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Authentication required' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should reject request with invalid token', async () => {
      const req = {
        headers: {
          authorization: 'Bearer invalid-token'
        }
      } as AuthenticatedRequest;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      } as any;

      const next = jest.fn();

      await authMiddleware.authenticate(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired token' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should reject request with expired session', async () => {
      // Create expired session
      const expiredSession = await SessionModel.create({
        userId: testUser._id,
        sessionId: 'expired-session-id',
        deviceFingerprint: 'test-fingerprint',
        deviceInfo: {
          platform: 'test',
          browser: 'test',
          version: '1.0',
          mobile: false,
          trusted: false,
          lastSeen: new Date()
        },
        ipAddress: '127.0.0.1',
        userAgent: 'test-agent',
        expiresAt: new Date(Date.now() - 1000), // Expired
        isActive: true
      });

      const payload = {
        sub: testUser._id.toString(),
        username: testUser.username,
        email: testUser.email,
        roles: ['user'],
        permissions: ['user:read:own'],
        sessionId: expiredSession.sessionId,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + (15 * 60),
        iss: 'NOIP Platform',
        aud: 'noip-client',
        type: 'access' as const
      };

      const token = await jwtManager.signToken(payload, 'access');

      const req = {
        headers: {
          authorization: `Bearer ${token}`
        }
      } as AuthenticatedRequest;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      } as any;

      const next = jest.fn();

      await authMiddleware.authenticate(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Session expired or invalid' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should reject request with inactive user', async () => {
      // Create inactive user
      const inactiveUser = await UserModel.create({
        username: 'inactiveuser',
        email: 'inactive@example.com',
        passwordHash: 'hashedpassword',
        firstName: 'Inactive',
        lastName: 'User',
        status: UserStatus.INACTIVE
      });

      const payload = {
        sub: inactiveUser._id.toString(),
        username: inactiveUser.username,
        email: inactiveUser.email,
        roles: ['user'],
        permissions: ['user:read:own'],
        sessionId: testSession.sessionId,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + (15 * 60),
        iss: 'NOIP Platform',
        aud: 'noip-client',
        type: 'access' as const
      };

      const token = await jwtManager.signToken(payload, 'access');

      const req = {
        headers: {
          authorization: `Bearer ${token}`
        }
      } as AuthenticatedRequest;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      } as any;

      const next = jest.fn();

      await authMiddleware.authenticate(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'User not found or inactive' });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('optionalAuth', () => {
    it('should continue without authentication if no token provided', async () => {
      const req = {
        headers: {}
      } as AuthenticatedRequest;

      const res = {} as Response;
      const next = jest.fn();

      await authMiddleware.optionalAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeUndefined();
      expect(req.session).toBeUndefined();
    });

    it('should authenticate if valid token provided', async () => {
      const req = {
        headers: {
          authorization: `Bearer ${validToken}`
        }
      } as AuthenticatedRequest;

      const res = {} as Response;
      const next = jest.fn();

      await authMiddleware.optionalAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeDefined();
      expect(req.session).toBeDefined();
    });
  });

  describe('requireMFA', () => {
    it('should allow access if MFA is not enabled', async () => {
      const req = {
        user: { mfaEnabled: false },
        session: { mfaVerified: false }
      } as AuthenticatedRequest;

      const res = {} as Response;
      const next = jest.fn();

      await authMiddleware.requireMFA(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should allow access if MFA is verified', async () => {
      const req = {
        user: { mfaEnabled: true },
        session: { mfaVerified: true }
      } as AuthenticatedRequest;

      const res = {} as Response;
      const next = jest.fn();

      await authMiddleware.requireMFA(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should reject access if MFA is enabled but not verified', async () => {
      const req = {
        user: { mfaEnabled: true },
        session: { mfaVerified: false }
      } as AuthenticatedRequest;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      } as any;

      const next = jest.fn();

      await authMiddleware.requireMFA(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'MFA verification required' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should reject access if user is not authenticated', async () => {
      const req = {} as AuthenticatedRequest;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      } as any;

      const next = jest.fn();

      await authMiddleware.requireMFA(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Authentication required' });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('requireRole', () => {
    it('should allow access if user has required role', async () => {
      const req = {
        user: {
          roles: [
            { name: 'admin' },
            { name: 'user' }
          ]
        }
      } as AuthenticatedRequest;

      const res = {} as Response;
      const next = jest.fn();

      const middleware = authMiddleware.requireRole('admin');
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should reject access if user does not have required role', async () => {
      const req = {
        user: {
          roles: [
            { name: 'user' }
          ]
        }
      } as AuthenticatedRequest;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      } as any;

      const next = jest.fn();

      const middleware = authMiddleware.requireRole('admin');
      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Insufficient permissions' });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('requirePermission', () => {
    it('should allow access if user has required permission', async () => {
      const req = {
        user: {
          permissions: [
            { resource: 'user', action: 'read' },
            { resource: 'admin', action: 'update' }
          ]
        }
      } as AuthenticatedRequest;

      const res = {} as Response;
      const next = jest.fn();

      const middleware = authMiddleware.requirePermission('user', 'read');
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should reject access if user does not have required permission', async () => {
      const req = {
        user: {
          permissions: [
            { resource: 'user', action: 'read' }
          ]
        }
      } as AuthenticatedRequest;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      } as any;

      const next = jest.fn();

      const middleware = authMiddleware.requirePermission('admin', 'delete');
      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Insufficient permissions' });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('requireEmailVerification', () => {
    it('should allow access if email is verified', async () => {
      const req = {
        user: { emailVerified: true }
      } as AuthenticatedRequest;

      const res = {} as Response;
      const next = jest.fn();

      await authMiddleware.requireEmailVerification(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should reject access if email is not verified', async () => {
      const req = {
        user: { emailVerified: false }
      } as AuthenticatedRequest;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      } as any;

      const next = jest.fn();

      await authMiddleware.requireEmailVerification(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Email verification required' });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('validateSession', () => {
    it('should allow access with valid session', async () => {
      const req = {
        session: {
          isExpired: jest.fn().mockReturnValue(false),
          deviceFingerprint: 'test-fingerprint'
        }
      } as any;

      const res = {} as Response;
      const next = jest.fn();

      // Mock device fingerprint extraction
      jest.spyOn(authMiddleware as any, 'extractDeviceFingerprint').mockReturnValue('test-fingerprint');

      await authMiddleware.validateSession(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should reject access with expired session', async () => {
      const req = {
        session: {
          isExpired: jest.fn().mockReturnValue(true),
          revoke: jest.fn()
        }
      } as any;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      } as any;

      const next = jest.fn();

      await authMiddleware.validateSession(req, res, next);

      expect(req.session.revoke).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Session expired' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should reject access if session is missing', async () => {
      const req = {} as AuthenticatedRequest;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      } as any;

      const next = jest.fn();

      await authMiddleware.validateSession(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Valid session required' });
      expect(next).not.toHaveBeenCalled();
    });
  });
});