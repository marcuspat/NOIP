import { Request, Response } from 'express';
import { AuthService } from '../services/auth.service';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import {
  LoginRequest,
  RegisterRequest,
  MFASetupRequest,
  MFAVerificationRequest,
  PasswordChangeRequest,
  PasswordResetRequest,
  PasswordResetConfirmRequest,
} from '../types/auth.types';
import logger from '../utils/logger';
import { validationResult } from 'express-validator';

/** Optional DI envelope for the controller. */
export interface AuthControllerDeps {
  /** Pre-built AuthService (from the composition root). */
  authService?: AuthService;
}

export class AuthController {
  private authService: AuthService;

  constructor(deps: AuthControllerDeps = {}) {
    this.authService = deps.authService ?? new AuthService();
  }

  // Initialize authentication service
  async initialize(): Promise<void> {
    await this.authService.initialize();
  }

  // User registration
  register = async (req: Request, res: Response): Promise<void> => {
    try {
      // Validate request
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          error: 'Validation failed',
          details: errors.array(),
        });
        return;
      }

      const userData: RegisterRequest = req.body;
      const result = await this.authService.register(userData);

      res.status(201).json({
        success: true,
        message: 'User registered successfully',
        data: {
          user: result.user,
          requiresVerification: result.requiresVerification,
        },
      });
    } catch (error) {
      logger.error('Registration failed', {
        error,
        userData: { ...req.body, password: '[REDACTED]' },
      });

      res.status(400).json({
        success: false,
        error: (error as Error).message,
      });
    }
  };

  // User login
  login = async (req: Request, res: Response): Promise<void> => {
    try {
      // Validate request
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          error: 'Validation failed',
          details: errors.array(),
        });
        return;
      }

      const loginData: LoginRequest = {
        ...req.body,
        deviceFingerprint: this.extractDeviceFingerprint(req),
      };

      const result = await this.authService.login(loginData);

      if (result.requiresMFA) {
        res.status(200).json({
          success: true,
          message: 'MFA verification required',
          data: {
            user: result.user,
            requiresMFA: true,
            mfaMethods: result.mfaMethods,
          },
        });
        return;
      }

      // Set HTTP-only cookies for tokens
      res.cookie('accessToken', result.tokens.accessToken, {
        httpOnly: true,
        secure: process.env['NODE_ENV'] === 'production',
        sameSite: 'strict',
        maxAge: 15 * 60 * 1000, // 15 minutes
      });

      res.cookie('refreshToken', result.tokens.refreshToken, {
        httpOnly: true,
        secure: process.env['NODE_ENV'] === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      });

      res.status(200).json({
        success: true,
        message: 'Login successful',
        data: {
          user: result.user,
          tokens: result.tokens,
          requiresMFA: false,
        },
      });
    } catch (error) {
      logger.error('Login failed', { error, username: req.body.username });

      res.status(401).json({
        success: false,
        error: (error as Error).message,
      });
    }
  };

  // User logout
  logout = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.user || !req.session) {
        res.status(401).json({
          success: false,
          error: 'Not authenticated',
        });
        return;
      }

      await this.authService.logout(req.user._id, req.session.sessionId);

      // Clear cookies
      res.clearCookie('accessToken');
      res.clearCookie('refreshToken');

      res.status(200).json({
        success: true,
        message: 'Logout successful',
      });
    } catch (error) {
      logger.error('Logout failed', { error });

      res.status(500).json({
        success: false,
        error: 'Logout failed',
      });
    }
  };

  // Refresh token
  refreshToken = async (req: Request, res: Response): Promise<void> => {
    try {
      const refreshToken = req.cookies.refreshToken || req.body.refreshToken;

      if (!refreshToken) {
        res.status(401).json({
          success: false,
          error: 'Refresh token required',
        });
        return;
      }

      const tokens = await this.authService.refreshToken(refreshToken);

      // Set new access token cookie
      res.cookie('accessToken', tokens.accessToken, {
        httpOnly: true,
        secure: process.env['NODE_ENV'] === 'production',
        sameSite: 'strict',
        maxAge: 15 * 60 * 1000, // 15 minutes
      });

      // Optionally update refresh token cookie
      if (req.body.refreshToken) {
        res.cookie('refreshToken', tokens.refreshToken, {
          httpOnly: true,
          secure: process.env['NODE_ENV'] === 'production',
          sameSite: 'strict',
          maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        });
      }

      res.status(200).json({
        success: true,
        message: 'Token refreshed successfully',
        data: { tokens },
      });
    } catch (error) {
      logger.error('Token refresh failed', { error });

      res.status(401).json({
        success: false,
        error: (error as Error).message,
      });
    }
  };

  // Get current user profile
  getProfile = async (
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          success: false,
          error: 'Not authenticated',
        });
        return;
      }

      const profile = await this.authService.getProfile(req.user._id);

      res.status(200).json({
        success: true,
        data: { user: profile },
      });
    } catch (error) {
      logger.error('Get profile failed', { error });

      res.status(500).json({
        success: false,
        error: 'Failed to get profile',
      });
    }
  };

  // Setup MFA
  setupMFA = async (
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          success: false,
          error: 'Not authenticated',
        });
        return;
      }

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          error: 'Validation failed',
          details: errors.array(),
        });
        return;
      }

      const setupData: MFASetupRequest = req.body;
      const result = await this.authService.setupMFA(req.user._id, setupData);

      res.status(200).json({
        success: true,
        message: 'MFA setup initiated',
        data: result,
      });
    } catch (error) {
      logger.error('MFA setup failed', { error, userId: req.user?._id });

      res.status(400).json({
        success: false,
        error: (error as Error).message,
      });
    }
  };

  // Verify MFA
  verifyMFA = async (
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          success: false,
          error: 'Not authenticated',
        });
        return;
      }

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          error: 'Validation failed',
          details: errors.array(),
        });
        return;
      }

      const verificationData: MFAVerificationRequest = req.body;
      const isValid = await this.authService.verifyMFA(
        req.user._id,
        verificationData
      );

      if (isValid) {
        // Update session to mark MFA as verified
        if (req.session) {
          req.session.mfaVerified = true;
          await req.session.save();
        }

        res.status(200).json({
          success: true,
          message: 'MFA verification successful',
        });
      } else {
        res.status(400).json({
          success: false,
          error: 'Invalid MFA code',
        });
      }
    } catch (error) {
      logger.error('MFA verification failed', { error, userId: req.user?._id });

      res.status(500).json({
        success: false,
        error: 'MFA verification failed',
      });
    }
  };

  // Change password
  changePassword = async (
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          success: false,
          error: 'Not authenticated',
        });
        return;
      }

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          error: 'Validation failed',
          details: errors.array(),
        });
        return;
      }

      const passwordData: PasswordChangeRequest = req.body;
      await this.authService.changePassword(req.user._id, passwordData);

      res.status(200).json({
        success: true,
        message: 'Password changed successfully',
      });
    } catch (error) {
      logger.error('Password change failed', { error, userId: req.user?._id });

      res.status(400).json({
        success: false,
        error: (error as Error).message,
      });
    }
  };

  // Request password reset
  requestPasswordReset = async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          error: 'Validation failed',
          details: errors.array(),
        });
        return;
      }

      const resetData: PasswordResetRequest = req.body;
      await this.authService.requestPasswordReset(resetData);

      // Always return success to prevent user enumeration
      res.status(200).json({
        success: true,
        message:
          'If an account with that email exists, a password reset link has been sent',
      });
    } catch (error) {
      logger.error('Password reset request failed', { error });

      // Still return success to prevent user enumeration
      res.status(200).json({
        success: true,
        message:
          'If an account with that email exists, a password reset link has been sent',
      });
    }
  };

  // Confirm password reset
  confirmPasswordReset = async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          error: 'Validation failed',
          details: errors.array(),
        });
        return;
      }

      const confirmData: PasswordResetConfirmRequest = req.body;
      await this.authService.confirmPasswordReset(confirmData);

      res.status(200).json({
        success: true,
        message: 'Password reset successfully',
      });
    } catch (error) {
      logger.error('Password reset confirmation failed', { error });

      res.status(400).json({
        success: false,
        error: (error as Error).message,
      });
    }
  };

  // Verify email
  verifyEmail = async (req: Request, res: Response): Promise<void> => {
    try {
      const { token } = req.query;

      if (!token || typeof token !== 'string') {
        res.status(400).json({
          success: false,
          error: 'Verification token required',
        });
        return;
      }

      await this.authService.verifyEmail(token);

      res.status(200).json({
        success: true,
        message: 'Email verified successfully',
      });
    } catch (error) {
      logger.error('Email verification failed', { error });

      res.status(400).json({
        success: false,
        error: (error as Error).message,
      });
    }
  };

  // Get authentication metrics
  getMetrics = async (
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> => {
    try {
      // Only allow admins to access metrics
      if (
        !req.user?.roles?.some((role: any) =>
          ['admin', 'super_admin'].includes(role.name)
        )
      ) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions',
        });
        return;
      }

      const metrics = await this.authService.getAuthenticationMetrics();

      res.status(200).json({
        success: true,
        data: { metrics },
      });
    } catch (error) {
      logger.error('Get metrics failed', { error });

      res.status(500).json({
        success: false,
        error: 'Failed to get metrics',
      });
    }
  };

  // Health check
  healthCheck = async (_req: Request, res: Response): Promise<void> => {
    try {
      const health = await this.authService.healthCheck();

      res.status(health.status === 'healthy' ? 200 : 503).json({
        success: health.status === 'healthy',
        data: health,
      });
    } catch (error) {
      logger.error('Health check failed', { error });

      res.status(503).json({
        success: false,
        error: 'Health check failed',
      });
    }
  };

  /**
   * Rate-limit status endpoint. Post-ADR-0016 wave-3-followup the auth
   * router mounts `createBucketLimiter` directly per route group, so the
   * legacy per-key status lookup no longer has a single backing store.
   * The endpoint is kept as a compatible 200 with `null` data so the
   * admin UI doesn't 500; operators consult Redis (`noip:rl:*`) for
   * real visibility.
   */
  getRateLimitStatus = async (
    _req: AuthenticatedRequest,
    res: Response
  ): Promise<void> => {
    try {
      res.status(200).json({
        success: true,
        data: { rateLimit: null },
      });
    } catch (error) {
      logger.error('Get rate limit status failed', { error });

      res.status(500).json({
        success: false,
        error: 'Failed to get rate limit status',
      });
    }
  };

  // Helper methods
  private extractDeviceFingerprint(req: Request): string {
    const userAgent = req.headers['user-agent'] || 'unknown';
    const acceptLanguage = req.headers['accept-language'] || 'unknown';
    const acceptEncoding = req.headers['accept-encoding'] || 'unknown';

    return require('crypto')
      .createHash('sha256')
      .update(`${userAgent}|${acceptLanguage}|${acceptEncoding}`)
      .digest('hex');
  }
}
