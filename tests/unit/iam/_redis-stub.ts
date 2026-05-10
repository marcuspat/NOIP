// Map-backed Redis stub used by the IAM unit tests. Intentionally tiny:
// only the surface that `JWTManager` consumes via `RedisLike`. Exposes
// hooks (`failNext`, `getUnderlying`) that tests use to simulate transient
// Redis errors and to peek at TTL bookkeeping without going through the
// public methods.

import type { RedisLike } from '../../../src/utils/auth/jwt.manager';

interface Slot {
  value: string;
  /** Unix ms after which the slot is treated as missing. */
  expiresAt: number;
}

export class FakeRedis implements RedisLike {
  private store = new Map<string, Slot>();
  private failures: number = 0;

  /** Cause the next N operations to throw before touching the store. */
  failNext(n: number): void {
    this.failures = n;
  }

  private maybeFail(op: string): void {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error(`FakeRedis: simulated failure on ${op}`);
    }
  }

  private now(): number {
    return Date.now();
  }

  private read(key: string): string | null {
    const slot = this.store.get(key);
    if (!slot) return null;
    if (slot.expiresAt <= this.now()) {
      this.store.delete(key);
      return null;
    }
    return slot.value;
  }

  async setEx(key: string, ttlSeconds: number, value: string): Promise<void> {
    this.maybeFail('setEx');
    this.store.set(key, {
      value,
      expiresAt: this.now() + ttlSeconds * 1000,
    });
  }

  async get(key: string): Promise<string | null> {
    this.maybeFail('get');
    return this.read(key);
  }

  async mget(keys: string[]): Promise<Array<string | null>> {
    this.maybeFail('mget');
    return keys.map(k => this.read(k));
  }

  async del(...keys: string[]): Promise<void> {
    this.maybeFail('del');
    for (const k of keys) this.store.delete(k);
  }

  /** Test-only inspector: returns ttl in seconds, or -1 if missing. */
  ttl(key: string): number {
    const slot = this.store.get(key);
    if (!slot) return -1;
    return Math.ceil((slot.expiresAt - this.now()) / 1000);
  }

  /** Test-only inspector: raw value, ignoring the TTL. */
  raw(key: string): string | undefined {
    return this.store.get(key)?.value;
  }

  size(): number {
    return this.store.size;
  }
}
