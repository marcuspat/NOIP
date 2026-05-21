import jwt from 'jsonwebtoken';
import { config } from '../../config';
import { JWTPayload } from '../../types/auth.types';
import logger from '../logger';

export class JWTManager {
  private accessTokenSecret: string;
  private refreshTokenSecret: string;
  private issuer: string;
  private audience: string;

  constructor() {
    this.accessTokenSecret = config.security.jwt.secret;
    this.refreshTokenSecret = config.security.jwt.secret + '_refresh'; // Different secret for refresh tokens
    this.issuer = config.app.name;
    this.audience = 'noip-client';

    if (
      config.app.environment === 'production' &&
      this.accessTokenSecret === 'your-secret-key-change-in-production'
    ) {
      throw new Error('JWT secret must be changed in production');
    }
  }

  async signToken(
    payload: any,
    tokenType: 'access' | 'refresh' = 'access'
  ): Promise<string> {
    try {
      const secret =
        tokenType === 'access'
          ? this.accessTokenSecret
          : this.refreshTokenSecret;
      const expiresIn = tokenType === 'access' ? '15m' : '7d';

      // jsonwebtoken rejects signing when the payload already carries any
      // registered claim that is also supplied via options (exp/expiresIn,
      // aud/audience, iss/issuer). Callers may pre-populate these, so strip
      // them from the payload and let the sign options be the source of truth.
      const {
        exp: _exp,
        iat: _iat,
        nbf: _nbf,
        aud: _aud,
        iss: _iss,
        ...rest
      } = payload;
      const tokenPayload = {
        ...rest,
        type: tokenType,
      };

      return jwt.sign(tokenPayload, secret, {
        expiresIn,
        algorithm: 'HS256',
        audience: this.audience,
        issuer: this.issuer,
      });
    } catch (error) {
      logger.error('Failed to sign JWT token', { error, tokenType });
      throw new Error('Token generation failed');
    }
  }

  async verifyToken(
    token: string,
    tokenType: 'access' | 'refresh' = 'access'
  ): Promise<JWTPayload | null> {
    try {
      const secret =
        tokenType === 'access'
          ? this.accessTokenSecret
          : this.refreshTokenSecret;

      const decoded = jwt.verify(token, secret, {
        algorithms: ['HS256'],
        audience: this.audience,
        issuer: this.issuer,
      }) as JWTPayload;

      // Verify token type matches expected type
      if (decoded.type !== tokenType) {
        logger.warn('Token type mismatch', {
          expected: tokenType,
          actual: decoded.type,
        });
        return null;
      }

      // Check if token is expired
      if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) {
        logger.warn('Token expired', {
          exp: decoded.exp,
          now: Math.floor(Date.now() / 1000),
        });
        return null;
      }

      return decoded;
    } catch (error) {
      logger.error('Failed to verify JWT token', { error, tokenType });

      if (error instanceof jwt.TokenExpiredError) {
        logger.warn('Token expired', { error: error.message });
      } else if (error instanceof jwt.JsonWebTokenError) {
        logger.warn('Invalid token', { error: error.message });
      } else if (error instanceof jwt.NotBeforeError) {
        logger.warn('Token not active yet', { error: error.message });
      }

      return null;
    }
  }

  async decodeToken(token: string): Promise<JWTPayload | null> {
    try {
      const decoded = jwt.decode(token) as JWTPayload;
      return decoded;
    } catch (error) {
      logger.error('Failed to decode JWT token', { error });
      return null;
    }
  }

  async refreshToken(
    refreshToken: string
  ): Promise<{ accessToken: string; refreshToken: string } | null> {
    try {
      // Verify refresh token
      const payload = await this.verifyToken(refreshToken, 'refresh');
      if (!payload) {
        return null;
      }

      // Generate new access token
      const accessTokenPayload = {
        ...payload,
        type: 'access' as const,
        exp: Math.floor(Date.now() / 1000) + 15 * 60, // 15 minutes
      };

      const accessToken = await this.signToken(accessTokenPayload, 'access');

      // Optionally generate new refresh token
      const newRefreshTokenPayload = {
        ...payload,
        type: 'refresh' as const,
        exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60, // 7 days
      };

      const newRefreshToken = await this.signToken(
        newRefreshTokenPayload,
        'refresh'
      );

      return {
        accessToken,
        refreshToken: newRefreshToken,
      };
    } catch (error) {
      logger.error('Failed to refresh token', { error });
      return null;
    }
  }

  async createTokenPair(
    payload: any
  ): Promise<{ accessToken: string; refreshToken: string }> {
    try {
      const accessTokenPayload = {
        ...payload,
        type: 'access' as const,
        exp: Math.floor(Date.now() / 1000) + 15 * 60, // 15 minutes
      };

      const refreshTokenPayload = {
        ...payload,
        type: 'refresh' as const,
        exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60, // 7 days
      };

      const [accessToken, refreshToken] = await Promise.all([
        this.signToken(accessTokenPayload, 'access'),
        this.signToken(refreshTokenPayload, 'refresh'),
      ]);

      return { accessToken, refreshToken };
    } catch (error) {
      logger.error('Failed to create token pair', { error });
      throw new Error('Token pair creation failed');
    }
  }

  getTokenRemainingTime(token: string): number {
    try {
      const decoded = jwt.decode(token) as JWTPayload;
      if (!decoded || !decoded.exp) {
        return 0;
      }

      const remainingTime = decoded.exp * 1000 - Date.now();
      return Math.max(0, remainingTime);
    } catch (error) {
      return 0;
    }
  }

  isTokenExpired(token: string): boolean {
    return this.getTokenRemainingTime(token) === 0;
  }

  async revokeToken(token: string): Promise<void> {
    // In a real implementation, you would add the token to a blacklist
    // This could be stored in Redis with an expiration time
    logger.info('Token revocation requested', {
      token: token.substring(0, 10) + '...',
    });
  }

  async isTokenRevoked(token: string): Promise<boolean> {
    // Check if token is in the blacklist
    // This would typically check Redis or another fast store
    return false;
  }

  generateKeyId(): string {
    return `kid_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
  }

  async rotateSecrets(): Promise<void> {
    // Implementation for key rotation
    // This would involve generating new secrets and updating configuration
    logger.info('JWT secret rotation initiated');
  }
}
