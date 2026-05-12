// Bounded retry with exponential backoff + full jitter.
//
// Local copy of the pattern used by the AI context's anthropic-adapter.
// Per ADR-0011 we do not reach across contexts for shared utilities; if
// the pattern diverges, each context evolves independently.

export interface RetryOptions {
  /** Maximum total attempts (including the first). Default 3. */
  attempts?: number;
  /** Base delay in milliseconds. Default 200. */
  baseMs?: number;
  /** Cap on a single delay in milliseconds. Default 5000. */
  capMs?: number;
  /** Predicate; returns true if `err` is retriable. */
  retriable: (err: unknown) => boolean;
  /**
   * Sleep impl. Defaults to setTimeout-backed promise; tests inject a
   * zero-delay function for sub-ms turnaround.
   */
  sleep?: (ms: number) => Promise<void>;
  /** RNG used for full jitter. Defaults to Math.random. */
  rng?: () => number;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const base = opts.baseMs ?? 200;
  const cap = opts.capMs ?? 5000;
  const sleep =
    opts.sleep ??
    ((ms: number) =>
      new Promise<void>(r => {
        setTimeout(r, ms);
      }));
  const rng = opts.rng ?? Math.random;

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) break;
      if (!opts.retriable(err)) break;
      const exp = Math.min(cap, base * Math.pow(2, i));
      const delay = Math.floor(rng() * exp);
      await sleep(delay);
    }
  }
  throw lastErr;
}
