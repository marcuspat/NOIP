// Bounded retry helper used by the KubernetesAdapter (DDD-16).
//
// Policy (ADR-0011 conformist with the Anthropic adapter):
//   - 3 attempts total on `429` and `5xx`.
//   - Exponential backoff: 100ms, 200ms, 400ms — with **full jitter**.
//   - Anything else (semantic 4xx, programmer error) is rethrown
//     immediately.

import { ProviderError, BackpressureError } from '../../../../shared/errors';

export interface RetryDeps {
  /** Sleep function — injected so tests can run without real timers. */
  sleep?: (ms: number) => Promise<void>;
  /** PRNG returning a value in `[0, 1)`. */
  random?: () => number;
  /** Structured logger. Optional — defaults to silence. */
  logger?: {
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Inspects an error to decide retryability. Treats common shapes:
 *   - `{ statusCode: number }` (kube-client throws these)
 *   - `{ response: { statusCode: number } }`
 *   - `{ code: 'ECONNRESET' | 'ETIMEDOUT' | 'EAI_AGAIN' }`
 */
export function isRetryable(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as {
    statusCode?: number;
    code?: string;
    response?: { statusCode?: number };
  };
  const status = e.statusCode ?? e.response?.statusCode;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500 && status < 600) return true;
  if (
    e.code === 'ECONNRESET' ||
    e.code === 'ETIMEDOUT' ||
    e.code === 'EAI_AGAIN' ||
    e.code === 'ENOTFOUND' ||
    e.code === 'ECONNREFUSED'
  ) {
    return true;
  }
  return false;
}

/**
 * Maps a kube-client error onto a typed domain error after retries
 * have exhausted. The caller catches `BackpressureError` /
 * `ProviderError` etc. and surfaces them through the application
 * service.
 */
export function translateError(err: unknown, op: string): Error {
  if (typeof err !== 'object' || err === null) {
    return new ProviderError(`kubernetes ${op} failed`, {
      original: String(err),
    });
  }
  const e = err as {
    statusCode?: number;
    code?: string;
    message?: string;
    response?: { statusCode?: number };
    body?: unknown;
  };
  const status = e.statusCode ?? e.response?.statusCode;
  const detail: Record<string, unknown> = {};
  if (status !== undefined) detail['statusCode'] = status;
  if (e.code !== undefined) detail['code'] = e.code;
  if (e.message !== undefined) detail['original'] = e.message;
  if (status === 429 || (typeof status === 'number' && status >= 500)) {
    return new BackpressureError(`kubernetes ${op} unavailable`, detail);
  }
  return new ProviderError(`kubernetes ${op} failed`, detail);
}

const BASE_DELAYS = [100, 200, 400] as const;

/**
 * Runs `op` with up to 3 attempts. Successful invocations return their
 * value; on retry exhaustion the underlying error is translated to a
 * typed domain error and rethrown.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opName: string,
  deps: RetryDeps = {}
): Promise<T> {
  const sleep = deps.sleep ?? defaultSleep;
  const rnd = deps.random ?? Math.random;
  let lastErr: unknown;
  for (let attempt = 0; attempt < BASE_DELAYS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) {
        throw translateError(err, opName);
      }
      const baseDelay = BASE_DELAYS[attempt]!;
      // Full jitter: random in [0, baseDelay].
      const jittered = Math.floor(rnd() * baseDelay);
      deps.logger?.warn('kubernetes retry', {
        op: opName,
        attempt: attempt + 1,
        delayMs: jittered,
        error: err instanceof Error ? err.message : String(err),
      });
      // Last attempt: don't sleep, fall through to translate+throw.
      if (attempt < BASE_DELAYS.length - 1) {
        await sleep(jittered);
      }
    }
  }
  throw translateError(lastErr, opName);
}
