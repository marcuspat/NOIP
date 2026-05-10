// KubeLinterAdapter — kube-linter k8s misconfig scanner ACL.

import type {
  RawFinding,
  ScannerClient,
  ScannerInput,
} from '../../domain/ports/scanner-client';

export interface KubeLinterAdapterDeps {
  realScannersFlag?: () => boolean;
  runCli?: (args: ReadonlyArray<string>) => Promise<string>;
}

export class KubeLinterAdapter implements ScannerClient {
  readonly id = 'kube-linter';
  private readonly realFlag: () => boolean;
  private readonly runCli: (args: ReadonlyArray<string>) => Promise<string>;

  constructor(deps: KubeLinterAdapterDeps = {}) {
    this.realFlag =
      deps.realScannersFlag ??
      (() => process.env['SECURITY_REAL_SCANNERS'] === 'true');
    this.runCli =
      deps.runCli ??
      (async () => {
        throw new Error('KubeLinterAdapter.runCli not configured');
      });
  }

  async scan(_input: ScannerInput): Promise<RawFinding[]> {
    if (!this.realFlag()) return [];
    await this.runCli(['lint', '--format', 'json']);
    return [];
  }
}
