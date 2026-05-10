// CompositeScanner — fans an input out to N scanners and unions
// their `RawFinding[]` outputs. Errors from individual scanners are
// caught and logged so a single bad adapter doesn't abort the run.

import type {
  RawFinding,
  ScannerClient,
  ScannerInput,
} from '../../domain/ports/scanner-client';

export interface CompositeScannerLogger {
  warn: (msg: string, meta?: Record<string, unknown>) => void;
}

const NOOP_LOGGER: CompositeScannerLogger = { warn: () => undefined };

export class CompositeScanner implements ScannerClient {
  readonly id = 'composite';

  constructor(
    private readonly scanners: ReadonlyArray<ScannerClient>,
    private readonly logger: CompositeScannerLogger = NOOP_LOGGER
  ) {}

  async scan(input: ScannerInput): Promise<RawFinding[]> {
    const out: RawFinding[] = [];
    const results = await Promise.allSettled(
      this.scanners.map(s => s.scan(input))
    );
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      const scanner = this.scanners[i]!;
      if (r.status === 'fulfilled') {
        out.push(...r.value);
      } else {
        this.logger.warn('scanner failed', {
          scanner: scanner.id,
          err: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      }
    }
    return out;
  }
}
