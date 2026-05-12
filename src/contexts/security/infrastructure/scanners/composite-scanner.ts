// CompositeScanner — fans a `ScannerInput` out to N `ScannerClient`s
// with bounded concurrency, tolerates per-adapter failure, and emits a
// `security.scan.partial` domain event when any adapter throws.
//
// Toggle behaviour:
//   - `SECURITY_REAL_SCANNERS=true` enables the real adapters.
//   - Each adapter is then individually opt-out via
//     `SECURITY_REAL_TRIVY=false`, `SECURITY_REAL_KUBE_BENCH=false`, etc.
//
// Dedupe: when multiple adapters return the same
// `(policyId, kind, namespace, name)` we keep the first one.

import type { ClusterId, Clock, EventBus } from '../../../../shared/kernel';
import { compose } from '../../../../shared/kernel/events';
import type {
  RawFinding,
  ScannerClient,
  ScannerInput,
} from '../../domain/ports/scanner-client';

export interface CompositeScannerLogger {
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  info?: (msg: string, meta?: Record<string, unknown>) => void;
}

const NOOP_LOGGER: CompositeScannerLogger = { warn: () => undefined };

export interface CompositeScannerOpts {
  /** Per-adapter timeout. Default 8 concurrent adapters per scan. */
  concurrency?: number;
  /** Event bus for `security.scan.partial`. Optional. */
  bus?: EventBus;
  /** Clock for event timestamps. Required if `bus` is provided. */
  clock?: Clock;
  /** Cluster id for the emitted event. */
  clusterId?: ClusterId;
  /** Enable per-adapter verbose timing via `logger.info`. */
  verbose?: boolean;
}

/**
 * Payload of the `security.scan.partial` event. Emitted exactly once
 * per `scan()` invocation that experienced at least one adapter
 * failure; the application service is otherwise free to complete the
 * scan with whatever findings the surviving adapters produced.
 */
export interface SecurityScanPartialPayload {
  scannerId: 'composite';
  failures: ReadonlyArray<{
    adapter: string;
    error: string;
    code?: string;
  }>;
  succeeded: ReadonlyArray<string>;
  attempted: number;
}

const DEFAULT_CONCURRENCY = 4;

function fpKey(f: RawFinding): string {
  const ns = f.resource.namespace ?? '';
  return `${f.policyId}|${f.resource.kind}|${ns}|${f.resource.name}`;
}

export class CompositeScanner implements ScannerClient {
  readonly id = 'composite';
  private readonly logger: CompositeScannerLogger;
  private readonly concurrency: number;
  private readonly bus: EventBus | undefined;
  private readonly clock: Clock | undefined;
  private readonly clusterId: ClusterId | undefined;
  private readonly verbose: boolean;

  constructor(
    private readonly scanners: ReadonlyArray<ScannerClient>,
    logger: CompositeScannerLogger = NOOP_LOGGER,
    opts: CompositeScannerOpts = {}
  ) {
    this.logger = logger;
    this.concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
    this.bus = opts.bus;
    this.clock = opts.clock;
    this.clusterId = opts.clusterId;
    this.verbose = opts.verbose ?? process.env['SCANNER_VERBOSE'] === '1';
  }

  async scan(input: ScannerInput): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    const seen = new Set<string>();
    const failures: SecurityScanPartialPayload['failures'][number][] = [];
    const succeeded: string[] = [];

    // Bounded-concurrency fan-out: process the scanners array in
    // chunks of size `this.concurrency`.
    const chunks = chunk(this.scanners.slice(), this.concurrency);
    for (const batch of chunks) {
      const results = await Promise.allSettled(
        batch.map(async s => {
          const t0 = Date.now();
          const r = await s.scan(input);
          const elapsed = Date.now() - t0;
          if (this.verbose && this.logger.info) {
            this.logger.info('scanner ok', {
              scanner: s.id,
              ms: elapsed,
              bytes: JSON.stringify(r).length,
              findings: r.length,
            });
          }
          return { id: s.id, findings: r };
        })
      );
      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        const scanner = batch[i]!;
        if (r.status === 'fulfilled') {
          succeeded.push(r.value.id);
          for (const f of r.value.findings) {
            const k = fpKey(f);
            if (seen.has(k)) continue;
            seen.add(k);
            findings.push(f);
          }
        } else {
          const reason = r.reason;
          const msg = reason instanceof Error ? reason.message : String(reason);
          const codeProp =
            reason !== null && typeof reason === 'object'
              ? (reason as Record<string, unknown>)['code']
              : undefined;
          const code = typeof codeProp === 'string' ? codeProp : undefined;
          const entry: SecurityScanPartialPayload['failures'][number] = {
            adapter: scanner.id,
            error: msg,
          };
          if (code !== undefined) entry.code = code;
          failures.push(entry);
          this.logger.warn('scanner failed', {
            scanner: scanner.id,
            err: msg,
            ...(code !== undefined ? { code } : {}),
          });
        }
      }
    }

    if (failures.length > 0) {
      this.emitPartial(failures, succeeded);
    }
    return findings;
  }

  private emitPartial(
    failures: SecurityScanPartialPayload['failures'][number][],
    succeeded: string[]
  ): void {
    if (!this.bus || !this.clock) return;
    const payload: SecurityScanPartialPayload = {
      scannerId: 'composite',
      failures,
      succeeded,
      attempted: this.scanners.length,
    };
    this.bus.publish(
      compose(
        {
          type: 'security.scan.partial',
          context: 'security',
          aggregateType: 'SecurityScan',
          aggregateId: this.clusterId ?? 'composite',
          actor: { type: 'system' },
          payload,
        },
        this.clock
      )
    );
  }
}

function chunk<T>(arr: ReadonlyArray<T>, size: number): T[][] {
  if (size <= 0) return [arr.slice() as T[]];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size) as T[]);
  }
  return out;
}
