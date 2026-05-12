// Unit tests for the contract harness's availability detector.
//
// These run as part of `npm test` so the harness itself can't silently
// rot. We spin up a tiny in-process HTTP server to assert positive and
// negative paths without touching the network.

import { AddressInfo, createServer, Server } from 'node:http';
import {
  isChromaReachable,
  resolveChromaUrl,
} from '../../contract/ai/_helpers/chroma-availability';

function startServer(
  handler: (status: number) => void
): Promise<{ server: Server; url: string }> {
  return new Promise(resolve => {
    const server = createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      handler(200);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe('isChromaReachable', () => {
  it('returns true for a 200 response within the timeout', async () => {
    let observed = 0;
    const { server, url } = await startServer(() => {
      observed += 1;
    });
    try {
      const ok = await isChromaReachable(url, 2000);
      expect(ok).toBe(true);
      expect(observed).toBe(1);
    } finally {
      await new Promise<void>(r => server.close(() => r()));
    }
  });

  it('returns false for a non-2xx response', async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 503;
      res.end();
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address() as AddressInfo;
    try {
      const ok = await isChromaReachable(`http://127.0.0.1:${addr.port}`, 1500);
      expect(ok).toBe(false);
    } finally {
      await new Promise<void>(r => server.close(() => r()));
    }
  });

  it('returns false (never throws) for an unreachable URL', async () => {
    // 127.0.0.1:1 is reserved as "tcpmux" and is essentially guaranteed
    // to refuse a connection in any sane CI environment. We still rely
    // on the abort timer as a backstop.
    const ok = await isChromaReachable('http://127.0.0.1:1', 250);
    expect(ok).toBe(false);
  });

  it('returns false when the request exceeds the timeout', async () => {
    const server = createServer((_req, res) => {
      // Hang past the timeout window.
      setTimeout(() => {
        res.statusCode = 200;
        res.end();
      }, 500);
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address() as AddressInfo;
    try {
      const ok = await isChromaReachable(`http://127.0.0.1:${addr.port}`, 50);
      expect(ok).toBe(false);
    } finally {
      await new Promise<void>(r => server.close(() => r()));
    }
  });

  it('returns false for an empty / invalid URL', async () => {
    expect(await isChromaReachable('')).toBe(false);
    // @ts-expect-error — deliberately passing a non-string
    expect(await isChromaReachable(undefined)).toBe(false);
  });
});

describe('resolveChromaUrl', () => {
  const original = process.env['CHROMA_URL'];
  afterEach(() => {
    if (original === undefined) delete process.env['CHROMA_URL'];
    else process.env['CHROMA_URL'] = original;
  });

  it('returns the env var when set', () => {
    process.env['CHROMA_URL'] = 'http://chroma.test:8000';
    expect(resolveChromaUrl()).toBe('http://chroma.test:8000');
  });

  it('falls back to a localhost default', () => {
    delete process.env['CHROMA_URL'];
    expect(resolveChromaUrl()).toBe('http://localhost:8000');
  });
});
