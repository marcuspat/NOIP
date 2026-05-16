// In-memory `TransparencyLog` for tests and local dev.
//
// Records every submission in an in-memory Map keyed by
// `(shard, sequence)`. Repeat submissions for the same key are
// deduplicated — `submit` returns the same receipt — so the test
// suite can drive the audit `TransparencyLogService` deterministically
// without standing up Rekor.

import type {
  TransparencyLog,
  TransparencyLogReceipt,
  TransparencyLogSubmission,
} from '../../domain/ports/transparency-log';

export interface TransparencyLogStubOpts {
  /** When `true` the stub fails the next `submit` call with the given error. */
  injectError?: Error;
  /** Override the deterministic integratedAt clock. */
  now?: () => Date;
}

export class TransparencyLogStub implements TransparencyLog {
  /** Public so tests can introspect what was submitted. */
  public readonly receipts: Map<string, TransparencyLogReceipt> = new Map();
  public readonly submissions: TransparencyLogSubmission[] = [];
  private nextIndex = 0;
  private injectError?: Error;
  private readonly now: () => Date;

  constructor(opts: TransparencyLogStubOpts = {}) {
    this.now = opts.now ?? (() => new Date());
    if (opts.injectError) this.injectError = opts.injectError;
  }

  /** Inject a transient failure for the next `submit`. */
  failNext(err: Error): void {
    this.injectError = err;
  }

  async submit(
    submission: TransparencyLogSubmission
  ): Promise<TransparencyLogReceipt> {
    if (this.injectError) {
      const err = this.injectError;
      delete this.injectError;
      throw err;
    }
    const key = this.keyOf(submission.shard, submission.sequence);
    const cached = this.receipts.get(key);
    if (cached) return cached;
    const receipt: TransparencyLogReceipt = {
      logId: `stub-${key}`,
      logIndex: this.nextIndex++,
      integratedAt: this.now(),
      signature: `stub-sig:${submission.tipHash}`,
    };
    this.receipts.set(key, receipt);
    this.submissions.push(submission);
    return receipt;
  }

  async lookup(
    shard: string,
    sequence: number
  ): Promise<TransparencyLogReceipt | null> {
    return this.receipts.get(this.keyOf(shard, sequence)) ?? null;
  }

  /** Reset between tests without rebuilding the instance. */
  reset(): void {
    this.receipts.clear();
    this.submissions.length = 0;
    this.nextIndex = 0;
    delete this.injectError;
  }

  private keyOf(shard: string, sequence: number): string {
    return `${shard}:${sequence}`;
  }
}
