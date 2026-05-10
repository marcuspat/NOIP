// DriftCalculator — diff two `ResourceSnapshot`s and emit a JSON-Patch
// minus the dangerous bits (we don't emit `move` / `copy` / `test`).
//
// Scope of the diff:
//   - For resources that exist in `prev` and not in `curr`: a single
//     `{ op: 'remove' }` patch covering the whole record.
//   - For resources new in `curr`: a single `{ op: 'add' }` covering
//     the whole record.
//   - For resources in both: a recursive structural diff over `spec`,
//     `status`, `labels`, `annotations`. We do NOT diff `apiVersion`
//     or `kind` — a kind change is treated as delete+add.
//
// Severity policy is intentionally tiny and table-driven; the SOC will
// extend it via `customRules` in later phases.

import type { Clock } from '../../../shared/kernel';
import { ResourceSnapshot } from './resource-snapshot';
import { DriftReport } from './drift-report';
import type {
  JSONPatchOp,
  KubernetesResourceRecord,
  ResourceChange,
  ResourceRef,
  Severity,
} from './value-objects';

interface SeverityRule {
  match: (op: JSONPatchOp, record: KubernetesResourceRecord | null) => boolean;
  severity: Severity;
  rationale: string;
}

const DEFAULT_RULES: ReadonlyArray<SeverityRule> = [
  {
    // Privilege escalation on a Pod is the headline finding in DDD-06.
    match: (op, rec) =>
      rec?.kind === 'Pod' &&
      /\/spec\/containers\/\d+\/securityContext\/privileged/.test(op.path),
    severity: 'high',
    rationale: 'pod container privileged flag changed',
  },
  {
    // Replica scale change: low because intentional rollouts are common.
    match: (op, rec) =>
      rec?.kind === 'Deployment' && op.path === '/spec/replicas',
    severity: 'low',
    rationale: 'deployment replicas changed',
  },
  {
    // Image swap on any workload kind. Medium because it's the common
    // case for rollouts but also the common case for a supply-chain
    // compromise to land.
    match: (op, rec) =>
      (rec?.kind === 'Pod' ||
        rec?.kind === 'Deployment' ||
        rec?.kind === 'StatefulSet' ||
        rec?.kind === 'DaemonSet') &&
      /\/image$/.test(op.path),
    severity: 'medium',
    rationale: 'container image changed',
  },
  {
    // RBAC additions land at high — even within an existing role.
    match: (_op, rec) =>
      rec?.kind === 'ClusterRoleBinding' || rec?.kind === 'RoleBinding',
    severity: 'high',
    rationale: 'rbac binding changed',
  },
];

function severityFor(
  op: JSONPatchOp,
  record: KubernetesResourceRecord | null,
  rules: ReadonlyArray<SeverityRule>
): { severity: Severity; rationale?: string } {
  for (const rule of rules) {
    if (rule.match(op, record)) {
      return { severity: rule.severity, rationale: rule.rationale };
    }
  }
  // Default policy: label/annotation tweaks are low; everything else is
  // medium so the SOC sees something they can actually triage.
  if (op.path.startsWith('/labels') || op.path.startsWith('/annotations')) {
    return { severity: 'low' };
  }
  return { severity: 'medium' };
}

function refKey(ref: ResourceRef): string {
  return `${ref.apiVersion}|${ref.kind}|${ref.namespace ?? ''}|${ref.name}`;
}

function recordRef(r: KubernetesResourceRecord): ResourceRef {
  const ref: ResourceRef = {
    apiVersion: r.apiVersion,
    kind: r.kind,
    name: r.name,
  };
  if (r.namespace !== undefined) ref.namespace = r.namespace;
  return ref;
}

function escapePathSegment(seg: string): string {
  // RFC 6901: ~ → ~0, / → ~1
  return seg.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Recursive diff over plain JSON values. Returns a flat list of
 * patches. Path uses RFC 6901 fragment encoding rooted at `prefix`.
 */
function diffValue(
  prev: unknown,
  curr: unknown,
  prefix: string,
  out: JSONPatchOp[]
): void {
  if (prev === curr) return;
  // Primitive replace / null handling.
  const prevIsObj =
    prev !== null && typeof prev === 'object' && !Array.isArray(prev);
  const currIsObj =
    curr !== null && typeof curr === 'object' && !Array.isArray(curr);
  const prevIsArr = Array.isArray(prev);
  const currIsArr = Array.isArray(curr);

  if (prevIsArr && currIsArr) {
    const a = prev as unknown[];
    const b = curr as unknown[];
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const childPath = `${prefix}/${i}`;
      if (i >= a.length) {
        out.push({ op: 'add', path: childPath, value: b[i] });
      } else if (i >= b.length) {
        out.push({ op: 'remove', path: childPath });
      } else {
        diffValue(a[i], b[i], childPath, out);
      }
    }
    return;
  }

  if (prevIsObj && currIsObj) {
    const a = prev as Record<string, unknown>;
    const b = curr as Record<string, unknown>;
    const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const childPath = `${prefix}/${escapePathSegment(k)}`;
      if (!(k in a)) {
        out.push({ op: 'add', path: childPath, value: b[k] });
      } else if (!(k in b)) {
        out.push({ op: 'remove', path: childPath });
      } else {
        diffValue(a[k], b[k], childPath, out);
      }
    }
    return;
  }

  // Type mismatch or primitive change → replace.
  out.push({ op: 'replace', path: prefix, value: curr });
}

