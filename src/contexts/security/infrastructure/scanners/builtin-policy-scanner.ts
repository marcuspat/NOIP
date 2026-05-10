// BuiltinPolicyScanner — pure-TypeScript implementation of the most
// important Kubernetes misconfiguration checks. No subprocess, no
// network calls, deterministic output.
//
// This is the zero-dependency default scanner. Real CLI scanners
// (Trivy, kube-bench, kube-linter) sit behind feature flags and the
// composite scanner.
//
// Each policy is keyed by `checkId` so the application service can
// look up the corresponding `SecurityPolicy` aggregate to attach to
// raw findings before promotion.

import type { Clock, PolicyId } from '../../../../shared/kernel';
import { K8S_CATEGORY_SEVERITY } from '../../domain/severity-classifier';
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

export interface BuiltinPolicyDefinition {
  checkId: string;
  name: string;
  description: string;
  recommendation: string;
  severity: Severity;
}

/**
 * Catalogue of builtin checks. Names match the keys used by the
 * `ComplianceMapper` so the seed mappings line up.
 */
export const BUILTIN_POLICIES: ReadonlyArray<BuiltinPolicyDefinition> = [
  {
    checkId: 'k8s.privileged',
    name: 'k8s.privileged',
    description: 'Container runs in privileged mode.',
    recommendation:
      'Remove `securityContext.privileged: true`. Use targeted Linux capabilities instead.',
    severity: K8S_CATEGORY_SEVERITY['k8s.privileged']!,
  },
  {
    checkId: 'k8s.runAsRoot',
    name: 'k8s.runAsRoot',
    description:
      'Container does not declare runAsNonRoot=true (may run as UID 0).',
    recommendation:
      'Set `securityContext.runAsNonRoot: true` and pick a non-zero `runAsUser`.',
    severity: K8S_CATEGORY_SEVERITY['k8s.runAsRoot']!,
  },
  {
    checkId: 'k8s.hostNetwork',
    name: 'k8s.hostNetwork',
    description: 'Pod uses hostNetwork=true.',
    recommendation:
      'Avoid `hostNetwork` unless the workload is a node-level agent that genuinely requires it.',
    severity: K8S_CATEGORY_SEVERITY['k8s.hostNetwork']!,
  },
  {
    checkId: 'k8s.hostPID',
    name: 'k8s.hostPID',
    description: 'Pod uses hostPID=true.',
    recommendation:
      'Set `hostPID: false`. Sharing the host PID namespace exposes every process on the node.',
    severity: K8S_CATEGORY_SEVERITY['k8s.hostPID']!,
  },
  {
    checkId: 'k8s.hostIPC',
    name: 'k8s.hostIPC',
    description: 'Pod uses hostIPC=true.',
    recommendation:
      'Set `hostIPC: false`. Sharing the host IPC namespace breaks pod isolation.',
    severity: K8S_CATEGORY_SEVERITY['k8s.hostIPC']!,
  },
  {
    checkId: 'k8s.missingNetworkPolicy',
    name: 'k8s.missingNetworkPolicy',
    description: 'Namespace has pods but no NetworkPolicy covering them.',
    recommendation:
      'Add a default-deny `NetworkPolicy` and allow only the specific traffic each pod requires.',
    severity: K8S_CATEGORY_SEVERITY['k8s.missingNetworkPolicy']!,
  },
  {
    checkId: 'k8s.secretInEnv',
    name: 'k8s.secretInEnv',
    description:
      'Container exposes a likely secret via a literal env var (use secretKeyRef instead).',
    recommendation:
      'Move the value into a Kubernetes Secret and reference it via `valueFrom.secretKeyRef`.',
    severity: K8S_CATEGORY_SEVERITY['k8s.secretInEnv']!,
  },
  {
    checkId: 'k8s.latestImageTag',
    name: 'k8s.latestImageTag',
    description: 'Container image uses the `latest` tag (not pinned).',
    recommendation:
      'Pin the image tag to a SHA or version so deployments are reproducible.',
    severity: K8S_CATEGORY_SEVERITY['k8s.latestImageTag']!,
  },
  {
    checkId: 'k8s.missingProbes',
    name: 'k8s.missingProbes',
    description: 'Container declares neither readinessProbe nor livenessProbe.',
    recommendation:
      'Add a readiness and a liveness probe so the kubelet can route and restart the workload correctly.',
    severity: K8S_CATEGORY_SEVERITY['k8s.missingProbes']!,
  },
  {
    checkId: 'k8s.missingResourceLimits',
    name: 'k8s.missingResourceLimits',
    description: 'Container does not declare `resources.limits.memory`.',
    recommendation:
      'Set CPU and memory limits to prevent noisy-neighbour resource exhaustion.',
    severity: K8S_CATEGORY_SEVERITY['k8s.missingResourceLimits']!,
  },
];

