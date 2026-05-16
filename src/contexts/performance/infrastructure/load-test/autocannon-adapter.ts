// AutocannonAdapter — wraps the `autocannon` package as a NOIP
// `LoadTestEngine`. The dependency is loaded lazily via `require`
// because we do NOT pin it as a top-level runtime dep (per the
// performance context constraints); in environments where autocannon
// is not installed the adapter degrades to a deterministic stub that
// returns an `emptyLoadTestSummary` with the configured RPS as a
// placeholder. Tests rely on the stub fallback so they never depend
// on the package being installed.

import { NotConfiguredError, ProviderError } from '../../../../shared/errors';
import type {
  LoadTestEngine,
  LoadTestRunRequest,
} from '../../domain/ports/load-test-engine';
import {
  emptyLoadTestSummary,
  type LoadTestSummary,
} from '../../domain/value-objects';

interface AutocannonResultLike {
  requests?: { total?: number; average?: number };
  errors?: number;
  timeouts?: number;
  non2xx?: number;
  latency?: { p50?: number; p95?: number; p99?: number };
  duration?: number;
}

type AutocannonFn = (opts: {
  url: string;
  connections: number;
  duration: number;
  amount?: number;
}) => Promise<AutocannonResultLike>;

export interface AutocannonAdapterOpts {
  /** Force-disable real autocannon; always use the stub. */
  forceStub?: boolean;
  /** Test-time override of the `require` resolver. */
  loader?: () => AutocannonFn | null;
}

const DEFAULT_LOADER: () => AutocannonFn | null = () => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('autocannon') as
      | AutocannonFn
      | { default: AutocannonFn };
    return typeof mod === 'function'
      ? mod
      : ((mod as { default: AutocannonFn }).default ?? null);
  } catch {
    return null;
  }
};

export class AutocannonAdapter implements LoadTestEngine {
  readonly id = 'autocannon';
  private readonly loader: () => AutocannonFn | null;
  private readonly forceStub: boolean;

  constructor(opts: AutocannonAdapterOpts = {}) {
    this.loader = opts.loader ?? DEFAULT_LOADER;
    this.forceStub = opts.forceStub === true;
  }

  async run(req: LoadTestRunRequest): Promise<LoadTestSummary> {
    if (this.forceStub) return this.stubSummary(req);
    const fn = this.loader();
    if (!fn) {
      // Adapter is reachable in principle but the optional dep is
      // missing — surface as NOT_CONFIGURED, the composition root
      // decides whether to fall back to the stub.
      throw new NotConfiguredError(
        'autocannon package not installed; install it or use the stub fallback',
        { engine: 'autocannon' }
      );
    }
    try {
      const result = await fn({
        url: req.target,
        connections: Math.max(1, req.profile.vus || 1),
        duration: req.profile.durationSec,
      });
      return normalize(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ProviderError(`autocannon run failed: ${msg}`, {
        engine: 'autocannon',
      });
    }
  }

  /** Public for the composition root that wants an explicit stub. */
  stubSummary(req: LoadTestRunRequest): LoadTestSummary {
    const total = Math.max(
      0,
      Math.round(req.profile.rps * req.profile.durationSec)
    );
    return {
      ...emptyLoadTestSummary(),
      totalRequests: total,
      successfulRequests: total,
      rps: req.profile.rps,
      raw: { engine: 'autocannon-stub' },
    };
  }
}

function normalize(r: AutocannonResultLike): LoadTestSummary {
  const total = r.requests?.total ?? 0;
  const errors = (r.errors ?? 0) + (r.timeouts ?? 0) + (r.non2xx ?? 0);
  const ok = Math.max(0, total - errors);
  const duration = r.duration ?? 0;
  return {
    totalRequests: total,
    successfulRequests: ok,
    failedRequests: errors,
    errorRate: total === 0 ? 0 : errors / total,
    rps: r.requests?.average ?? (duration === 0 ? 0 : total / duration),
    p50Ms: r.latency?.p50 ?? 0,
    p95Ms: r.latency?.p95 ?? 0,
    p99Ms: r.latency?.p99 ?? 0,
    raw: r as unknown as Record<string, unknown>,
  };
}
