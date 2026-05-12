// Collection lifecycle helpers used only by the contract suite.
//
// The production `ChromaAdapter` deliberately does NOT expose
// create/delete-collection — those are operator concerns and ADR-0013
// keeps them outside the runtime ACL. For contract tests we DO need to
// provision an isolated namespace per run so retries don't pollute, so
// we talk to the same `/api/v1/collections` surface directly.

import { randomBytes } from 'node:crypto';

export interface CollectionLifecycleLogger {
  warn(msg: string, meta?: unknown): void;
}

const NOOP_LOGGER: CollectionLifecycleLogger = { warn: () => undefined };

/**
 * Mint a unique collection name. Length-capped at 60 chars to satisfy
 * Chroma's identifier rules (which historically reject very long names).
 */
export function uniqueCollectionName(prefix = 'noip_contract'): string {
  const ts = Date.now();
  const hex = randomBytes(2).toString('hex');
  return `${prefix}_${ts}_${hex}`.slice(0, 60);
}

/**
 * POST /api/v1/collections to ensure a collection exists. Returns `true`
 * on success. Idempotent in the sense that a re-create on an existing
 * collection is treated as success.
 */
export async function ensureCollection(
  baseURL: string,
  name: string,
  logger: CollectionLifecycleLogger = NOOP_LOGGER
): Promise<boolean> {
  const base = baseURL.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/api/v1/collections`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, get_or_create: true }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn('chroma collection create failed', {
        status: res.status,
        body: text.slice(0, 200),
      });
      return false;
    }
    return true;
  } catch (err) {
    logger.warn('chroma collection create error', {
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * DELETE /api/v1/collections/<name>. Returns `true` on 2xx. Never throws.
 * A failure is logged but never fails the suite — operator-permission
 * issues in nightly should be a warning, not a regression.
 */
export async function dropCollection(
  baseURL: string,
  name: string,
  logger: CollectionLifecycleLogger = NOOP_LOGGER
): Promise<boolean> {
  const base = baseURL.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/api/v1/collections/${name}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      logger.warn('chroma collection delete non-2xx', { status: res.status });
      return false;
    }
    return true;
  } catch (err) {
    logger.warn('chroma collection delete error', {
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
