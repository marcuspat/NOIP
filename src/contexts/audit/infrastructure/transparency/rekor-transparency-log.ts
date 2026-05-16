// Sigstore Rekor implementation of `TransparencyLog`.
//
// Rekor (https://docs.sigstore.dev/logging/overview) accepts signed
// payloads and returns an immutable log entry with an inclusion
// proof. We only need the lightweight "hashedrekord" entry type:
// every chain-tip submission carries the SHA-256 of the chain tip
// and the producer signs the canonical payload below.
//
// Implementation notes:
//   - The HTTP client is built on `globalThis.fetch` (Node 18+); no
//     new dependency added. Production toggles this adapter on with
//     `TRANSPARENCY_LOG_PROVIDER=rekor`; the default is the in-memory
//     stub.
//   - We don't ship a Sigstore signing flow yet — payloads are
//     posted unsigned with `kind: 'hashedrekord-noip-v0.1'`. The
//     ADR-0017 follow-up will swap in cosign keyless signing.
//   - Lookup is by `(shard, sequence)`; we cache the receipt on
//     first submit so re-submits collapse to a Map hit.

import type {
  TransparencyLog,
  TransparencyLogReceipt,
  TransparencyLogSubmission,
} from '../../domain/ports/transparency-log';
import { NotConfiguredError, ProviderError } from '../../../../shared/errors';

export interface RekorTransparencyLogEnv {
  /** Full Rekor URL, e.g. `https://rekor.sigstore.dev`. */
  REKOR_BASE_URL?: string;
  /**
   * Bearer token, when Rekor requires auth (most public deployments do
   * not). Optional; passed as `Authorization: Bearer <token>` when set.
   */
  REKOR_AUTH_TOKEN?: string;
}

export interface RekorTransparencyLogOpts {
  env?: RekorTransparencyLogEnv;
  /** Override for tests: replace `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Override the request timeout (ms). Defaults to 5_000. */
  timeoutMs?: number;
}

/** Minimal request body. Rekor accepts arbitrary kinds; we keep ours flat. */
interface RekorRequestBody {
  apiVersion: '0.0.1';
  kind: 'hashedrekord-noip-v0.1';
  spec: {
    data: {
      hash: { algorithm: 'sha256'; value: string };
    };
    metadata: {
      shard: string;
      sequence: number;
      occurredAt: string;
    };
  };
}

/** Trimmed-down Rekor response. */
interface RekorResponseBody {
  uuid: string;
  body?: string;
  integratedTime?: number;
  logID?: string;
  logIndex?: number;
  verification?: { signedEntryTimestamp?: string };
}

const DEFAULT_TIMEOUT_MS = 5_000;

export class RekorTransparencyLog implements TransparencyLog {
  private readonly baseUrl: string;
  private readonly authHeader: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly cache: Map<string, TransparencyLogReceipt> = new Map();

  constructor(opts: RekorTransparencyLogOpts = {}) {
    const env = opts.env ?? (process.env as RekorTransparencyLogEnv);
    const base = env.REKOR_BASE_URL;
    if (!base || base === '') {
      throw new NotConfiguredError(
        'REKOR_BASE_URL env var is required for the Rekor transparency-log adapter'
      );
    }
    this.baseUrl = base.replace(/\/+$/, '');
    this.authHeader = env.REKOR_AUTH_TOKEN
      ? `Bearer ${env.REKOR_AUTH_TOKEN}`
      : null;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new NotConfiguredError(
        'global fetch is unavailable; pass an explicit fetchImpl to RekorTransparencyLog'
      );
    }
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async submit(
    submission: TransparencyLogSubmission
  ): Promise<TransparencyLogReceipt> {
    const cacheKey = `${submission.shard}:${submission.sequence}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const body: RekorRequestBody = {
      apiVersion: '0.0.1',
      kind: 'hashedrekord-noip-v0.1',
      spec: {
        data: { hash: { algorithm: 'sha256', value: submission.tipHash } },
        metadata: {
          shard: submission.shard,
          sequence: submission.sequence,
          occurredAt: submission.occurredAt.toISOString(),
        },
      },
    };
    const res = await this.post('/api/v1/log/entries', body);
    if (!res.ok) {
      throw new ProviderError('Rekor submit failed', {
        status: res.status,
        body: await safeText(res),
      });
    }
    const json = (await res.json()) as Record<string, RekorResponseBody>;
    const first = Object.values(json)[0];
    if (!first || !first.uuid) {
      throw new ProviderError('Rekor returned malformed response', {
        body: JSON.stringify(json),
      });
    }
    const receipt: TransparencyLogReceipt = {
      logId: first.uuid,
      logIndex: first.logIndex ?? -1,
      integratedAt:
        first.integratedTime !== undefined
          ? new Date(first.integratedTime * 1000)
          : new Date(),
      ...(first.verification?.signedEntryTimestamp
        ? { signature: first.verification.signedEntryTimestamp }
        : {}),
    };
    this.cache.set(cacheKey, receipt);
    return receipt;
  }

  async lookup(
    shard: string,
    sequence: number
  ): Promise<TransparencyLogReceipt | null> {
    const cacheKey = `${shard}:${sequence}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    // Rekor doesn't index by arbitrary metadata; we rely on our cache
    // for the round-trip. A future enhancement is to persist receipts
    // to Mongo so a pod restart can still verify yesterday's tips —
    // tracked as a follow-up; the stub adapter handles the test path.
    return null;
  }

  private async post(
    path: string,
    body: unknown
  ): Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      if (this.authHeader) headers['Authorization'] = this.authHeader;
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return res;
    } catch (err) {
      throw new ProviderError('Rekor request failed', {
        cause: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

async function safeText(res: { text: () => Promise<string> }): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '<unreadable>';
  }
}

/**
 * Factory helper: chooses the Rekor adapter when
 * `TRANSPARENCY_LOG_PROVIDER=rekor`, otherwise returns `null` so the
 * caller can fall back to the in-memory stub.
 */
export function createRekorIfConfigured(
  env: NodeJS.ProcessEnv = process.env
): RekorTransparencyLog | null {
  if (env['TRANSPARENCY_LOG_PROVIDER'] !== 'rekor') return null;
  return new RekorTransparencyLog({
    env: env as RekorTransparencyLogEnv,
  });
}
