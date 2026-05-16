// Unit tests for the JWT key-rotation helpers (ADR-0025).
//
// These cover the env-parsing front door (`loadJwtKeySet` /
// `parseJwtPriorKids`) and the ops minting helper (`mintJwtKey`). The
// helpers are pure — no Redis, no jose, no config. Tests pass in env
// fragments explicitly so they never depend on the ambient
// `process.env`.

import {
  loadJwtKeySet,
  mintJwtKey,
  parseJwtPriorKids,
  assertProductionJwtSecret,
} from '../../../src/utils/auth/jwt-key-rotation';

describe('parseJwtPriorKids', () => {
  it('returns an empty array for undefined input', () => {
    expect(parseJwtPriorKids(undefined)).toEqual([]);
  });

  it('returns an empty array for empty / whitespace input', () => {
    expect(parseJwtPriorKids('')).toEqual([]);
    expect(parseJwtPriorKids('   ')).toEqual([]);
  });

  it('parses a single kid:secret pair', () => {
    expect(parseJwtPriorKids('kid-old:supersecretvalue')).toEqual([
      { kid: 'kid-old', secret: 'supersecretvalue' },
    ]);
  });

  it('parses a kid1:secret1,kid2:secret2 list in order', () => {
    expect(parseJwtPriorKids('kid-a:secretA,kid-b:secretB')).toEqual([
      { kid: 'kid-a', secret: 'secretA' },
      { kid: 'kid-b', secret: 'secretB' },
    ]);
  });

  it('tolerates whitespace around tokens and the separator', () => {
    expect(parseJwtPriorKids('  kid-a : secretA , kid-b : secretB  ')).toEqual([
      { kid: 'kid-a', secret: 'secretA' },
      { kid: 'kid-b', secret: 'secretB' },
    ]);
  });

  it('rejects an entry missing the separator', () => {
    expect(() => parseJwtPriorKids('kid-without-secret')).toThrow(
      /Malformed JWT_PRIOR_KIDS entry/
    );
  });

  it('rejects an entry with an empty kid', () => {
    expect(() => parseJwtPriorKids(':only-secret')).toThrow(
      /Malformed JWT_PRIOR_KIDS entry/
    );
  });

  it('rejects an entry with an empty secret', () => {
    expect(() => parseJwtPriorKids('kid-only:')).toThrow(
      /Malformed JWT_PRIOR_KIDS entry/
    );
  });

  it('rejects duplicate kids in the same list', () => {
    expect(() => parseJwtPriorKids('kid-x:a,kid-x:b')).toThrow(/Duplicate kid/);
  });
});

