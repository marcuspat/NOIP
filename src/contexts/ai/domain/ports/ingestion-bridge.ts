// Domain-side port for the Python ingestion bridge.
//
// The PythonRagBridge (in infrastructure/python/) shells out to
// `scripts/update_rag.py`. Tests inject a mock implementation; the
// production adapter spawns Python as a subprocess. Either way, the
// domain only sees this neutral interface.

export interface IngestionRunSummary {
  /** Whether the script reported success (exit code 0). */
  success: boolean;
  /** Number of documents the script claims to have ingested. */
  documents: number;
  /** Free-form summary line, suitable for logs. */
  message?: string;
  /** Wall-clock time taken (ms). */
  durationMs: number;
}

export interface IngestionTriggerSpec {
  /** Optional incremental boundary. ISO 8601 instant. */
  since?: string;
  /** Override target collection (e.g. 'incidents', 'compliance'). */
  collection?: string;
}

/**
 * Provider-neutral ingestion bridge. Implementations:
 *   - infrastructure/python/python-rag-bridge.ts (subprocess to scripts/update_rag.py)
 *   - infrastructure/python/no-op-bridge.ts (used when Python is unavailable)
 */
export interface IngestionBridge {
  triggerIngestion(spec: IngestionTriggerSpec): Promise<IngestionRunSummary>;
}
