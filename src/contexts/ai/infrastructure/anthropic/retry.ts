// Bounded retry with exponential backoff + full jitter.
//
// Used by the AnthropicAdapter for 429 / 5xx responses. Pure utility —
// the caller decides whether an error is retriable.

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
   * Sleep impl. Defaults to `setTimeout`-based promise; tests can pass
   * `() => Promise.resolve()` for sub-ms turnaround.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * RNG used for full jitter. Defaults to `Math.random`. Tests can
   * inject a deterministic generator.
   */
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
      const delay = Math.floor(rng() * exp); // full jitter
      await sleep(delay);
    }
  }
  throw lastErr;
}