/**
 * Map a builtin check id to a stable PolicyId. Used by the
 * SecurityService when there's no existing SecurityPolicy aggregate
 * for that check; we synthesize one with a deterministic id so
 * fingerprints and compliance mappings stay stable.
 */
export function builtinPolicyId(checkId: string): PolicyId {
  // 16-byte UUID-like deterministic id derived from the check id.
  // The pattern keeps it valid for our `parseId` regex.
  // Pads with `0`s for a stable shape.
  const padded = (
    checkId.replace(/[^a-z0-9]/gi, '').toLowerCase() + '00000000000000000000'
  ).slice(0, 32);
  const a = padded.slice(0, 8);
  const b = padded.slice(8, 12);
  const c = '4' + padded.slice(13, 16); // version 4 nibble
  const d = '8' + padded.slice(17, 20); // variant nibble
  const e = padded.slice(20, 32);
  return `${a}-${b}-${c}-${d}-${e}` as PolicyId;
}

interface SpecLike {
  containers?: ContainerLike[];
  initContainers?: ContainerLike[];
  hostNetwork?: boolean;
  hostPID?: boolean;
  hostIPC?: boolean;
  securityContext?: PodSecurityContextLike;
}

interface ContainerLike {
  name?: string;
  image?: string;
  securityContext?: ContainerSecurityContextLike;
  env?: Array<{
    name?: string;
    value?: string;
    valueFrom?: unknown;
  }>;
  readinessProbe?: unknown;
  livenessProbe?: unknown;
  resources?: {
    limits?: { memory?: string; cpu?: string };
    requests?: { memory?: string; cpu?: string };
  };
}

interface ContainerSecurityContextLike {
  privileged?: boolean;
  runAsNonRoot?: boolean;
  runAsUser?: number;
  allowPrivilegeEscalation?: boolean;
}

interface PodSecurityContextLike {
  runAsNonRoot?: boolean;
  runAsUser?: number;
}

interface NetworkPolicySpec {
  podSelector?: {
    matchLabels?: Record<string, string>;
  };
}

