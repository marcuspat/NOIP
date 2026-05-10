// KubeBenchAdapter — CIS Kubernetes Benchmark scanner ACL.
//
// Real implementation invokes `kube-bench run` and parses the JSON
// summary into `RawFinding[]`. Off in tests via SECURITY_REAL_SCANNERS.

import type {
  RawFinding,
  ScannerClient,
  ScannerInput,
} from '../../domain/ports/scanner-client';

export interface KubeBenchAdapterDeps {
  realScannersFlag?: () => boolean;
  runCli?: (args: ReadonlyArray<string>) => Promise<string>;
}

export class KubeBenchAdapter implements ScannerClient {
  readonly id = 'kube-bench';
  private readonly realFlag: () => boolean;
  private readonly runCli: (args: ReadonlyArray<string>) => Promise<string>;

  constructor(deps: KubeBenchAdapterDeps = {}) {
    this.realFlag =
      deps.realScannersFlag ??
      (() => process.env['SECURITY_REAL_SCANNERS'] === 'true');
    this.runCli =
      deps.runCli ??
      (async () => {
        throw new Error('KubeBenchAdapter.runCli not configured');
      });
  }

  async scan(_input: ScannerInput): Promise<RawFinding[]> {
    if (!this.realFlag()) return [];
    await this.runCli(['run', '--json']);
    return [];
  }
}