/**
 * Per-record diff. Compares the four "interesting" buckets
 * (`labels`, `annotations`, `spec`, `status`) so foreign metadata
 * doesn't cause false positives.
 */
function diffRecords(
  prev: KubernetesResourceRecord,
  curr: KubernetesResourceRecord
): JSONPatchOp[] {
  const out: JSONPatchOp[] = [];
  diffValue(prev.labels, curr.labels, '/labels', out);
  diffValue(prev.annotations, curr.annotations, '/annotations', out);
  diffValue(prev.spec, curr.spec, '/spec', out);
  diffValue(prev.status, curr.status, '/status', out);
  return out;
}

export interface DriftCalculatorOptions {
  /**
   * Append-only extension hook for the SOC. Higher-priority rules
   * win the first-match race; defaults are appended last.
   */
  customRules?: SeverityRule[];
}

export class DriftCalculator {
  private readonly rules: ReadonlyArray<SeverityRule>;

  constructor(opts?: DriftCalculatorOptions) {
    this.rules = [...(opts?.customRules ?? []), ...DEFAULT_RULES];
  }

  /**
   * Compares two snapshots. Returns `null` when the hashes match
   * (cheap fast-path) or there are zero changes. Otherwise returns a
   * `DriftReport` ready to persist; the caller must publish events
   * after a successful save.
   */
  compare(
    prev: ResourceSnapshot,
    curr: ResourceSnapshot,
    clock: Clock
  ): DriftReport | null {
    if (prev.hash === curr.hash) return null;
    if (prev.clusterId !== curr.clusterId) {
      // Defence in depth — should never happen if callers obey the
      // (clusterId, takenAt) repository contract.
      return null;
    }

    const prevByKey = new Map<string, KubernetesResourceRecord>();
    for (const r of prev.records) {
      prevByKey.set(refKey(recordRef(r)), r);
    }
    const currByKey = new Map<string, KubernetesResourceRecord>();
    for (const r of curr.records) {
      currByKey.set(refKey(recordRef(r)), r);
    }

    const changes: ResourceChange[] = [];

    // Created or updated.
    for (const [key, currRec] of currByKey) {
      const prevRec = prevByKey.get(key);
      if (prevRec === undefined) {
        const change: ResourceChange = {
          kind: 'created',
          ref: recordRef(currRec),
          patch: [{ op: 'add', path: '', value: currRec }],
          severity: severityFor(
            { op: 'add', path: '', value: currRec },
            currRec,
            this.rules
          ).severity,
        };
        changes.push(change);
        continue;
      }
      const patch = diffRecords(prevRec, currRec);
      if (patch.length === 0) continue;
      // Aggregate severity: first matching rule wins per-op; record
      // takes the worst across its ops.
      let recSeverity: Severity = 'low';
      let rationale: string | undefined;
      for (const op of patch) {
        const sev = severityFor(op, currRec, this.rules);
        if (sev.severity === 'critical') {
          recSeverity = 'critical';
          rationale = sev.rationale;
          break;
        }
        if (rankOf(sev.severity) > rankOf(recSeverity)) {
          recSeverity = sev.severity;
          if (sev.rationale !== undefined) rationale = sev.rationale;
        }
      }
      const change: ResourceChange = {
        kind: 'updated',
        ref: recordRef(currRec),
        patch,
        severity: recSeverity,
      };
      if (rationale !== undefined) change.rationale = rationale;
      changes.push(change);
    }

    // Deleted.
    for (const [key, prevRec] of prevByKey) {
      if (currByKey.has(key)) continue;
      const change: ResourceChange = {
        kind: 'deleted',
        ref: recordRef(prevRec),
        patch: [{ op: 'remove', path: '' }],
        severity: severityFor({ op: 'remove', path: '' }, prevRec, this.rules)
          .severity,
      };
      changes.push(change);
    }

    if (changes.length === 0) return null;

    return DriftReport.create({
      clusterId: curr.clusterId,
      previous: prev.id,
      current: curr.id,
      changes,
      clock,
    });
  }
}

function rankOf(s: Severity): number {
  switch (s) {
    case 'critical':
      return 4;
    case 'high':
      return 3;
    case 'medium':
      return 2;
    case 'low':
      return 1;
  }
}
