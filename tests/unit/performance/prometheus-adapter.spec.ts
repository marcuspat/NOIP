// PrometheusAdapter — verifies the HTTP API request shape, the
// scalar/vector parsing, and the per-query failure isolation.

import { PrometheusAdapter } from '../../../src/contexts/performance/infrastructure/prometheus/prometheus-adapter';

type FetchFn = typeof fetch;

function fakeFetch(
  impl: (url: string) => Response | Promise<Response>
): FetchFn {
  return (async input => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    return impl(url);
  }) as FetchFn;
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('PrometheusAdapter', () => {
  it('builds the canonical /api/v1/query URL', async () => {
    const urls: string[] = [];
    const adapter = new PrometheusAdapter({
      baseUrl: 'http://prom:9090/',
      fetchImpl: fakeFetch(url => {
        urls.push(url);
        return ok({
          status: 'success',
          data: { resultType: 'scalar', result: [0, '1'] },
        });
      }),
    });
    await adapter.queryBatch([{ query: 'up' }]);
    expect(urls[0]).toBe('http://prom:9090/api/v1/query?query=up');
  });

  it('parses scalar results', async () => {
    const adapter = new PrometheusAdapter({
      baseUrl: 'http://prom:9090',
      fetchImpl: fakeFetch(() =>
        ok({
          status: 'success',
          data: { resultType: 'scalar', result: [123, '42.5'] },
        })
      ),
    });
    const r = await adapter.queryBatch([{ query: 'a' }]);
    expect(r[0]?.value).toBe(42.5);
  });

  it('averages vector results', async () => {
    const adapter = new PrometheusAdapter({
      baseUrl: 'http://prom:9090',
      fetchImpl: fakeFetch(() =>
        ok({
          status: 'success',
          data: {
            resultType: 'vector',
            result: [
              { value: [0, '10'] },
              { value: [0, '20'] },
              { value: [0, '30'] },
            ],
          },
        })
      ),
    });
    const r = await adapter.queryBatch([{ query: 'q' }]);
    expect(r[0]?.value).toBe(20);
  });

  it('maps non-200 responses to { value:null, error:"HTTP X" }', async () => {
    const adapter = new PrometheusAdapter({
      baseUrl: 'http://prom:9090',
      fetchImpl: fakeFetch(() => new Response('boom', { status: 503 })),
    });
    const r = await adapter.queryBatch([{ query: 'q' }]);
    expect(r[0]?.value).toBeNull();
    expect(r[0]?.error).toBe('HTTP 503');
  });

  it('isolates per-query failures inside a batch', async () => {
    let i = 0;
    const adapter = new PrometheusAdapter({
      baseUrl: 'http://prom:9090',
      fetchImpl: fakeFetch(() => {
        i++;
        if (i === 2) return new Response('nope', { status: 500 });
        return ok({
          status: 'success',
          data: { resultType: 'scalar', result: [0, String(i)] },
        });
      }),
    });
    const r = await adapter.queryBatch([
      { query: 'a' },
      { query: 'b' },
      { query: 'c' },
    ]);
    expect(r.map(x => x.value)).toEqual([1, null, 3]);
    expect(r[1]?.error).toBe('HTTP 500');
  });

  it('forwards `time` parameter when present', async () => {
    const urls: string[] = [];
    const adapter = new PrometheusAdapter({
      baseUrl: 'http://prom',
      fetchImpl: fakeFetch(u => {
        urls.push(u);
        return ok({
          status: 'success',
          data: { resultType: 'scalar', result: [0, '1'] },
        });
      }),
    });
    await adapter.queryBatch([{ query: 'q', time: '2026-01-01T00:00:00Z' }]);
    expect(urls[0]).toContain('time=2026-01-01T00%3A00%3A00Z');
  });

  it('catches fetch exceptions and reports them as errors', async () => {
    const adapter = new PrometheusAdapter({
      baseUrl: 'http://prom',
      fetchImpl: fakeFetch(() => {
        throw new Error('network down');
      }),
    });
    const r = await adapter.queryBatch([{ query: 'q' }]);
    expect(r[0]?.value).toBeNull();
    expect(r[0]?.error).toBe('network down');
  });
});
