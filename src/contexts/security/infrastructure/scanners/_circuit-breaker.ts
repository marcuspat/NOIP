// Circuit breaker — security context's local copy of the AI context's
// pattern. After `failureThreshold` failures within `windowMs` the
// breaker opens for `openMs`, then transitions to half-open and lets
// exactly one probe through. On success → closed; on failure → open.

import { BackpressureError } from '../../../../shared/errors';

export interface CircuitBreakerOptions {
  windowMs?: number;
  failureThreshold?: number;
  openMs?: number;
  now?: () => number;
  /** Identifier used in the BackpressureError message. */
  name?: string;
}

export type CircuitState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private readonly windowMs: number;
  private readonly failureThreshold: number;
  private readonly openMs: number;
  private readonly now: () => number;
  private readonly name: string;

  private state: CircuitState = 'closed';
  private failures: number[] = [];
  private openedAt = 0;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.windowMs = opts.windowMs ?? 30_000;
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.openMs = opts.openMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
    this.name = opts.name ?? 'breaker';
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.maybeHalfOpen();
    if (this.state === 'open') {
      throw new BackpressureError(`${this.name}: circuit breaker is open`);
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
