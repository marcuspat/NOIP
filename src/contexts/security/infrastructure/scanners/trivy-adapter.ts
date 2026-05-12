// TrivyAdapter — image-vulnerability scanner ACL.
//
// Real implementation shells out to the Trivy CLI:
//
//   trivy image --format json --quiet --severity LOW,MEDIUM,HIGH,CRITICAL \
//     <image-ref>
//
// Trivy JSON schema (abridged; see aquasecurity/trivy docs for the full
// shape) we consume:
//
//   {
//     "Results": [
//       {
//         "Target": "alpine:3.10 (alpine 3.10.9)",
//         "Class": "os-pkgs",
//         "Type": "alpine",
//         "Vulnerabilities": [
//           {
//             "VulnerabilityID": "CVE-2021-36159",
//             "PkgName": "apk-tools",
//             "InstalledVersion": "2.10.6-r0",
//             "FixedVersion": "2.10.7-r0",
//             "Severity": "CRITICAL",
//             "Title": "...",
//             "Description": "...",
//             "PrimaryURL": "...",
//             "CVSS": { "nvd": { "V3Score": 9.1 } }
//           }
//         ]
//       }
//     ]
//   }
//
// When `SECURITY_REAL_SCANNERS=true` and `SECURITY_REAL_TRIVY!=false`
// the adapter runs the CLI for every Pod container image found in the
// snapshot input. Otherwise `scan` returns `[]` so the composite
// scanner is a no-op for this adapter.

import type { Clock, PolicyId } from '../../../../shared/kernel';
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

export interface TrivyAdapterDeps {
  /** Override for tests; when unset we read process.env. */
  realScannersFlag?: () => boolean;
  /** Subprocess runner; defaults to NodeSubprocessRunner. */
  runner?: SubprocessRunner;
  /** Path/name of the binary; default `trivy`. */
  binary?: string;
  /** Per-invocation timeout in ms. Default 60_000. */
  timeoutMs?: number;
  /** Clock for evidence timestamps. */
  clock?: Clock;
  /**
   * If set, restrict scanning to these images (test override). When
   * unset, the adapter walks the snapshot input and extracts container
   * images from Pod specs.
   */
  imagesOverride?: ReadonlyArray<string>;
}

interface TrivyVulnerability {
  VulnerabilityID?: string;
  PkgName?: string;
  InstalledVersion?: string;
  FixedVersion?: string;
  Severity?: string;
  Title?: string;
  Description?: string;
  PrimaryURL?: string;
  CVSS?: Record<string, { V3Score?: number; V2Score?: number }>;
}

interface TrivyResult {
  Target?: string;
  Class?: string;
  Type?: string;
  Vulnerabilities?: TrivyVulnerability[];
}

interface TrivyReport {
  Results?: TrivyResult[];
}

/**
 * Maps a Trivy `Severity` string to our `Severity` ladder. Trivy emits
 * UPPERCASE strings; UNKNOWN/NEGLIGIBLE collapse to `low`.
 */
export function mapTrivySeverity(s: string | undefined): Severity {
  switch ((s ?? '').toUpperCase()) {
    case 'CRITICAL':
      return 'critical';
    case 'HIGH':
      return 'high';
    case 'MEDIUM':
      return 'medium';
    case 'LOW':
    case 'NEGLIGIBLE':
    case 'UNKNOWN':
    default:
      return 'low';
  }
}

export class TrivyAdapter implements ScannerClient {
  readonly id = 'trivy';
  private readonly realFlag: () => boolean;
  private readonly runner: SubprocessRunner;
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly clock: Clock | undefined;
  private readonly imagesOverride: ReadonlyArray<string> | undefined;

  constructor(deps: TrivyAdapterDeps = {}) {
    this.realFlag =
      deps.realScannersFlag ??
      (() =>
        process.env['SECURITY_REAL_SCANNERS'] === 'true' &&
        process.env['SECURITY_REAL_TRIVY'] !== 'false');
    this.runner = deps.runner ?? new NodeSubprocessRunner();
    this.binary = deps.binary ?? 'trivy';
    this.timeoutMs = deps.timeoutMs ?? 60_000;
    this.clock = deps.clock;
    this.imagesOverride = deps.imagesOverride;
  }

