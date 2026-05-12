// Availability detector for contract tests.
//
// `isChromaReachable` is intentionally lenient: it returns `false` for any
// non-2xx HTTP status, any network/timeout error, or invalid URL. The
// purpose is to gate contract tests so they SKIP cleanly in environments
// without a real Chroma instance — never to fail the suite.
//
// Heartbeat path follows ChromaDB's HTTP API (`/api/v1/heartbeat`),
// matching the wire surface exercised by `ChromaAdapter`.

/**
 * Detects whether a ChromaDB instance answers a heartbeat at `url` within
 * `timeoutMs`. Never throws. Returns `true` only on a 2xx response.
 *
 * @param url base URL, e.g. `http://localhost:8000`
 * @param timeoutMs abort budget for the heartbeat request (default 1000ms)
 */
export async function isChromaReachable(
  url: string,
  timeoutMs = 1000
): Promise<boolean> {
  if (!url || typeof url !== 'string') return false;
  const base = url.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/v1/heartbeat`, {
      method: 'GET',
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves the CHROMA_URL env var with a stable default. Tests should use
 * this rather than reading `process.env` directly so behaviour is
 * consistent across the harness.
 */
export function resolveChromaUrl(): string {
  return process.env['CHROMA_URL'] ?? 'http://localhost:8000';
}