const SECRET_PATTERNS: Array<{ name: RegExp; valueExtra?: RegExp }> = [
  { name: /password/i },
  { name: /secret/i },
  { name: /token/i },
  { name: /api[-_]?key/i },
  { name: /private[-_]?key/i },
  // Heuristic: any value matching a JWT or AWS access key pattern.
  {
    name: /.*/,
    valueExtra: /^(eyJ[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{12,})/,
  },
];

function refOf(record: ScannerInput['records'][number]): ResourceRef {
  const ref: ResourceRef = {
    apiVersion: record.apiVersion,
    kind: record.kind,
    name: record.name,
  };
  if (record.namespace !== undefined) ref.namespace = record.namespace;
  return ref;
}

function evidenceFor(
  source: string,
  summary: string,
  data: Record<string, unknown>,
  capturedAt: string
): Evidence {
  return {
    source,
    summary,
    data,
    capturedAt: capturedAt as Evidence['capturedAt'],
  };
}

/**
 * Pure-TypeScript scanner. Stateless except for the clock injection.
 */
export class BuiltinPolicyScanner implements ScannerClient {
  readonly id = 'builtin-policy-scanner';
  /** Concurrency cap on per-record evaluation. */
  private readonly concurrency: number;

  constructor(
    private readonly clock: Clock,
    opts: { concurrency?: number } = {}
  ) {
    this.concurrency = opts.concurrency ?? 8;
  }

  async scan(input: ScannerInput): Promise<RawFinding[]> {
    const records = input.records;
    const findings: RawFinding[] = [];

    // Pre-build a map of NetworkPolicy → namespace + selector for the
    // network-policy-coverage check.
    const netPolByNs = new Map<string, NetworkPolicySpec[]>();
    for (const r of records) {
      if (r.kind === 'NetworkPolicy') {
        const ns = r.namespace ?? 'default';
        const list = netPolByNs.get(ns) ?? [];
        list.push((r.spec as NetworkPolicySpec) ?? {});
        netPolByNs.set(ns, list);
      }
    }

    // Resource-by-resource checks parallelised with a concurrency cap.
    const podRecords = records.filter(r => r.kind === 'Pod');
    const podBatches = chunk(podRecords, this.concurrency);
    const capturedAt = this.clock.nowInstant();

    for (const batch of podBatches) {
      const partial = await Promise.all(
        batch.map(async record => {
          const out: RawFinding[] = [];
          const spec = (record.spec as SpecLike) ?? {};
          const containers = ([] as ContainerLike[])
            .concat(spec.containers ?? [])
            .concat(spec.initContainers ?? []);

          // hostNetwork / hostPID / hostIPC
          if (spec.hostNetwork === true) {
            out.push(
              this.findingFor('k8s.hostNetwork', record, capturedAt, {})
            );
          }
          if (spec.hostPID === true) {
            out.push(this.findingFor('k8s.hostPID', record, capturedAt, {}));
          }
          if (spec.hostIPC === true) {
            out.push(this.findingFor('k8s.hostIPC', record, capturedAt, {}));
          }

          for (const c of containers) {
            // Privileged
            if (c.securityContext?.privileged === true) {
              out.push(
                this.findingFor('k8s.privileged', record, capturedAt, {
                  container: c.name ?? '',
                })
              );
            }
            // runAsNonRoot — flag if neither pod nor container declared
            const podRunAsNonRoot = spec.securityContext?.runAsNonRoot === true;
            const cRunAsNonRoot = c.securityContext?.runAsNonRoot === true;
            if (!podRunAsNonRoot && !cRunAsNonRoot) {
              out.push(
                this.findingFor('k8s.runAsRoot', record, capturedAt, {
                  container: c.name ?? '',
                })
              );
            }
            // missing memory limit
            if (
              c.resources?.limits?.memory === undefined ||
              c.resources.limits.memory === ''
            ) {
              out.push(
                this.findingFor(
                  'k8s.missingResourceLimits',
                  record,
                  capturedAt,
                  { container: c.name ?? '' }
                )
              );
            }
            // latest tag
            if (
              typeof c.image === 'string' &&
              (/:latest$/.test(c.image) || !/[:@]/.test(c.image))
            ) {
              out.push(
                this.findingFor('k8s.latestImageTag', record, capturedAt, {
                  container: c.name ?? '',
                  image: c.image,
                })
              );
            }
            // missing probes
            if (
              c.readinessProbe === undefined &&
              c.livenessProbe === undefined
            ) {
              out.push(
                this.findingFor('k8s.missingProbes', record, capturedAt, {
                  container: c.name ?? '',
                })
              );
            }
            // secret in env
            if (Array.isArray(c.env)) {
              for (const e of c.env) {
                const name = e.name ?? '';
                const value = typeof e.value === 'string' ? e.value : '';
                if (e.valueFrom !== undefined) continue; // OK pattern
                if (value === '') continue;
                if (looksLikeSecret(name, value)) {
                  out.push(
                    this.findingFor('k8s.secretInEnv', record, capturedAt, {
                      container: c.name ?? '',
                      envName: name,
                    })
                  );
                  break; // one per container is enough for the report
                }
              }
            }
          }
          return out;
        })
      );
      for (const arr of partial) findings.push(...arr);
    }

    // Network policy coverage — fire one finding per pod whose
    // namespace has zero NetworkPolicies.
    for (const record of podRecords) {
      const ns = record.namespace ?? 'default';
      if (!netPolByNs.has(ns) || netPolByNs.get(ns)!.length === 0) {
        findings.push(
          this.findingFor('k8s.missingNetworkPolicy', record, capturedAt, {
            namespace: ns,
          })
        );
      }
    }

    return findings;
  }

  private findingFor(
    checkId: string,
    record: ScannerInput['records'][number],
    capturedAt: string,
    data: Record<string, unknown>
  ): RawFinding {
    const policy = BUILTIN_POLICIES.find(p => p.checkId === checkId);
    if (!policy) {
      throw new Error(`unknown builtin policy: ${checkId}`);
    }
    return {
      policyId: builtinPolicyId(checkId),
      resource: refOf(record),
      severity: policy.severity,
      description: policy.description,
      recommendation: policy.recommendation,
      evidence: evidenceFor(
        this.id,
        `${policy.name} matched ${record.kind}/${record.name}`,
        data,
        capturedAt
      ),
    };
  }
}

function looksLikeSecret(name: string, value: string): boolean {
  for (const pat of SECRET_PATTERNS) {
    const matchName = pat.name.test(name);
    if (pat.valueExtra) {
      if (pat.valueExtra.test(value)) return true;
      continue;
    }
    if (matchName && value.length >= 8) return true;
  }
  return false;
}

function chunk<T>(arr: ReadonlyArray<T>, size: number): T[][] {
  if (size <= 0) return [arr.slice() as T[]];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size) as T[]);
  }
  return out;
}