describe('loadJwtKeySet', () => {
  it('returns a key set with the active kid defaulting to "kid-0"', () => {
    const set = loadJwtKeySet({
      JWT_SECRET: 'a-secret-of-sufficient-length-for-hs256-32!',
    });
    expect(set.active.kid).toBe('kid-0');
    expect(set.active.secret).toBe(
      'a-secret-of-sufficient-length-for-hs256-32!'
    );
    expect(set.prior).toEqual([]);
  });

  it('honours JWT_ACTIVE_KID when provided', () => {
    const set = loadJwtKeySet({
      JWT_SECRET: 'a-secret-of-sufficient-length-for-hs256-32!',
      JWT_ACTIVE_KID: 'kid-2026-05-16',
    });
    expect(set.active.kid).toBe('kid-2026-05-16');
  });

  it('parses JWT_PRIOR_KIDS into the prior list', () => {
    const set = loadJwtKeySet({
      JWT_SECRET: 'a-secret-of-sufficient-length-for-hs256-32!',
      JWT_ACTIVE_KID: 'kid-new',
      JWT_PRIOR_KIDS: 'kid-old:another-secret-of-sufficient-length-32!!',
    });
    expect(set.prior).toEqual([
      {
        kid: 'kid-old',
        secret: 'another-secret-of-sufficient-length-32!!',
      },
    ]);
  });

  it('throws when JWT_SECRET is missing', () => {
    expect(() => loadJwtKeySet({})).toThrow(/JWT_SECRET must be set/);
  });

  it('throws when JWT_SECRET is the empty string', () => {
    expect(() => loadJwtKeySet({ JWT_SECRET: '' })).toThrow(
      /JWT_SECRET must be set/
    );
  });

  it('throws when JWT_ACTIVE_KID is whitespace-only', () => {
    expect(() =>
      loadJwtKeySet({
        JWT_SECRET: 'a-secret-of-sufficient-length-for-hs256-32!',
        JWT_ACTIVE_KID: '   ',
      })
    ).toThrow(/JWT_ACTIVE_KID must be non-empty/);
  });

  it('throws when JWT_PRIOR_KIDS contains the active kid', () => {
    expect(() =>
      loadJwtKeySet({
        JWT_SECRET: 'a-secret-of-sufficient-length-for-hs256-32!',
        JWT_ACTIVE_KID: 'kid-new',
        JWT_PRIOR_KIDS: 'kid-new:something-else-32-chars-long-stuff!!',
      })
    ).toThrow(/contains the active kid/);
  });

  it('propagates parser errors when JWT_PRIOR_KIDS is malformed', () => {
    expect(() =>
      loadJwtKeySet({
        JWT_SECRET: 'a-secret-of-sufficient-length-for-hs256-32!',
        JWT_PRIOR_KIDS: 'no-colon-here',
      })
    ).toThrow(/Malformed JWT_PRIOR_KIDS entry/);
  });
});

describe('mintJwtKey', () => {
  it('produces a kid embedding the unix-seconds timestamp', () => {
    const now = new Date('2026-05-16T12:00:00Z');
    const { kid } = mintJwtKey(now);
    const expectedSec = Math.floor(now.getTime() / 1000);
    expect(kid).toBe(`kid-${expectedSec}`);
  });

  it('returns a secret of at least 32 characters', () => {
    const { secret } = mintJwtKey(new Date());
    expect(secret.length).toBeGreaterThanOrEqual(32);
  });

  it('returns URL-safe base64 (no +, /, or = padding)', () => {
    const { secret } = mintJwtKey(new Date());
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('orders kids lexicographically by minted time', () => {
    const earlier = mintJwtKey(new Date('2025-01-01T00:00:00Z'));
    const later = mintJwtKey(new Date('2026-01-01T00:00:00Z'));
    expect(earlier.kid < later.kid).toBe(true);
  });

  it('rejects an invalid Date argument', () => {
    expect(() => mintJwtKey(new Date('not-a-date'))).toThrow(/valid Date/);
    expect(() => mintJwtKey(undefined as unknown as Date)).toThrow(
      /valid Date/
    );
  });

  it('generates fresh randomness on each call', () => {
    const a = mintJwtKey(new Date('2026-05-16T12:00:00Z'));
    const b = mintJwtKey(new Date('2026-05-16T12:00:00Z'));
    // Same kid (same timestamp) is acceptable — what must differ is
    // the secret. Two consecutive `randomBytes(32)` calls colliding
    // would be a critical CSPRNG bug.
    expect(a.secret).not.toBe(b.secret);
  });
});

describe('assertProductionJwtSecret', () => {
  it('returns the secret unchanged outside production', () => {
    expect(assertProductionJwtSecret('short', false)).toBe('short');
  });

  it('throws on the placeholder in production', () => {
    expect(() =>
      assertProductionJwtSecret('your-secret-key-change-in-production', true)
    ).toThrow(/placeholder/);
  });

  it('throws on a too-short secret in production', () => {
    expect(() => assertProductionJwtSecret('only-short', true)).toThrow(
      /at least 32 characters/
    );
  });

  it('returns the secret unchanged when production rules pass', () => {
    const good = 'a'.repeat(48);
    expect(assertProductionJwtSecret(good, true)).toBe(good);
  });
});
