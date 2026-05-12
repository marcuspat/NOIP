// SecretsScannerAdapter — gitleaks integration ACL.
//
// Real implementation shells out to gitleaks:
//
//   gitleaks detect --source <path> --report-format json \
//     --report-path /dev/stdout --no-banner --redact
//
// gitleaks JSON schema (abridged):
//
//   [
//     {
//       "RuleID": "aws-access-token",
//       "Description": "AWS Access Key",
//       "StartLine": 12,
//       "EndLine": 12,
//       "File": "config/example.yaml",
//       "Match": "AKIAIOSFODNN7EXAMPLE",
//       "Secret": "REDACTED",
//       "Tags": ["secret"],
//       "Entropy": 4.2,
//       "Date": "2025-04-12T09:11:02Z",
//       "Commit": "...",
//       "Author": "..."
//     }
//   ]

import type { Clock } from '../../../../shared/kernel';
import {
  BackpressureError,
  NotConfiguredError,
  ProviderError,
} from '../../../../shared/errors';
import type {
  RawFinding,
  ScannerClient,
  ScannerInput,
} from '../../domain/ports/scanner-client';
import type {
  Evidence,
  ResourceRef,
  Severity,
} from '../../domain/value-objects';
import { builtinPolicyId } from './builtin-policy-scanner';
import { NodeSubprocessRunner, type SubprocessRunner } from './_subprocess';

export interface SecretsScannerAdapterDeps {
  realScannersFlag?: () => boolean;
  runner?: SubprocessRunner;
  binary?: string;
  timeoutMs?: number;
  clock?: Clock;
  /**
   * Filesystem path gitleaks should scan. Defaults to the current
   * working directory when not set; tests can override.
   */
  sourcePath?: string;
}

interface GitleaksFinding {
  RuleID?: string;
  Description?: string;
  File?: string;
  StartLine?: number;
  EndLine?: number;
  Match?: string;
  Tags?: string[];
  Entropy?: number;
  Commit?: string;
  Author?: string;
}

/**
 * Default severity per rule id. Anything unmapped is `high` because a
 * detected secret is, by definition, sensitive.
 */
export const GITLEAKS_SEVERITY: Readonly<Record<string, Severity>> = {
  'aws-access-token': 'critical',
  'aws-secret-access-key': 'critical',
  'gcp-service-account': 'critical',
  'private-key': 'critical',
  'github-pat': 'high',
  'github-oauth': 'high',
  'slack-access-token': 'high',
  'generic-api-key': 'high',
  jwt: 'high',
  'high-entropy-string': 'medium',
};

export function mapGitleaksSeverity(rule: string | undefined): Severity {
  if (!rule) return 'high';
  return (GITLEAKS_SEVERITY[rule] ?? 'high') as Severity;
}

export class SecretsScannerAdapter implements ScannerClient {
  readonly id = 'secrets-scanner';
  private readonly realFlag: () => boolean;
  private readonly runner: SubprocessRunner;
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly clock: Clock | undefined;
  private readonly sourcePath: string;

  constructor(deps: SecretsScannerAdapterDeps = {}) {
    this.realFlag =
      deps.realScannersFlag ??
      (() =>
        process.env['SECURITY_REAL_SCANNERS'] === 'true' &&
        process.env['SECURITY_REAL_SECRETS'] !== 'false');
    this.runner = deps.runner ?? new NodeSubprocessRunner();
    this.binary = deps.binary ?? 'gitleaks';
    this.timeoutMs = deps.timeoutMs ?? 60_000;
    this.clock = deps.clock;
    this.sourcePath = deps.sourcePath ?? process.cwd();
  }

  async scan(_input: ScannerInput): Promise<RawFinding[]> {
    if (!this.realFlag()) return [];
    const result = await this.runner.run({
      command: this.binary,
      args: [
        'detect',
        '--source',
        this.sourcePath,
        '--report-format',
        'json',
        '--report-path',
        '/dev/stdout',
        '--no-banner',
        '--redact',
      ],
      timeoutMs: this.timeoutMs,
    });
    if (result.notFound) {
      throw new NotConfiguredError(`gitleaks binary not found: ${this.binary}`);
    }
    if (result.timedOut) {
      throw new BackpressureError('gitleaks timeout');
    }
    // gitleaks exits non-zero when leaks are found. Treat 0 and 1 as OK;
    // anything else is a provider error.
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new ProviderError(
        `gitleaks exit ${result.exitCode}: ${result.stderr.trim() || 'no stderr'}`
      );
    }
    let findings: GitleaksFinding[];
    try {
      const trimmed = result.stdout.trim();
      findings =
        trimmed === '' ? [] : (JSON.parse(trimmed) as GitleaksFinding[]);
    } catch {
      throw new ProviderError('gitleaks: unparseable-output');
    }
    const capturedAt = (this.clock?.nowInstant() ??
      new Date().toISOString()) as Evidence['capturedAt'];
    return findings.map(f => this.toRawFinding(f, capturedAt));
  }

  private toRawFinding(
    f: GitleaksFinding,
    capturedAt: Evidence['capturedAt']
  ): RawFinding {
    const rule = f.RuleID ?? 'unknown-rule';
    const file = f.File ?? 'unknown';
    const resource: ResourceRef = {
      apiVersion: 'gitleaks/v1',
      kind: 'SecretLeak',
      name: `${file}#L${f.StartLine ?? 0}`,
    };
    const evidence: Evidence = {
      source: 'gitleaks',
      summary: `${rule} matched ${file}:${f.StartLine ?? 0}`,
      data: {
        rule,
        file,
        startLine: f.StartLine ?? null,
        endLine: f.EndLine ?? null,
        // We deliberately do NOT carry the raw secret value; gitleaks
        // is invoked with --redact, so `Match` is `REDACTED`.
        match: f.Match ?? null,
        entropy: f.Entropy ?? null,
        commit: f.Commit ?? null,
      },
      capturedAt,
    };
    return {
      policyId: builtinPolicyId(`secret.${rule}`),
      resource,
      severity: mapGitleaksSeverity(rule),
      description: f.Description ?? `Secret detected: ${rule}`,
      recommendation:
        'Rotate the credential immediately, remove it from VCS history, and store it in a Secret manager.',
      evidence,
    };
  }
}
