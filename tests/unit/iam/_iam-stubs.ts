// Shared stubs for the wave-2 IAM authorisation tests.
//
// These build on `_redis-stub.ts` (added in wave 1 for the JWT specs); the
// `RedisLike` shape there is too narrow for the permission cache, so this
// module exports a separate map-backed stub that satisfies
// `PermissionCacheRedis`.

import type { PermissionCacheRedis } from '../../../src/services/iam/permission-cache';
import type {
  RoleRepository,
  PermissionRepository,
  RoleSpec,
  PermissionSpec,
} from '../../../src/services/iam/permission-resolver.service';

/** Logger that records every call, mirroring `audit/_stubs#CapturingLogger`. */
export class CapturingLogger {
  public readonly events: Array<{
    level: 'info' | 'warn' | 'error';
    message: string;
    meta?: Record<string, unknown>;
  }> = [];

  info(message: string, meta?: Record<string, unknown>): void {
    this.events.push(
      meta !== undefined
        ? { level: 'info', message, meta }
        : { level: 'info', message }
    );
  }
  warn(message: string, meta?: Record<string, unknown>): void {
    this.events.push(
      meta !== undefined
        ? { level: 'warn', message, meta }
        : { level: 'warn', message }
    );
  }
  error(message: string, meta?: Record<string, unknown>): void {
    this.events.push(
      meta !== undefined
        ? { level: 'error', message, meta }
        : { level: 'error', message }
    );
  }
}

/**
 * Map-backed Redis stub satisfying `PermissionCacheRedis`. Supports
 * `failNext(n)` to simulate transient errors on the next N operations.
 */
export class FakeCacheRedis implements PermissionCacheRedis {
  private readonly store = new Map<
    string,
    { value: string; expiresAt: number }
  >();
  private failures = 0;

  failNext(n: number): void {
    this.failures = n;
  }

  /** Test inspector. */
  size(): number {
    this.purge();
    return this.store.size;
  }

  /** Test inspector. */
  has(key: string): boolean {
    this.purge();
    return this.store.has(key);
  }

  /** Test inspector. */
  rawValue(key: string): string | undefined {
    this.purge();
    return this.store.get(key)?.value;
  }

  private purge(): void {
    const now = Date.now();
    for (const [k, v] of this.store) {
      if (v.expiresAt <= now) this.store.delete(k);
    }
  }

  private maybeFail(op: string): void {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error(`FakeCacheRedis: simulated failure on ${op}`);
    }
  }

  async get(key: string): Promise<string | null> {
    this.maybeFail('get');
    this.purge();
    return this.store.get(key)?.value ?? null;
  }

  async setex(key: string, ttlSec: number, value: string): Promise<unknown> {
    this.maybeFail('setex');
    this.store.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
    return 'OK';
  }

  async set(key: string, value: string): Promise<unknown> {
    this.maybeFail('set');
    this.store.set(key, { value, expiresAt: Number.MAX_SAFE_INTEGER });
    return 'OK';
  }

  async del(...keys: string[]): Promise<unknown> {
    this.maybeFail('del');
    let removed = 0;
    for (const k of keys) {
      if (this.store.delete(k)) removed += 1;
    }
    return removed;
  }

  async scan(
    cursor: string,
    _matchKeyword: 'MATCH',
    pattern: string,
    _countKeyword: 'COUNT',
    count: number
  ): Promise<[string, string[]]> {
    this.maybeFail('scan');
    this.purge();
    const start = Number(cursor) || 0;
    const allKeys = Array.from(this.store.keys()).filter(k =>
      matchesGlob(pattern, k)
    );
    const slice = allKeys.slice(start, start + count);
    const next = start + count >= allKeys.length ? '0' : String(start + count);
    return [next, slice];
  }
}

function matchesGlob(pattern: string, key: string): boolean {
  // Tiny `*`-only glob — sufficient for our `noip:cache:perm:*` use.
  if (!pattern.includes('*')) return pattern === key;
  const escaped = pattern
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`).test(key);
}

/**
 * In-memory `RoleRepository` for resolver tests. Records every batch
 * load so the optimisation tests can assert "exactly one round trip".
 */
export class FakeRoleRepository implements RoleRepository {
  public readonly findCalls: ReadonlyArray<string>[] = [];
  private readonly roles = new Map<string, RoleSpec>();

  add(spec: RoleSpec): void {
    this.roles.set(spec.id, spec);
  }

  async findByIds(
    ids: ReadonlyArray<string>
  ): Promise<ReadonlyArray<RoleSpec>> {
    this.findCalls.push([...ids]);
    const out: RoleSpec[] = [];
    for (const id of ids) {
      const role = this.roles.get(id);
      if (role) out.push(role);
    }
    return out;
  }
}

export class FakePermissionRepository implements PermissionRepository {
  public readonly findCalls: ReadonlyArray<string>[] = [];
  private readonly perms = new Map<string, PermissionSpec>();

  add(spec: PermissionSpec): void {
    this.perms.set(spec.id, spec);
  }

  async findByIds(
    ids: ReadonlyArray<string>
  ): Promise<ReadonlyArray<PermissionSpec>> {
    this.findCalls.push([...ids]);
    const out: PermissionSpec[] = [];
    for (const id of ids) {
      const p = this.perms.get(id);
      if (p) out.push(p);
    }
    return out;
  }
}
