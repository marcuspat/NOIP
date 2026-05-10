// SecretsScannerAdapter — gitleaks-style heuristic ACL.
// Phase 3 stub: the BuiltinPolicyScanner already runs a secret-in-env
// heuristic against k8s manifests. This adapter is reserved for the
// repository-side gitleaks integration that fires off a separate
// repository checkout.

import type {
  RawFinding,
  ScannerClient,
  ScannerInput,
} from '../../domain/ports/scanner-client';

export interface SecretsScannerAdapterDeps {
  realScannersFlag?: () => boolean;
  runCli?: (args: ReadonlyArray<string>) => Promise<string>;
}

export class SecretsScannerAdapter implements ScannerClient {
  readonly id = 'secrets-scanner';
  private readonly realFlag: () => boolean;
  private readonly runCli: (args: ReadonlyArray<string>) => Promise<string>;

  constructor(deps: SecretsScannerAdapterDeps = {}) {
    this.realFlag =
      deps.realScannersFlag ??
      (() => process.env['SECURITY_REAL_SCANNERS'] === 'true');
    this.runCli =
      deps.runCli ??
      (async () => {
        throw new Error('SecretsScannerAdapter.runCli not configured');
      });
  }

  async scan(_input: ScannerInput): Promise<RawFinding[]> {
    if (!this.realFlag()) return [];
    await this.runCli(['detect', '--report-format', 'json']);
    return [];
  }
}
