import { sanitise, __testing } from '../../../src/services/audit/sanitiser';

describe('sanitise', () => {
  describe('header denylist', () => {
    it.each([
      'Authorization',
      'authorization',
      'Cookie',
      'cookie',
      'Set-Cookie',
      'set-cookie',
      'X-Api-Key',
      'x-api-key',
    ])('redacts header %s regardless of case', header => {
      const out = sanitise({
        method: 'GET',
        path: '/x',
        headers: { [header]: 'secret-value' },
      });
      expect(out.request.headers[header]).toBe(`<REDACTED:${header}>`);
    });

    it('preserves non-secret headers verbatim', () => {
      const out = sanitise({
        method: 'GET',
        path: '/x',
        headers: { 'user-agent': 'jest', 'x-request-id': 'abc' },
      });
      expect(out.request.headers).toEqual({
        'user-agent': 'jest',
        'x-request-id': 'abc',
      });
    });
  });

  describe('body field denylist', () => {
    it('redacts top-level fields', () => {
      const out = sanitise({
        method: 'POST',
        path: '/login',
        body: {
          username: 'alice',
          password: 'hunter2',
          mfaCode: '123456',
          token: 'tok',
        },
      });

      const body = out.request.body as Record<string, unknown>;
      expect(body['username']).toBe('alice');
      expect(body['password']).toBe('<REDACTED:password>');
      expect(body['mfaCode']).toBe('<REDACTED:mfaCode>');
      expect(body['token']).toBe('<REDACTED:token>');
    });

    it('redacts nested fields and walks arrays', () => {
      const out = sanitise({
        method: 'POST',
        path: '/x',
        body: {
          credentials: {
            username: 'alice',
            password: 'hunter2',
            session: {
              backupCode: 'abc123',
            },
          },
          extras: [
            { name: 'k1', clientSecret: 's1' },
            { name: 'k2', privateKey: 'p2' },
          ],
        },
      });

      const body = out.request.body as Record<string, unknown>;
      const creds = body['credentials'] as Record<string, unknown>;
      expect(creds['password']).toBe('<REDACTED:password>');
      expect((creds['session'] as Record<string, unknown>)['backupCode']).toBe(
        '<REDACTED:backupCode>'
      );

      const extras = body['extras'] as Array<Record<string, unknown>>;
      expect(extras[0]?.['clientSecret']).toBe('<REDACTED:clientSecret>');
      expect(extras[1]?.['privateKey']).toBe('<REDACTED:privateKey>');
    });

    it('redacts mixed-case keys', () => {
      const out = sanitise({
        method: 'POST',
        path: '/x',
        body: { Password: 'x', NewPassword: 'y', MFACode: 'z', Cert: 'c' },
      });
      const body = out.request.body as Record<string, unknown>;
      expect(body['Password']).toBe('<REDACTED:Password>');
      expect(body['NewPassword']).toBe('<REDACTED:NewPassword>');
      expect(body['MFACode']).toBe('<REDACTED:MFACode>');
      expect(body['Cert']).toBe('<REDACTED:Cert>');
    });
  });

  describe('truncation', () => {
    it('truncates oversized stringified body and adds the marker', () => {
      const big = 'A'.repeat(20_000);
      const out = sanitise(
        { method: 'POST', path: '/x', body: { blob: big } },
        undefined,
        { maxBodySize: 1024 }
      );

      expect(out.request.bodyTruncated).toBe(true);
      expect(typeof out.request.body).toBe('string');
      expect(out.request.body as string).toContain(
        __testing.TRUNCATION_MARKER_PREFIX
      );
      // Final size is bounded (under limit + marker reserve).
      const len = Buffer.byteLength(out.request.body as string);
      expect(len).toBeLessThanOrEqual(1024 + 64);
    });

    it('does not truncate at the boundary (exactly under maxBodySize)', () => {
      const just = 'X'.repeat(900);
      const out = sanitise(
        { method: 'POST', path: '/x', body: { v: just } },
        undefined,
        { maxBodySize: 2048 }
      );
      expect(out.request.bodyTruncated).toBeUndefined();
      expect((out.request.body as { v: string }).v).toBe(just);
    });
  });

  describe('shape', () => {
    it('does not mutate the input body', () => {
      const input = { password: 'p', nested: { token: 't' } };
      sanitise({ method: 'POST', path: '/x', body: input });
      expect(input.password).toBe('p');
      expect(input.nested.token).toBe('t');
    });

    it('attaches response.statusCode when res is supplied', () => {
      const out = sanitise({ method: 'GET', path: '/x' }, { statusCode: 204 });
      expect(out.response).toEqual({ statusCode: 204 });
    });

    it('omits body when input body is undefined', () => {
      const out = sanitise({ method: 'GET', path: '/x' });
      expect(out.request.body).toBeUndefined();
    });
  });
});
