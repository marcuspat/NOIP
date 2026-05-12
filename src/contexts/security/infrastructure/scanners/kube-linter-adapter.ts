// KubeLinterAdapter — kube-linter Kubernetes misconfig scanner ACL.
//
// Real implementation shells out to:
//
//   kube-linter lint --format json -  (manifests via stdin)
//
// The snapshot input is converted to a stream of YAML/JSON-encoded
// manifests on stdin and the kube-linter JSON report is parsed.
//
// kube-linter JSON schema (abridged):
//
//   {
//     "Reports": [
//       {
//         "Diagnostic": { "Message": "...", "Description": "..." },
//         "Check": { "Name": "no-readiness-probe", "Description": "..." },
//         "Object": {
//           "K8sObject": {
//             "GroupVersionKind": { "Group": "", "Version": "v1", "Kind": "Pod" },
//             "Namespace": "default",
//             "Name": "demo"
//           }
//         },
//         "Remediation": "..."
//       }
//     ],
//     "Summary": { "ChecksStatus": "..." }
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

export interface KubeLinterAdapterDeps {
  realScannersFlag?: () => boolean;
  runner?: SubprocessRunner;
  binary?: string;
  timeoutMs?: number;
  clock?: Clock;
  /** Optional severity override per kube-linter check name. */
  severityOverrides?: Readonly<Record<string, Severity>>;
}

interface KubeLinterReport {
  Reports?: KubeLinterReportEntry[];
}

interface KubeLinterReportEntry {
  Diagnostic?: { Message?: string; Description?: string };
  Check?: { Name?: string; Description?: string; Remediation?: string };
  Object?: { K8sObject?: KubeLinterK8sObject };
  Remediation?: string;
}

interface KubeLinterK8sObject {
  GroupVersionKind?: { Group?: string; Version?: string; Kind?: string };
  Namespace?: string;
  Name?: string;
}

/**
 * Default mapping from kube-linter check names to severity. Anything
 * not in this table defaults to `medium` (we keep the table small;
 * operators can override via `severityOverrides`).
 */
export const KUBE_LINTER_SEVERITY: Readonly<Record<string, Severity>> = {
  'privileged-container': 'critical',
  'run-as-non-root': 'high',
  'host-network': 'high',
  'host-pid': 'high',
  'host-ipc': 'high',
  'no-read-only-root-fs': 'medium',
  'no-readiness-probe': 'low',
  'no-liveness-probe': 'low',
  'unset-cpu-requirements': 'low',
  'unset-memory-requirements': 'low',
  'latest-tag': 'low',
  'no-anti-affinity': 'low',
};

export function mapKubeLinterSeverity(
  check: string,
  overrides?: Readonly<Record<string, Severity>>
): Severity {
  return (overrides?.[check] ??
    KUBE_LINTER_SEVERITY[check] ??
    'medium') as Severity;
}

export class KubeLinterAdapter implements ScannerClient {
  readonly id = 'kube-linter';
  private readonly realFlag: () => boolean;
  private readonly runner: SubprocessRunner;
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly clock: Clock | undefined;
  private readonly severityOverrides: Readonly<Record<string, Severity>>;

  constructor(deps: KubeLinterAdapterDeps = {}) {
    this.realFlag =
      deps.realScannersFlag ??
      (() =>
        process.env['SECURITY_REAL_SCANNERS'] === 'true' &&
        process.env['SECURITY_REAL_KUBE_LINTER'] !== 'false');
    this.runner = deps.runner ?? new NodeSubprocessRunner();
    this.binary = deps.binary ?? 'kube-linter';
    this.timeoutMs = deps.timeoutMs ?? 60_000;
    this.clock = deps.clock;
    this.severityOverrides = deps.severityOverrides ?? {};
  }

  async scan(input: ScannerInput): Promise<RawFinding[]> {
    if (!this.realFlag()) return [];
    if (input.records.length === 0) return [];

    const stdin = serialiseManifests(input);
    const result = await this.runner.run({
      command: this.binary,
      args: ['lint', '--format', 'json', '-'],
      stdin,
      timeoutMs: this.timeoutMs,
    });
    if (result.notFound) {
      throw new NotConfiguredError(
        `kube-linter binary not found: ${this.binary}`
      );
    }
    if (result.timedOut) {
      throw new BackpressureError('kube-linter timeout');
    }
    // kube-linter returns non-zero when any check fails; only treat
    // exit codes > 1 as a real error. Exit code 1 == findings present.
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new ProviderError(
        `kube-linter exit ${result.exitCode}: ${result.stderr.trim() || 'no stderr'}`
      );
    }
    let report: KubeLinterReport;
    try {
      report = JSON.parse(result.stdout) as KubeLinterReport;
    } catch {
      throw new ProviderError('kube-linter: unparseable-output');
    }
    const capturedAt = (this.clock?.nowInstant() ??
      new Date().toISOString()) as Evidence['capturedAt'];
    return (report.Reports ?? []).map(r => this.toFinding(r, capturedAt));
  }

  private toFinding(
    entry: KubeLinterReportEntry,
    capturedAt: Evidence['capturedAt']
  ): RawFinding {
    const checkName = entry.Check?.Name ?? 'unknown';
    const k8s = entry.Object?.K8sObject ?? {};
    const gvk = k8s.GroupVersionKind ?? {};
    const apiVersion =
      gvk.Group !== undefined && gvk.Group !== ''
        ? `${gvk.Group}/${gvk.Version ?? 'v1'}`
        : (gvk.Version ?? 'v1');
    const resource: ResourceRef = {
      apiVersion,
      kind: gvk.Kind ?? 'Unknown',
      name: k8s.Name ?? '',
    };
    if (k8s.Namespace !== undefined && k8s.Namespace !== '') {
      resource.namespace = k8s.Namespace;
    }
    const severity = mapKubeLinterSeverity(checkName, this.severityOverrides);
    const description =
      entry.Diagnostic?.Message ??
      entry.Diagnostic?.Description ??
      entry.Check?.Description ??
      checkName;
    const recommendation = entry.Remediation ?? entry.Check?.Remediation;
    const evidence: Evidence = {
      source: 'kube-linter',
      summary: `${checkName}: ${description}`,
      data: {
        check: checkName,
        message: entry.Diagnostic?.Message ?? null,
      },
      capturedAt,
    };
    return {
      policyId: builtinPolicyId(`klint.${checkName}`),
      resource,
      severity,
      description,
      ...(recommendation !== undefined && recommendation !== ''
        ? { recommendation }
        : {}),
      evidence,
    };
  }
}

/**
 * Serialise the snapshot input as a sequence of JSON objects on stdin.
 * kube-linter accepts either YAML or JSON; we emit JSON one doc per line
 * so the binary can parse it without a YAML dependency.
 */
function serialiseManifests(input: ScannerInput): string {
  return (
    input.records
      .map(r => {
        const meta: Record<string, unknown> = { name: r.name };
        if (r.namespace !== undefined) meta['namespace'] = r.namespace;
        if (Object.keys(r.labels).length > 0) meta['labels'] = r.labels;
        if (Object.keys(r.annotations).length > 0)
          meta['annotations'] = r.annotations;
        return JSON.stringify({
          apiVersion: r.apiVersion,
          kind: r.kind,
          metadata: meta,
          spec: r.spec ?? {},
          status: r.status ?? {},
        });
      })
      .join('\n') + '\n'
  );
}
