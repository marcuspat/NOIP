// KubeBenchAdapter — CIS Kubernetes Benchmark scanner ACL.
//
// Real implementation shells out to:
//
//   kube-bench run --json [--targets <comma-separated>]
//
// kube-bench JSON schema (abridged) we consume:
//
//   {
//     "Controls": [
//       {
//         "id": "1",
//         "version": "1.23",
//         "text": "Control Plane Security Configuration",
//         "node_type": "master",
//         "tests": [
//           {
//             "section": "1.1",
//             "desc": "...",
//             "results": [
//               {
//                 "test_number": "1.1.1",
//                 "test_desc": "Ensure that the API server pod ...",
//                 "status": "FAIL",  // PASS | FAIL | WARN | INFO
//                 "scored": true,
//                 "remediation": "...",
//                 "expected_result": "...",
//                 "actual_value": "..."
//               }
//             ]
//           }
//         ]
//       }
//     ]
//   }

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

export interface KubeBenchAdapterDeps {
  realScannersFlag?: () => boolean;
  runner?: SubprocessRunner;
  binary?: string;
  timeoutMs?: number;
  clock?: Clock;
  /**
   * If set, used verbatim instead of running kube-bench. Mostly for
   * legacy in-cluster jobs that already produced kube-bench JSON; the
   * Phase 3.5 path expects the binary to be present and exec'able.
   */
  cannedReport?: string;
}

interface KubeBenchResult {
  test_number?: string;
  test_desc?: string;
  status?: string;
  scored?: boolean;
  remediation?: string;
  expected_result?: string;
  actual_value?: string;
}

interface KubeBenchTest {
  section?: string;
  desc?: string;
  results?: KubeBenchResult[];
}

interface KubeBenchControl {
  id?: string;
  version?: string;
  text?: string;
  node_type?: string;
  tests?: KubeBenchTest[];
}

interface KubeBenchReport {
  Controls?: KubeBenchControl[];
}

/**
 * Maps a kube-bench result `status` to our severity ladder. The CIS
 * benchmark itself does not score per-check severities, so we use:
 *   FAIL on a scored check → high
 *   FAIL on an unscored check → medium
 *   WARN → low (operator review required, not a guaranteed issue)
 *   PASS / INFO → skipped (not a finding)
 */
export function mapKubeBenchSeverity(
  status: string | undefined,
  scored: boolean | undefined
): Severity | null {
  switch ((status ?? '').toUpperCase()) {
    case 'FAIL':
      return scored === false ? 'medium' : 'high';
    case 'WARN':
      return 'low';
    case 'PASS':
    case 'INFO':
    default:
      return null;
  }
}

export class KubeBenchAdapter implements ScannerClient {
  readonly id = 'kube-bench';
  private readonly realFlag: () => boolean;
  private readonly runner: SubprocessRunner;
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly clock: Clock | undefined;
  private readonly cannedReport: string | undefined;

  constructor(deps: KubeBenchAdapterDeps = {}) {
    this.realFlag =
      deps.realScannersFlag ??
      (() =>
        process.env['SECURITY_REAL_SCANNERS'] === 'true' &&
        process.env['SECURITY_REAL_KUBE_BENCH'] !== 'false');
    this.runner = deps.runner ?? new NodeSubprocessRunner();
    this.binary = deps.binary ?? 'kube-bench';
    this.timeoutMs = deps.timeoutMs ?? 60_000;
    this.clock = deps.clock;
    this.cannedReport = deps.cannedReport;
  }

  async scan(_input: ScannerInput): Promise<RawFinding[]> {
    if (!this.realFlag()) return [];
    let stdout: string;
    if (this.cannedReport !== undefined) {
      stdout = this.cannedReport;
    } else {
      const result = await this.runner.run({
        command: this.binary,
        args: ['run', '--json'],
        timeoutMs: this.timeoutMs,
      });
      if (result.notFound) {
        throw new NotConfiguredError(
          `kube-bench binary not found: ${this.binary}`
        );
      }
      if (result.timedOut) {
        throw new BackpressureError('kube-bench timeout');
      }
      if (result.exitCode !== 0) {
        throw new ProviderError(
          `kube-bench exit ${result.exitCode}: ${result.stderr.trim() || 'no stderr'}`
        );
      }
      stdout = result.stdout;
    }
    let report: KubeBenchReport;
    try {
      report = JSON.parse(stdout) as KubeBenchReport;
    } catch {
      throw new ProviderError('kube-bench: unparseable-output');
    }
    const capturedAt = (this.clock?.nowInstant() ??
      new Date().toISOString()) as Evidence['capturedAt'];
    const out: RawFinding[] = [];
    for (const ctrl of report.Controls ?? []) {
      for (const t of ctrl.tests ?? []) {
        for (const r of t.results ?? []) {
          const sev = mapKubeBenchSeverity(r.status, r.scored);
          if (sev === null) continue;
          out.push(this.toFinding(ctrl, t, r, sev, capturedAt));
        }
      }
    }
    return out;
  }

  private toFinding(
    ctrl: KubeBenchControl,
    t: KubeBenchTest,
    r: KubeBenchResult,
    severity: Severity,
    capturedAt: Evidence['capturedAt']
  ): RawFinding {
    const testNumber = r.test_number ?? `${ctrl.id ?? '?'}.${t.section ?? '?'}`;
    const resource: ResourceRef = {
      apiVersion: 'cis/v1',
      kind: 'CISControl',
      name: testNumber,
    };
    const evidence: Evidence = {
      source: 'kube-bench',
      summary: `CIS ${testNumber}: ${r.test_desc ?? ''}`.trim(),
      data: {
        controlId: ctrl.id ?? null,
        controlVersion: ctrl.version ?? null,
        nodeType: ctrl.node_type ?? null,
        section: t.section ?? null,
        status: r.status ?? null,
        scored: r.scored ?? null,
        expectedResult: r.expected_result ?? null,
        actualValue: r.actual_value ?? null,
      },
      capturedAt,
    };
    return {
      policyId: builtinPolicyId(`cis.${testNumber}`),
      resource,
      severity,
      description: r.test_desc ?? `CIS ${testNumber}`,
      ...(r.remediation !== undefined && r.remediation !== ''
        ? { recommendation: r.remediation }
        : {}),
      evidence,
    };
  }
}
