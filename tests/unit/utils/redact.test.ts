import {
  redact,
  addSecretKeyPattern,
  SECRET_KEY_PATTERNS,
  SECRET_VALUE_PATTERNS,
} from '../../../src/utils/redact';
import redactDefault from '../../../src/utils/redact';

describe('redact', () => {
  // --- exact-key-name redaction --------------------------------------------

  describe('exact-key-name redaction', () => {
    it('redacts `password`', () => {
      const out = redact({ password: 'hunter2' });
      expect(out).toEqual({ password: '[REDACTED]' });
    });

    it('redacts `mfaSecret`', () => {
      const out = redact({ mfaSecret: 'JBSWY3DPEHPK3PXP' });
      expect(out).toEqual({ mfaSecret: '[REDACTED]' });
    });

    it('redacts `Authorization` case-insensitively', () => {
      const out = redact({ Authorization: 'Bearer abc.def.ghi' });
      expect(out).toEqual({ Authorization: '[REDACTED]' });
    });

    it('redacts `apiKey`', () => {
      const out = redact({ apiKey: 'super-secret-thing' });
      expect(out).toEqual({ apiKey: '[REDACTED]' });
    });

    it('redacts `passwordHash`, `mfaBackupCodes`, `backupCodes`', () => {
      const out = redact({
        passwordHash: 'argon2id$...',
        mfaBackupCodes: ['aaa', 'bbb'],
        backupCodes: ['ccc'],
      });
      expect(out).toEqual({
        passwordHash: '[REDACTED]',
        mfaBackupCodes: '[REDACTED]',
        backupCodes: '[REDACTED]',
      });
    });

    it('redacts cookie / setCookie / refreshToken / accessToken', () => {
      const out = redact({
        cookie: 'sid=xyz',
        setCookie: 'sid=xyz; HttpOnly',
        refreshToken: 'rt-1',
        accessToken: 'at-1',
      });
      expect(out).toEqual({
        cookie: '[REDACTED]',
        setCookie: '[REDACTED]',
        refreshToken: '[REDACTED]',
        accessToken: '[REDACTED]',
      });
    });
  });

  // --- suffix redaction ----------------------------------------------------

  describe('suffix redaction (env-var style)', () => {
    it('redacts `_SECRET` suffix (STRIPE_SECRET)', () => {
      const out = redact({ STRIPE_SECRET: 'sk_live_xxx' });
      expect(out).toEqual({ STRIPE_SECRET: '[REDACTED]' });
    });

    it('redacts `_KEY` suffix (OPENAI_KEY)', () => {
      const out = redact({ OPENAI_KEY: 'whatever' });
      expect(out).toEqual({ OPENAI_KEY: '[REDACTED]' });
    });

    it('redacts `_TOKEN` suffix (MY_TOKEN)', () => {
      const out = redact({ MY_TOKEN: 'whatever' });
      expect(out).toEqual({ MY_TOKEN: '[REDACTED]' });
    });

    it('does not redact unrelated keys', () => {
      const out = redact({ username: 'alice', email: 'a@b.com' });
      expect(out).toEqual({ username: 'alice', email: 'a@b.com' });
    });
  });

  // --- nested redaction ----------------------------------------------------

  describe('nested redaction', () => {
    it('redacts inside arrays of objects', () => {
      const out = redact({
        users: [
          { id: 1, password: 'p1' },
          { id: 2, password: 'p2' },
        ],
      });
      expect(out).toEqual({
        users: [
          { id: 1, password: '[REDACTED]' },
          { id: 2, password: '[REDACTED]' },
        ],
      });
    });

    it('redacts inside objects in arrays in objects', () => {
      const out = redact({
        sessions: [
          { meta: { accessToken: 'tok' }, ok: true },
        ],
      });
      expect(out).toEqual({
        sessions: [{ meta: { accessToken: '[REDACTED]' }, ok: true }],
      });
    });

    it('redacts inside Map and Set entries', () => {
      const m = new Map<string, unknown>([['password', 'pw'], ['name', 'n']]);
      const s = new Set<unknown>(['plain', { token: 't' }]);
      const out = redact({ m, s }) as { m: Map<string, unknown>; s: Set<unknown> };
      expect(out.m.get('password')).toBe('[REDACTED]');
      expect(out.m.get('name')).toBe('n');
      const setVals = Array.from(out.s.values());
      expect(setVals).toContain('plain');
      expect(setVals).toContainEqual({ token: '[REDACTED]' });
    });
  });

  // --- value-pattern redaction --------------------------------------------

  describe('value-pattern redaction', () => {
    it('redacts JWT-shaped strings even in non-secret keys', () => {
      const jwt =
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const out = redact({ note: jwt });
      expect(out).toEqual({ note: '[REDACTED]' });
    });

    it('redacts PEM blocks in non-secret keys', () => {
      const pem =
        '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg...\n-----END PRIVATE KEY-----';
      const out = redact({ blob: pem });
      expect(out).toEqual({ blob: '[REDACTED]' });
    });

    it('redacts AWS access key IDs in non-secret keys', () => {
      const out = redact({ note: 'see AKIAIOSFODNN7EXAMPLE in logs' });
      expect(out).toEqual({ note: '[REDACTED]' });
    });

    it('redacts OpenAI-style sk- keys', () => {
      const out = redact({ note: 'sk-ABCDEFGHIJKLMNOPQRSTUVWX' });
      expect(out).toEqual({ note: '[REDACTED]' });
    });

    it('redacts GitHub PATs', () => {
      const out = redact({
        note: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      });
      expect(out).toEqual({ note: '[REDACTED]' });
    });
  });

  // --- non-redaction (passthrough) ----------------------------------------

  describe('passthrough', () => {
    it('leaves ordinary strings unchanged', () => {
      const out = redact({ greeting: 'hello world' });
      expect(out).toEqual({ greeting: 'hello world' });
    });

    it('leaves numbers / booleans / null / undefined unchanged', () => {
      const out = redact({ a: 1, b: true, c: null, d: undefined });
      expect(out).toEqual({ a: 1, b: true, c: null, d: undefined });
    });

    it('clones Date but preserves time', () => {
      const d = new Date('2024-01-02T03:04:05Z');
      const out = redact({ d }) as { d: Date };
      expect(out.d).toBeInstanceOf(Date);
      expect(out.d.getTime()).toBe(d.getTime());
      expect(out.d).not.toBe(d);
    });
  });

  // --- immutability --------------------------------------------------------

  describe('immutability', () => {
    it('does not mutate the input', () => {
      const input = {
        username: 'alice',
        password: 'hunter2',
        nested: {
          accessToken: 'tok',
          tags: ['a', 'b'],
        },
      };
      const snapshot = JSON.parse(JSON.stringify(input));
      const out = redact(input);
      expect(input).toEqual(snapshot);
      // And the output is a different object.
      expect(out).not.toBe(input);
      expect((out as typeof input).nested).not.toBe(input.nested);
      expect((out as typeof input).nested.tags).not.toBe(input.nested.tags);
    });
  });

  // --- cycle safety --------------------------------------------------------

  describe('cycle safety', () => {
    it('does not infinite-loop on self-referencing objects', () => {
      const a: Record<string, unknown> = { name: 'a' };
      a.self = a;
      const out = redact(a) as Record<string, unknown>;
      expect(out.name).toBe('a');
      expect(out.self).toBe('[Circular]');
    });

    it('handles cycles via arrays', () => {
      const arr: unknown[] = [1, 2];
      arr.push(arr);
      const out = redact({ arr }) as { arr: unknown[] };
      expect(out.arr[0]).toBe(1);
      expect(out.arr[1]).toBe(2);
      expect(out.arr[2]).toBe('[Circular]');
    });
  });

  // --- depth cap -----------------------------------------------------------

  describe('depth cap', () => {
    it('stringifies/truncates deeper structures rather than recursing forever', () => {
      // Build a chain deeper than the default depth.
      type Node = { next?: Node; password?: string; label: string };
      const root: Node = { label: 'L0' };
      let cur: Node = root;
      for (let i = 1; i < 50; i++) {
        const child: Node = { label: `L${i}` };
        cur.next = child;
        cur = child;
      }
      // Should not throw / hang.
      const out = redact(root, { depth: 3 });
      expect(out).toBeDefined();
      // Walk down to the depth cap.
      // depth=3 => root(0) -> next(1) -> next(2) -> next(3) is OK,
      // anything at depth 4 should be a string fallback.
      // We only assert that the deep portion is a string and not a Node.
      let node: any = out;
      for (let i = 0; i < 4 && node && typeof node === 'object'; i++) {
        node = node.next;
      }
      expect(typeof node === 'string' || node === undefined).toBe(true);
    });

    it('truncates very long stringified fallbacks for objects past the depth cap', () => {
      // An object whose toString produces a very long string. Wrap it inside
      // a parent so it sits at depth 1 > maxDepth 0 and hits the fallback.
      const big = {
        toString() {
          return 'y'.repeat(10_000);
        },
      };
      const out = redact({ payload: big }, { depth: 0 }) as Record<string, unknown>;
      expect(typeof out.payload).toBe('string');
      expect((out.payload as string).length).toBeLessThanOrEqual(260);
      expect((out.payload as string).endsWith('...')).toBe(true);
    });
  });

  // --- Buffer handling -----------------------------------------------------

  describe('Buffer handling', () => {
    it('replaces Buffer with the mask (does not keep raw bytes)', () => {
      const buf = Buffer.from('top secret bytes', 'utf8');
      const out = redact({ payload: buf }) as { payload: unknown };
      expect(out.payload).toBe('[REDACTED]');
      expect(Buffer.isBuffer(out.payload)).toBe(false);
    });

    it('replaces Buffer at top level', () => {
      const buf = Buffer.from([1, 2, 3]);
      const out = redact(buf as unknown as { x: number });
      expect(out as unknown).toBe('[REDACTED]');
    });
  });

  // --- runtime extension ---------------------------------------------------

  describe('addSecretKeyPattern', () => {
    it('extends the deny-list and changes behaviour', () => {
      const before = redact({ customField: 'visible' });
      expect(before).toEqual({ customField: 'visible' });

      addSecretKeyPattern(/^customField$/i);
      try {
        const after = redact({ customField: 'visible' });
        expect(after).toEqual({ customField: '[REDACTED]' });
      } finally {
        // Clean up so other tests aren't polluted.
        const idx = SECRET_KEY_PATTERNS.findIndex(
          (p) => p.source === '^customField$' && p.flags.includes('i')
        );
        if (idx >= 0) SECRET_KEY_PATTERNS.splice(idx, 1);
      }
    });
  });

  // --- exports -------------------------------------------------------------

  describe('exports', () => {
    it('exports redact as both named and default', () => {
      expect(typeof redact).toBe('function');
      expect(redactDefault).toBe(redact);
    });

    it('exposes the pattern arrays', () => {
      expect(Array.isArray(SECRET_KEY_PATTERNS)).toBe(true);
      expect(Array.isArray(SECRET_VALUE_PATTERNS)).toBe(true);
      expect(SECRET_KEY_PATTERNS.length).toBeGreaterThan(0);
      expect(SECRET_VALUE_PATTERNS.length).toBeGreaterThan(0);
    });
  });

  // --- custom mask ---------------------------------------------------------

  describe('custom mask', () => {
    it('uses a custom mask string when provided', () => {
      const out = redact({ password: 'pw' }, { mask: '***' });
      expect(out).toEqual({ password: '***' });
    });
  });
});
