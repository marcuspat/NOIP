// HttpProbeAdapter — executes a single HTTP probe via Node's native
// fetch (Node 18+). Records latency, status code, and optional body
// matching. Never throws — adapter-level failures collapse to a
// `success: false` response with `failureReason` populated so the
// `ProbeRunner` can build a uniform `ProbeResult`.

import { performance } from 'perf_hooks';
import type {
  HttpProbeClient,
  HttpProbeRequest,
  HttpProbeResponse,
} from '../../domain/ports/http-probe-client';

export interface HttpProbeAdapterOpts {
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
}

export class HttpProbeAdapter implements HttpProbeClient {
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpProbeAdapterOpts = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async execute(req: HttpProbeRequest): Promise<HttpProbeResponse> {
    const t0 = performance.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), req.timeoutMs);
    try {
      const headers: Record<string, string> = req.config.headers ?? {};
      const init: RequestInit = {
        method: req.config.method ?? 'GET',
        headers,
        signal: ctl.signal,
      };
      const resp = await this.fetchImpl(req.target, init);
      const text = req.config.bodyMatcher ? await resp.text() : '';
      const latencyMs = performance.now() - t0;
      const expected = normaliseExpected(req.config.expectedStatus);
      const statusOk =
        expected.length === 0
          ? resp.status >= 200 && resp.status < 400
          : expected.includes(resp.status);
      let bodyOk = true;
      let failureReason: string | undefined;
      if (req.config.bodyMatcher) {
        bodyOk = text.includes(req.config.bodyMatcher);
        if (!bodyOk) {
          failureReason = `body did not match '${req.config.bodyMatcher}'`;
        }
      }
      if (!statusOk) {
        failureReason = `unexpected status ${resp.status}`;
      }
      const resBytes = Number(
        resp.headers.get('content-length') ?? text.length ?? 0
      );
      const measurements = {
        statusCode: resp.status,
        bytes: Number.isFinite(resBytes) ? resBytes : 0,
        ttfbMs: Math.round(latencyMs),
      };
      const out: HttpProbeResponse = {
        latencyMs: Math.round(latencyMs * 1000) / 1000,
        success: statusOk && bodyOk,
        measurements,
      };
      if (failureReason !== undefined) out.failureReason = failureReason;
      return out;
    } catch (err) {
      const latencyMs = performance.now() - t0;
      const msg = err instanceof Error ? err.message : String(err);
      const aborted = msg.includes('aborted') || /AbortError/.test(msg);
      return {
        latencyMs: Math.round(latencyMs * 1000) / 1000,
        success: false,
        failureReason: aborted
          ? `probe timed out after ${req.timeoutMs}ms`
          : msg,
        measurements: {},
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function normaliseExpected(v: number | number[] | undefined): number[] {
  if (v === undefined) return [];
  if (Array.isArray(v)) return v;
  return [v];
}
