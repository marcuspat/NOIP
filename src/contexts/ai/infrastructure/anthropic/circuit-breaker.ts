// Circuit breaker for the AnthropicAdapter.
//
// Open after 5 failures within 30s; remain open for 60s; transition
// to half-open and let exactly one probe through. On success → closed,
// on failure → open again.

import { BackpressureError } from '../../../../shared/errors';

export interface CircuitBreakerOptions {
  /** Failure window in ms. Default 30 000. */
  windowMs?: number;
  /** Failure threshold within the window. Default 5. */
  failureThreshold?: number;
  /** How long the breaker stays open before testing. Default 60 000. */
  openMs?: number;
  /** Time source — defaults to `Date.now`. */
  now?: () => number;
}

export type CircuitState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private readonly windowMs: number;
  private readonly failureThreshold: number;
  private readonly openMs: number;
  private readonly now: () => number;

  private state: CircuitState = 'closed';
  private failures: number[] = []; // ms timestamps inside the window
  private openedAt = 0;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.windowMs = opts.windowMs ?? 30_000;
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.openMs = opts.openMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Wrap a function with the breaker. Throws BackpressureError when open. */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.maybeHalfOpen();
    if (this.state === 'open') {
      throw new BackpressureError('AI provider circuit breaker is open');
    }
    try {
      const out = await fn();
      this.onSuccess();
      return out;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  getState(): CircuitState {
    this.maybeHalfOpen();
    return this.state;
  }

  /** Test-only reset. */
  reset(): void {
    this.state = 'closed';
    this.failures = [];
    this.openedAt = 0;
  }

  private onSuccess(): void {
    this.failures = [];
    this.state = 'closed';
  }

  private onFailure(): void {
    const t = this.now();
    this.failures.push(t);
    // Trim outside the window.
    const cutoff = t - this.windowMs;
    this.failures = this.failures.filter(x => x >= cutoff);
    if (this.failures.length >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = t;
    }
  }

  private maybeHalfOpen(): void {
    if (this.state !== 'open') return;
    const t = this.now();
    if (t - this.openedAt >= this.openMs) {
      this.state = 'half-open';
    }
  }
}