  async scan(input: ScannerInput): Promise<RawFinding[]> {
    if (!this.realFlag()) return [];
    const targets = this.imagesOverride
      ? this.imagesOverride
          .map(img => ({ image: img, ref: ANON_RESOURCE_REF }))
          .slice()
      : extractImageTargets(input);
    if (targets.length === 0) return [];

    const out: RawFinding[] = [];
    for (const target of targets) {
      const result = await this.runner.run({
        command: this.binary,
        args: [
          'image',
          '--format',
          'json',
          '--quiet',
          '--severity',
          'LOW,MEDIUM,HIGH,CRITICAL',
          target.image,
        ],
        timeoutMs: this.timeoutMs,
      });
      if (result.notFound) {
        throw new NotConfiguredError(`trivy binary not found: ${this.binary}`);
      }
      if (result.timedOut) {
        throw new BackpressureError('trivy timeout', { image: target.image });
      }
      if (result.exitCode !== 0) {
        throw new ProviderError(
          `trivy exit ${result.exitCode}: ${result.stderr.trim() || 'no stderr'}`,
          { image: target.image }
        );
      }
      let report: TrivyReport;
      try {
        report = JSON.parse(result.stdout) as TrivyReport;
      } catch {
        throw new ProviderError('trivy: unparseable-output', {
          image: target.image,
        });
      }
      const capturedAt = (this.clock?.nowInstant() ??
        new Date().toISOString()) as Evidence['capturedAt'];
      for (const r of report.Results ?? []) {
        for (const v of r.Vulnerabilities ?? []) {
          out.push(this.toRawFinding(v, target, capturedAt));
        }
      }
    }
    return out;
  }

  private toRawFinding(
    v: TrivyVulnerability,
    target: { image: string; ref: ResourceRef },
    capturedAt: Evidence['capturedAt']
  ): RawFinding {
    const severity = mapTrivySeverity(v.Severity);
    const cveId = v.VulnerabilityID ?? 'UNKNOWN';
    const evidence: Evidence = {
      source: 'trivy',
      summary: `${cveId} in ${v.PkgName ?? 'pkg'}@${v.InstalledVersion ?? '?'} (${target.image})`,
      data: {
        image: target.image,
        cveId,
        pkgName: v.PkgName ?? null,
        installedVersion: v.InstalledVersion ?? null,
        fixedVersion: v.FixedVersion ?? null,
        primaryUrl: v.PrimaryURL ?? null,
      },
      capturedAt,
    };
    const description = v.Title ?? v.Description ?? cveId;
    const recommendation =
      v.FixedVersion !== undefined && v.FixedVersion !== ''
        ? `Upgrade ${v.PkgName ?? 'package'} to ${v.FixedVersion}.`
        : `Track ${cveId} until a fixed version is available.`;
    return {
      policyId: trivyPolicyId(cveId),
      resource: target.ref,
      severity,
      description,
      recommendation,
      evidence,
    };
  }
}

const ANON_RESOURCE_REF: ResourceRef = {
  apiVersion: 'v1',
  kind: 'Image',
  name: 'unknown',
};

interface PodContainerLike {
  name?: string;
  image?: string;
}
interface PodSpecLike {
  containers?: PodContainerLike[];
  initContainers?: PodContainerLike[];
}

/**
 * Walks the snapshot input and emits one scan target per unique
 * image found in any Pod's containers/initContainers, retaining the
 * resource ref of the first Pod that uses it.
 */
export function extractImageTargets(
  input: ScannerInput
): Array<{ image: string; ref: ResourceRef }> {
  const seen = new Map<string, ResourceRef>();
  for (const r of input.records) {
    if (r.kind !== 'Pod') continue;
    const spec = (r.spec as PodSpecLike) ?? {};
    const containers = ([] as PodContainerLike[])
      .concat(spec.containers ?? [])
      .concat(spec.initContainers ?? []);
    for (const c of containers) {
      const img = typeof c.image === 'string' ? c.image : '';
      if (!img) continue;
      if (seen.has(img)) continue;
      const ref: ResourceRef = {
        apiVersion: r.apiVersion,
        kind: r.kind,
        name: r.name,
      };
      if (r.namespace !== undefined) ref.namespace = r.namespace;
      seen.set(img, ref);
    }
  }
  return Array.from(seen.entries()).map(([image, ref]) => ({ image, ref }));
}

/**
 * Stable PolicyId for a CVE id. We use `cve.<id>` as the synthetic
 * check id so the existing `builtinPolicyId` shape stays compatible
 * with `Finding.fingerprintFor` and the policy index in the engine.
 */
export function trivyPolicyId(cveId: string): PolicyId {
  return builtinPolicyId(`cve.${cveId}`);
}
