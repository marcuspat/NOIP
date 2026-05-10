// TrivyAdapter — image-vulnerability scanner ACL.
//
// The real adapter shells out to the Trivy CLI (or hits the Trivy
// HTTP server) and translates the JSON report into `RawFinding[]`.
// In the test runner the subprocess is suppressed: when the
// `SECURITY_REAL_SCANNERS=true` env var is unset the adapter is a
// no-op.

import type {
  RawFinding,
  ScannerClient,
  ScannerInput,
} from '../../domain/ports/scanner-client';

export interface TrivyAdapterDeps {
  /** Override for tests; when unset we read process.env. */
  realScannersFlag?: () => boolean;
  /** Function that runs the CLI; injected so tests can record calls. */
  runCli?: (args: ReadonlyArray<string>) => Promise<string>;
}

export class TrivyAdapter implements ScannerClient {
  readonly id = 'trivy';
  private readonly realFlag: () => boolean;
  private readonly runCli: (args: ReadonlyArray<string>) => Promise<string>;

  constructor(deps: TrivyAdapterDeps = {}) {
    this.realFlag =
      deps.realScannersFlag ??
      (() => process.env['SECURITY_REAL_SCANNERS'] === 'true');
    this.runCli =
      deps.runCli ??
      (async () => {
        throw new Error(
          'TrivyAdapter.runCli not configured; set SECURITY_REAL_SCANNERS=true and inject runCli'
        );
      });
  }

  async scan(_input: ScannerInput): Promise<RawFinding[]> {
    if (!this.realFlag()) return [];
    // Real implementation (deferred, gated behind the flag) parses
    // the Trivy JSON report into RawFinding[]. Phase 3 ships only
    // the contract; Phase 4 wires the parser.
    await this.runCli(['image', '--format', 'json']);
    return [];
  }
}
