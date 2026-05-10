import { config } from '../../src/config';
import { validateConfig } from '../../src/config/validation';

type Cfg = typeof config;

/**
 * Build a fresh deep clone of the real config so tests can mutate it without
 * polluting other suites. We never depend on real `process.env` — `env` is
 * always passed in explicitly.
 */
function makeConfig(overrides: (cfg: Cfg) => void = () => undefined): Cfg {
  const clone = JSON.parse(JSON.stringify(config)) as Cfg;
  // The real config carries an `algorithm` literal that survives JSON, but
  // assert the field is preserved at the type level.
  clone.security.jwt.algorithm = 'HS256';
  overrides(clone);
  return clone;
}

const PROD_ENV: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
const DEV_ENV: NodeJS.ProcessEnv = { NODE_ENV: 'development' };

describe('validateConfig', () => {
  describe('JWT secret rules', () => {
    it('errors in production when the secret is the default placeholder', () => {
      const cfg = makeConfig(c => {
        c.security.jwt.secret = 'your-secret-key-change-in-production';
        c.database.mongodb.uri = 'mongodb://example/db';
        c.database.redis.host = 'redis.example';
        c.services.ai.apiKey = 'sk-test';
      });

      const report = validateConfig(cfg, PROD_ENV);

      expect(report.ok).toBe(false);
      expect(report.errors.some(e => e.includes('default placeholder'))).toBe(
        true
      );
    });

    it('errors when the secret is shorter than 32 chars in production', () => {
      const cfg = makeConfig(c => {
        c.security.jwt.secret = 'short';
        c.database.mongodb.uri = 'mongodb://example/db';
        c.database.redis.host = 'redis.example';
        c.services.ai.apiKey = 'sk-test';
      });

      const report = validateConfig(cfg, PROD_ENV);

      expect(
        report.errors.some(e => e.includes('at least 32 characters'))
      ).toBe(true);
    });

    it('warns instead of errors in non-prod when the secret is too short', () => {
      const cfg = makeConfig(c => {
        c.security.jwt.secret = 'short';
      });

      const report = validateConfig(cfg, DEV_ENV);

      expect(
        report.warnings.some(w => w.includes('at least 32 characters'))
      ).toBe(true);
      expect(
        report.errors.some(e => e.includes('at least 32 characters'))
      ).toBe(false);
    });

    it('passes the secret rule with a long, non-placeholder secret', () => {
      const cfg = makeConfig(c => {
        c.security.jwt.secret = 'x'.repeat(48);
        c.database.mongodb.uri = 'mongodb://example/db';
        c.database.redis.host = 'redis.example';
        c.services.ai.apiKey = 'sk-test';
      });

      const report = validateConfig(cfg, PROD_ENV);

      expect(report.errors).not.toContain(
        expect.stringContaining('JWT_SECRET')
      );
    });
  });

  describe('MONGODB_URI rule', () => {
    it('errors when the URI is empty', () => {
      const cfg = makeConfig(c => {
        c.database.mongodb.uri = '';
      });

      const report = validateConfig(cfg, DEV_ENV);

      expect(report.errors.some(e => e.includes('MONGODB_URI'))).toBe(true);
    });

    it('errors when the URI is whitespace only', () => {
      const cfg = makeConfig(c => {
        c.database.mongodb.uri = '   ';
      });

      const report = validateConfig(cfg, DEV_ENV);

      expect(report.errors.some(e => e.includes('MONGODB_URI'))).toBe(true);
    });
  });

  describe('REDIS_HOST rule', () => {
    it('errors when redis is required but host is empty', () => {
      const cfg = makeConfig(c => {
        c.services.auth.enabled = true;
        c.database.redis.host = '';
      });

      const report = validateConfig(cfg, DEV_ENV);

      expect(report.errors.some(e => e.includes('REDIS_HOST'))).toBe(true);
    });

    it('does not error when redis-using services are disabled', () => {
      const cfg = makeConfig(c => {
        c.services.auth.enabled = false;
        c.database.redis.host = '';
      });

      const report = validateConfig(cfg, DEV_ENV);

      expect(report.errors.some(e => e.includes('REDIS_HOST'))).toBe(false);
    });
  });

  describe('numeric bounds', () => {
    it('errors when RATE_LIMIT_MAX is not positive', () => {
      const cfg = makeConfig(c => {
        c.security.rateLimit.max = 0;
      });

      const report = validateConfig(cfg, DEV_ENV);

      expect(
        report.errors.some(e => e.includes('security.rateLimit.max'))
      ).toBe(true);
    });

    it('errors when a numeric field is NaN', () => {
      const cfg = makeConfig(c => {
        c.app.port = Number.NaN;
      });

      const report = validateConfig(cfg, DEV_ENV);

      expect(report.errors.some(e => e.includes('app.port'))).toBe(true);
    });
  });

  describe('JWT expiry parsing', () => {
    it('errors on a non-parseable JWT_ACCESS_EXPIRY', () => {
      const cfg = makeConfig(c => {
        c.security.jwt.accessTokenExpiry = 'forever-and-a-day';
      });

      const report = validateConfig(cfg, DEV_ENV);

      expect(report.errors.some(e => e.includes('JWT_ACCESS_EXPIRY'))).toBe(
        true
      );
    });

    it('accepts standard time strings such as "15m" and "7d"', () => {
      const cfg = makeConfig(c => {
        c.security.jwt.accessTokenExpiry = '15m';
        c.security.jwt.refreshTokenExpiry = '7d';
      });

      const report = validateConfig(cfg, DEV_ENV);

      expect(report.errors.some(e => e.includes('JWT_ACCESS_EXPIRY'))).toBe(
        false
      );
      expect(report.errors.some(e => e.includes('JWT_REFRESH_EXPIRY'))).toBe(
        false
      );
    });
  });

  describe('CORS in production', () => {
    it('warns when origins contain "*"', () => {
      const cfg = makeConfig(c => {
        c.security.jwt.secret = 'x'.repeat(48);
        c.database.mongodb.uri = 'mongodb://example/db';
        c.database.redis.host = 'redis.example';
        c.services.ai.apiKey = 'sk-test';
        c.security.cors.enabled = true;
        c.security.cors.origins = ['*'];
      });

      const report = validateConfig(cfg, PROD_ENV);

      expect(
        report.warnings.some(w => w.includes('CORS') && w.includes('*'))
      ).toBe(true);
    });

    it('warns when origins reference localhost', () => {
      const cfg = makeConfig(c => {
        c.security.jwt.secret = 'x'.repeat(48);
        c.database.mongodb.uri = 'mongodb://example/db';
        c.database.redis.host = 'redis.example';
        c.services.ai.apiKey = 'sk-test';
        c.security.cors.enabled = true;
        c.security.cors.origins = ['http://localhost:3000'];
      });

      const report = validateConfig(cfg, PROD_ENV);

      expect(report.warnings.some(w => w.includes('localhost'))).toBe(true);
    });

    it('does not warn about cors origins outside of production', () => {
      const cfg = makeConfig(c => {
        c.security.cors.enabled = true;
        c.security.cors.origins = ['*', 'http://localhost:3000'];
      });

      const report = validateConfig(cfg, DEV_ENV);

      expect(
        report.warnings.some(w => w.includes('CORS') || w.includes('localhost'))
      ).toBe(false);
    });
  });

  describe('AI key in production', () => {
    it('errors when AI is enabled but the key is empty', () => {
      const cfg = makeConfig(c => {
        c.security.jwt.secret = 'x'.repeat(48);
        c.database.mongodb.uri = 'mongodb://example/db';
        c.database.redis.host = 'redis.example';
        c.services.ai.enabled = true;
        c.services.ai.apiKey = '';
      });

      const report = validateConfig(cfg, PROD_ENV);

      expect(report.errors.some(e => e.includes('AI_API_KEY'))).toBe(true);
    });

    it('does not error when AI is disabled', () => {
      const cfg = makeConfig(c => {
        c.security.jwt.secret = 'x'.repeat(48);
        c.database.mongodb.uri = 'mongodb://example/db';
        c.database.redis.host = 'redis.example';
        c.services.ai.enabled = false;
        c.services.ai.apiKey = '';
      });

      const report = validateConfig(cfg, PROD_ENV);

      expect(report.errors.some(e => e.includes('AI_API_KEY'))).toBe(false);
    });
  });

  describe('happy path', () => {
    it('returns ok=true with no errors when production config is fully valid', () => {
      const cfg = makeConfig(c => {
        c.security.jwt.secret = 'x'.repeat(48);
        c.security.jwt.accessTokenExpiry = '15m';
        c.security.jwt.refreshTokenExpiry = '7d';
        c.database.mongodb.uri = 'mongodb://prod.example/db';
        c.database.redis.host = 'redis.prod.example';
        c.services.ai.enabled = true;
        c.services.ai.apiKey = 'sk-prod';
        c.security.cors.enabled = true;
        c.security.cors.origins = ['https://app.example.com'];
      });

      const report = validateConfig(cfg, PROD_ENV);

      expect(report.ok).toBe(true);
      expect(report.errors).toEqual([]);
    });
  });
});
