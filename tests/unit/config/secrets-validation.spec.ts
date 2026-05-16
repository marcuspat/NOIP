// Unit tests for the ADR-0025 hardening rules in `validateConfig`.
//
// These exercise the new production-only checks layered on top of the
// existing ADR-0019 validation: placeholder JWT_SECRET rejection,
// localhost MongoDB rejection, and `JWT_PRIOR_KIDS` malformed-input
// detection. The existing happy-path tests live in
// `tests/unit/config-validation.spec.ts`; we deliberately scope this
// suite to the new rules so a regression here is easy to localise.

import { config } from '../../../src/config';
import { validateConfig } from '../../../src/config/validation';

type Cfg = typeof config;

/**
 * Deep-clone the real config so each test starts from a known-good
 * baseline that the `overrides` callback can mutate without bleeding
 * into siblings.
 */
function makeConfig(overrides: (cfg: Cfg) => void = () => undefined): Cfg {
  const clone = JSON.parse(JSON.stringify(config)) as Cfg;
  clone.security.jwt.algorithm = 'HS256';
  // Default to known-good values that pass every rule except whatever
  // the individual test mutates. Mirrors the happy-path fixture in
  // the legacy validation spec so test failures attribute cleanly.
  clone.security.jwt.secret = 'x'.repeat(48);
  clone.security.jwt.accessTokenExpiry = '15m';
  clone.security.jwt.refreshTokenExpiry = '7d';
  clone.database.mongodb.uri = 'mongodb://prod.example/db';
  clone.database.redis.host = 'redis.prod.example';
  clone.services.ai.enabled = true;
  clone.services.ai.apiKey = 'sk-prod';
  overrides(clone);
  return clone;
}

const PROD_ENV: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
const DEV_ENV: NodeJS.ProcessEnv = { NODE_ENV: 'development' };

