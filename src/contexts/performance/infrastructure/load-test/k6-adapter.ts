// K6Adapter — wraps the `k6` CLI as a NOIP `LoadTestEngine`. We spawn
// `k6 run --summary-export=...` and parse the JSON summary. The
// child-process module is loaded lazily so a missing `child_process`
// (extremely rare, but possible in sandboxed runtimes) collapses to
// the stub fallback rather than crashing the adapter.
//
// As with the autocannon adapter we do NOT pin k6 as a runtime dep:
// the binary must be on PATH for the real run. When it is missing
// the adapter throws `NotConfiguredError` and the composition root
// can fall back to the stub.

import { NotConfiguredError, ProviderError } from '../../../../shared/errors';
import type {
  LoadTestEngine,
  LoadTestRunRequest,
} from '../../domain/ports/load-test-engine';
import {
  emptyLoadTestSummary,
  type LoadTestSummary,
} from '../../domain/value-objects';

export interface K6SpawnOpts {
  cmd: string;
  args: string[];
  /** Optional inline stdin (k6 reads scripts from stdin when passed `-`). */
  stdin?: string;
}

export interface K6SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type K6Spawner = (opts: K6SpawnOpts) => Promise<K6SpawnResult>;

export interface K6AdapterOpts {
  /** Force-disable the real binary; always use the stub summary. */
  forceStub?: boolean;
  /**
   * Spawn override used by tests. Returns a fake k6 invocation result.
   * When absent the adapter resolves a default spawner via
   * `child_process.spawn`.
   */
  spawner?: K6Spawner;
  /** Path to the k6 binary. Defaults to `k6` (on PATH). */
  bin?: string;
}

interface K6SummaryLike {
  metrics?: {
    http_reqs?: { count?: number; rate?: number };
    http_req_failed?: { passes?: number; fails?: number; rate?: number };
    http_req_duration?: {
      'p(50)'?: number;
      'p(95)'?: number;
      'p(99)'?: number;
    };
  };
}

const DEFAULT_SPAWNER: K6Spawner = async opts => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cp = require('child_process') as typeof import('child_process');
  return new Promise((resolve, reject) => {
    const child = cp.spawn(opts.cmd, opts.args, { stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
    child.on('error', err => reject(err));
    child.on('close', (code: number) =>
      resolve({ exitCode: code ?? 0, stdout, stderr })
    );
    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
  });
};

export class K6Adapter implements LoadTestEngine {
  readonly id = 'k6';
  private readonly spawner: K6Spawner;
  private readonly forceStub: boolean;
  private readonly bin: string;

  constructor(opts: K6AdapterOpts = {}) {
    this.spawner = opts.spawner ?? DEFAULT_SPAWNER;
    this.forceStub = opts.forceStub === true;
    this.bin = opts.bin ?? 'k6';
  }

  async run(req: LoadTestRunRequest): Promise<LoadTestSummary> {
    if (this.forceStub) return this.stubSummary(req);
    let result: K6SpawnResult;
    try {
      result = await this.spawner({
        cmd: this.bin,
        args: ['run', '--summary-export', '-', '-'],
        stdin: req.script,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // ENOENT — k6 not on PATH.
      if (/ENOENT/i.test(msg)) {
        throw new NotConfiguredError(`k6 binary not found: ${this.bin}`, {
          engine: 'k6',
        });
      }
      throw new ProviderError(`k6 spawn failed: ${msg}`, { engine: 'k6' });
    }
    if (result.exitCode !== 0) {
      throw new ProviderError(
        `k6 exited ${result.exitCode}: ${result.stderr}`,
        {
          engine: 'k6',
        }
      );
    }
    let parsed: K6SummaryLike;
    try {
      parsed = JSON.parse(result.stdout) as K6SummaryLike;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ProviderError(`k6 summary parse failed: ${msg}`, {
        engine: 'k6',
      });
    }
    return normalize(parsed, req);
  }

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
      raw: { engine: 'k6-stub' },
    };
  }
}

function normalize(s: K6SummaryLike, req: LoadTestRunRequest): LoadTestSummary {
  const total = s.metrics?.http_reqs?.count ?? 0;
  const failedRate = s.metrics?.http_req_failed?.rate ?? 0;
  const failed = Math.round(total * failedRate);
  return {
    totalRequests: total,
    successfulRequests: Math.max(0, total - failed),
    failedRequests: failed,
    errorRate: failedRate,
    rps:
      s.metrics?.http_reqs?.rate ??
      (req.profile.durationSec === 0 ? 0 : total / req.profile.durationSec),
    p50Ms: s.metrics?.http_req_duration?.['p(50)'] ?? 0,
    p95Ms: s.metrics?.http_req_duration?.['p(95)'] ?? 0,
    p99Ms: s.metrics?.http_req_duration?.['p(99)'] ?? 0,
    raw: s as unknown as Record<string, unknown>,
  };
}
