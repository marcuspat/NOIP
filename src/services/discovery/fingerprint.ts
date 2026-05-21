import { createHash } from 'crypto';
import { KubernetesResource } from '../../types';
import { ResourceRecord } from '../../models/snapshot.model';
import { DriftItem, DriftSeverity } from '../../models/drift-report.model';

/**
 * Fields excluded from the canonical fingerprint so that ephemeral changes
 * (resourceVersion, generation, managedFields, status) don't produce false-positive drift.
 */
const VOLATILE_METADATA_KEYS = new Set([
  'resourceVersion',
  'generation',
  'managedFields',
  'uid',
  'creationTimestamp',
]);

function omitVolatile(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!VOLATILE_METADATA_KEYS.has(k)) {
      out[k] = v;
    }
  }
  return out;
}

/** Recursively sort object keys so JSON serialization is deterministic. */
function sortedKeys(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(sortedKeys);
  if (val !== null && typeof val === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(val as Record<string, unknown>).sort()) {
      sorted[k] = sortedKeys((val as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return val;
}

/** Produce a stable, deterministic JSON from a resource for hashing. */
export function canonicalizeResource(resource: KubernetesResource): string {
  const stable = {
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    metadata: omitVolatile(resource.metadata as unknown as Record<string, unknown>),
    spec: resource.spec ?? null,
  };
  return JSON.stringify(sortedKeys(stable));
}

/** SHA-256 hex digest of the canonical form. */
export function fingerprintResource(resource: KubernetesResource): string {
  return createHash('sha256').update(canonicalizeResource(resource)).digest('hex');
}

function resourceKey(r: Pick<ResourceRecord, 'apiVersion' | 'kind' | 'namespace' | 'name'>): string {
  return `${r.apiVersion}/${r.kind}/${r.namespace ?? ''}/${r.name}`;
}

function inferSeverity(kind: string, changeType: 'added' | 'removed' | 'modified'): DriftSeverity {
  const critical = new Set(['ClusterRole', 'ClusterRoleBinding', 'Role', 'RoleBinding', 'NetworkPolicy']);
  const high = new Set(['Deployment', 'DaemonSet', 'StatefulSet', 'Secret', 'ConfigMap']);
  if (critical.has(kind)) return changeType === 'removed' ? 'critical' : 'high';
  if (high.has(kind)) return 'medium';
  return 'low';
}

/**
 * Compare two ordered snapshots and return the list of drift items.
 * Pure function — no I/O.
 */
export function computeDrift(
  baseline: ResourceRecord[],
  current: ResourceRecord[]
): DriftItem[] {
  const baselineMap = new Map(baseline.map(r => [resourceKey(r), r]));
  const currentMap = new Map(current.map(r => [resourceKey(r), r]));
  const items: DriftItem[] = [];

  // Removed and modified
  for (const [key, base] of baselineMap) {
    const cur = currentMap.get(key);
    if (!cur) {
      items.push({
        resourceKind: base.kind,
        resourceName: base.name,
        namespace: base.namespace,
        changeType: 'removed',
        severity: inferSeverity(base.kind, 'removed'),
        previousFingerprint: base.fingerprint,
        diff: { removed: true },
      });
    } else if (cur.fingerprint !== base.fingerprint) {
      items.push({
        resourceKind: base.kind,
        resourceName: base.name,
        namespace: base.namespace,
        changeType: 'modified',
        severity: inferSeverity(base.kind, 'modified'),
        previousFingerprint: base.fingerprint,
        currentFingerprint: cur.fingerprint,
        diff: { specChanged: true },
      });
    }
  }

  // Added
  for (const [key, cur] of currentMap) {
    if (!baselineMap.has(key)) {
      items.push({
        resourceKind: cur.kind,
        resourceName: cur.name,
        namespace: cur.namespace,
        changeType: 'added',
        severity: inferSeverity(cur.kind, 'added'),
        currentFingerprint: cur.fingerprint,
        diff: { added: true },
      });
    }
  }

  return items;
}
