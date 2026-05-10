// NoOpIngestionBridge — fallback used when no real Python interpreter
// is available (default in unit tests and typical local dev). Always
// returns a deterministic "0 documents" success.

import type {
  IngestionBridge,
  IngestionRunSummary,
} from '../../domain/ports/ingestion-bridge';

export class NoOpIngestionBridge implements IngestionBridge {
  async triggerIngestion(): Promise<IngestionRunSummary> {
    return { success: true, documents: 0, durationMs: 0 };
  }
}