describe('ADR-0025 — production secret hardening', () => {
  describe('placeholder JWT_SECRET', () => {
    it('rejects the exact placeholder string in production', () => {
      const cfg = makeConfig(c => {
        c.security.jwt.secret = 'your-secret-key-change-in-production';
      });
      const report = validateConfig(cfg, PROD_ENV);
      expect(report.ok).toBe(false);
      expect(report.errors.some(e => e.includes('default placeholder'))).toBe(
        true
      );
    });

    it('rejects a case-tweaked placeholder in production (case-insensitive match)', () => {
      const cfg = makeConfig(c => {
        c.security.jwt.secret = 'YOUR-SECRET-KEY-CHANGE-IN-PRODUCTION';
      });
      const report = validateConfig(cfg, PROD_ENV);
      expect(report.errors.some(e => e.includes('default placeholder'))).toBe(
        true
      );
    });

    it('allows the placeholder string in development', () => {
      const cfg = makeConfig(c => {
        c.security.jwt.secret = 'your-secret-key-change-in-production';
      });
      const report = validateConfig(cfg, DEV_ENV);
      expect(report.errors.some(e => e.includes('default placeholder'))).toBe(
        false
      );
    });

    it('rejects a sub-32-char JWT_SECRET in production', () => {
      const cfg = makeConfig(c => {
        c.security.jwt.secret = 'short-secret';
      });
      const report = validateConfig(cfg, PROD_ENV);
      expect(
        report.errors.some(e => e.includes('at least 32 characters'))
      ).toBe(true);
    });

    it('demotes a sub-32-char JWT_SECRET to a warning in development', () => {
      const cfg = makeConfig(c => {
        c.security.jwt.secret = 'short';
      });
      const report = validateConfig(cfg, DEV_ENV);
      expect(
        report.errors.some(e => e.includes('at least 32 characters'))
      ).toBe(false);
      expect(
        report.warnings.some(w => w.includes('at least 32 characters'))
      ).toBe(true);
    });
  });

  describe('MONGODB_URI localhost rejection', () => {
    it('rejects mongodb://localhost in production', () => {
      const cfg = makeConfig(c => {
        c.database.mongodb.uri = 'mongodb://localhost:27017/noip';
      });
      const report = validateConfig(cfg, PROD_ENV);
      expect(report.ok).toBe(false);
      expect(
        report.errors.some(
          e => e.includes('MONGODB_URI') && e.includes('localhost')
        )
      ).toBe(true);
    });

    it('rejects mongodb://127.0.0.1 in production', () => {
      const cfg = makeConfig(c => {
        c.database.mongodb.uri = 'mongodb://127.0.0.1:27017/noip';
      });
      const report = validateConfig(cfg, PROD_ENV);
      expect(
        report.errors.some(
          e => e.includes('localhost') || e.includes('loopback')
        )
      ).toBe(true);
    });

    it('rejects mongodb://user:pass@localhost in production', () => {
      const cfg = makeConfig(c => {
        c.database.mongodb.uri =
          'mongodb://user:pass@localhost:27017/noip?retryWrites=true';
      });
      const report = validateConfig(cfg, PROD_ENV);
      expect(
        report.errors.some(
          e => e.includes('localhost') || e.includes('loopback')
        )
      ).toBe(true);
    });

    it('allows mongodb://localhost in development', () => {
      const cfg = makeConfig(c => {
        c.database.mongodb.uri = 'mongodb://localhost:27017/noip';
      });
      const report = validateConfig(cfg, DEV_ENV);
      expect(
        report.errors.some(
          e => e.includes('localhost') || e.includes('loopback')
        )
      ).toBe(false);
    });

    it('does not spuriously flag a hostname that merely contains the substring "localhost"', () => {
      // `prod-localhost-replica` is a perfectly valid (if oddly named)
      // production host and must not match the boundary-aware regex.
      const cfg = makeConfig(c => {
        c.database.mongodb.uri = 'mongodb://prod-localhost-replica:27017/noip';
      });
      const report = validateConfig(cfg, PROD_ENV);
      expect(
        report.errors.some(
          e => e.includes('localhost') || e.includes('loopback')
        )
      ).toBe(false);
    });

    it('does not spuriously flag a database whose name contains "localhost"', () => {
      const cfg = makeConfig(c => {
        c.database.mongodb.uri = 'mongodb://prod.example:27017/test-localhost';
      });
      const report = validateConfig(cfg, PROD_ENV);
      expect(
        report.errors.some(
          e => e.includes('localhost') || e.includes('loopback')
        )
      ).toBe(false);
    });
  });

  describe('JWT_PRIOR_KIDS parsing in env', () => {
    it('accepts a well-formed JWT_PRIOR_KIDS env value', () => {
      const cfg = makeConfig();
      const report = validateConfig(cfg, {
        ...PROD_ENV,
        JWT_PRIOR_KIDS:
          'kid-old:another-secret-of-sufficient-length-for-the-rotation!,kid-older:third-secret-also-of-sufficient-length-yes!',
      });
      expect(report.errors.some(e => e.includes('JWT_PRIOR_KIDS'))).toBe(false);
    });

    it('errors in production on a malformed JWT_PRIOR_KIDS', () => {
      const cfg = makeConfig();
      const report = validateConfig(cfg, {
        ...PROD_ENV,
        JWT_PRIOR_KIDS: 'no-colon-here',
      });
      expect(report.ok).toBe(false);
      expect(report.errors.some(e => e.includes('JWT_PRIOR_KIDS'))).toBe(true);
    });

    it('warns in development on a malformed JWT_PRIOR_KIDS', () => {
      const cfg = makeConfig();
      const report = validateConfig(cfg, {
        ...DEV_ENV,
        JWT_PRIOR_KIDS: 'kid-only:',
      });
      expect(report.errors.some(e => e.includes('JWT_PRIOR_KIDS'))).toBe(false);
      expect(report.warnings.some(w => w.includes('JWT_PRIOR_KIDS'))).toBe(
        true
      );
    });

    it('ignores an empty / unset JWT_PRIOR_KIDS', () => {
      const cfg = makeConfig();
      const reportUnset = validateConfig(cfg, PROD_ENV);
      const reportEmpty = validateConfig(cfg, {
        ...PROD_ENV,
        JWT_PRIOR_KIDS: '',
      });
      expect(reportUnset.errors.some(e => e.includes('JWT_PRIOR_KIDS'))).toBe(
        false
      );
      expect(reportEmpty.errors.some(e => e.includes('JWT_PRIOR_KIDS'))).toBe(
        false
      );
    });
  });

  describe('happy-path production config', () => {
    it('passes all ADR-0025 rules with a fully valid production config', () => {
      const cfg = makeConfig();
      const report = validateConfig(cfg, {
        ...PROD_ENV,
        JWT_PRIOR_KIDS:
          'kid-old:another-secret-of-sufficient-length-for-rotation!!',
      });
      expect(report.ok).toBe(true);
      expect(report.errors).toEqual([]);
    });
  });
});
