// Scoring service — thin wrapper around `PostureScorer` that adds a
// Redis-backed cache (60s TTL, invalidated by
// `security.scan.completed`). The cache is optional; when no Redis
// is configured the service falls back to an in-memory map.

import type { ClusterId, EventBus, Unsubscribe } from '../../../shared/kernel';
import {
  PostureScorer,
  type PostureScoreResult,
  type ScorableFinding,
} from '../domain/posture-scorer';

export interface ScoreCache {
  get(key: string): Promise<string | null>;
  setex(key: string, ttlSec: number, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

/**
 * Minimal in-memory cache. Suitable for tests and single-pod
 * deployments where Redis is unavailable.
 */
export class InMemoryScoreCache implements ScoreCache {
  private readonly entries = new Map<
    string,
    { value: string; expiresAt: number }
  >();
  async get(key: string): Promise<string | null> {
    const e = this.entries.get(key);
    if (!e) return null;
    if (e.expiresAt < Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return e.value;
  }
  async setex(key: string, ttlSec: number, value: string): Promise<void> {
    this.entries.set(key, {
      value,
      expiresAt: Date.now() + ttlSec * 1000,
    });
  }
  async del(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

export interface ScoringServiceDeps {
  cache?: ScoreCache;
  scorer?: PostureScorer;
  ttlSec?: number;
}

const KEY_PREFIX = 'noip:cache:score:';

export class ScoringService {
  private readonly cache: ScoreCache;
  private readonly scorer: PostureScorer;
  private readonly ttlSec: number;

  constructor(deps: ScoringServiceDeps = {}) {
    this.cache = deps.cache ?? new InMemoryScoreCache();
    this.scorer = deps.scorer ?? new PostureScorer();
    this.ttlSec = deps.ttlSec ?? 60;
  }

  /**
   * Compute (or retrieve from cache) the score for a cluster.
   * `loadFindings` is an injection so the service doesn't need to
   * know about the FindingRepository — keeps this layer pure.
   */
  async getScoreForCluster(
    clusterId: ClusterId,
    loadFindings: () => Promise<ReadonlyArray<ScorableFinding>>
  ): Promise<PostureScoreResult> {
    const key = KEY_PREFIX + clusterId;
    const cached = await this.cache.get(key);
    if (cached !== null) {
      try {
        return JSON.parse(cached) as PostureScoreResult;
      } catch {
        // Fall through to recompute on parse failure.
      }
    }
    const findings = await loadFindings();
    const result = this.scorer.score(findings);
    await this.cache.setex(key, this.ttlSec, JSON.stringify(result));
    return result;
  }

  async invalidate(clusterId: ClusterId): Promise<void> {
    await this.cache.del(KEY_PREFIX + clusterId);
  }

  /**
   * Subscribe to `security.scan.completed` and invalidate the
   * relevant cache key. Returns an unsubscribe handle so the
   * composition root can detach on shutdown.
   */
  installInvalidation(bus: EventBus): Unsubscribe {
    return bus.subscribe<{ scope?: { clusterId?: string } }>(
      'security.scan.completed',
      async event => {
        const cluster = event.payload?.scope?.clusterId;
        if (typeof cluster === 'string' && cluster.length > 0) {
          await this.invalidate(cluster as ClusterId);
        }
      }
    );
  }
}
