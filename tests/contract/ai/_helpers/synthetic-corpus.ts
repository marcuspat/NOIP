// Synthetic RAG corpus used by the Chroma contract suite.
//
// Properties intentionally preserved:
//   - 30 documents, balanced across 3 topics (10 each).
//   - Each doc id is `sha256(content).slice(0, 16)` — stable and
//     idempotent on re-ingestion (matches ADR-0013's dedupe-by-content
//     contract).
//   - Each doc body is 200-500 chars of plausibly relevant text so a real
//     embedding model can still cluster meaningfully.
//   - Metadata includes `topic`, `severity`, and a `tags` array.
//
// All randomness is seeded by content; no Date.now / crypto.randomBytes
// inside the corpus generator. That makes contract assertions stable
// across runs.

import { createHash } from 'node:crypto';
import type { RagDocumentInput } from '../../../../src/contexts/ai/domain/ports/rag-store';

export interface SyntheticDoc extends RagDocumentInput {
  id: string;
  content: string;
  metadata: {
    topic: 'k8s-security' | 'compliance' | 'performance';
    severity: 'low' | 'medium' | 'high' | 'critical';
    tags: string[];
  };
}

/** Stable id from content. 16 hex chars is enough for 30-50 docs without collision. */
export function corpusId(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

const K8S_SEEDS = [
  'Privileged containers grant root-equivalent access to the host kernel and should be disallowed by Pod Security Admission. Restrict via the restricted profile and audit any namespace that exempts it.',
  'Run containers as non-root by setting securityContext.runAsNonRoot=true and runAsUser to a high UID. Avoid mounting the docker socket; it bypasses every other control.',
  'Disable hostPath volumes for workload pods. They escape namespace isolation and let a compromised pod read or write arbitrary node files.',
  'NetworkPolicies should default-deny ingress and egress. Allow-list only required service-to-service traffic. Without a CNI that enforces them, policies are silently ignored.',
  'Service accounts mounted by default expose tokens to every pod. Set automountServiceAccountToken=false unless the workload needs the API.',
  'Image pull secrets must be scoped per namespace. A leaked secret in kube-system grants registry access to every team.',
  'Seccomp profiles in the RuntimeDefault mode block unused syscalls. Combined with AppArmor or SELinux this dramatically narrows kernel attack surface.',
  'RBAC bindings to cluster-admin should be rare and audited monthly. Prefer namespace-scoped roles and groups for human access.',
  'Disable the legacy ABAC authorizer; rely on RBAC and Webhook only. ABAC policies on disk are easy to forget and trivial to misconfigure.',
  'API server audit logs at the Metadata level miss request bodies that contain secrets. RequestResponse on sensitive resources is worth the storage.',
];

const COMPLIANCE_SEEDS = [
  'SOC 2 CC6.1 requires logical access controls that restrict access to information assets. Map each Kubernetes namespace to a business owner and review quarterly.',
  'PCI DSS 8.3 mandates multi-factor authentication for all non-console administrative access. Tie SSH and kubectl exec to an SSO bastion that enforces MFA.',
  'HIPAA Security Rule 164.312(a)(1) requires unique user identification. Service accounts are not exempt — name them per workload and rotate keys yearly.',
  'ISO 27001 A.12.4.1 logs of user activities must be produced, kept, and regularly reviewed. Centralise kubelet, etcd, and API server logs to an immutable store.',
  'FedRAMP Moderate AC-2 (account management) requires automatic disabling of inactive accounts. Tie identity provider to HR offboarding so revocation is immediate.',
  'NIST 800-53 SI-4 system monitoring requires continuous detection of unauthorised access. EDR on worker nodes plus runtime threat detection in clusters is the baseline.',
  'GDPR Art. 32 demands a level of security appropriate to the risk including pseudonymisation and encryption. Encrypt etcd at rest and rotate the KMS key annually.',
  'CIS Kubernetes Benchmark 5.1.3 minimise wildcard use in Roles and ClusterRoles. Replace verbs:["*"] with explicit lists; the audit log will tell you which verbs are actually needed.',
  'SOC 2 CC7.2 system operations require detection of anomalies. Establish a baseline of expected pod churn per namespace and alert when it doubles.',
  'PCI DSS 10.5 secures audit trails so they cannot be altered. Ship Kubernetes audit events to a write-once store within five minutes of generation.',
];

const PERFORMANCE_SEEDS = [
  'CPU throttling on worker nodes shows up as elevated p99 latency without saturated CPU averages. Watch container_cpu_cfs_throttled_seconds_total, not just usage.',
  'JVM workloads on Kubernetes need explicit -XX:MaxRAMPercentage. Without it the JVM sees the host RAM and OOM-kills are common when the cgroup limit hits.',
  'etcd performance is the floor on every Kubernetes operation. Provision NVMe disks, keep wal_fsync_duration_seconds p99 under 10ms, and never co-locate with the API server.',
  'kube-proxy in iptables mode degrades with thousands of services. Switch to IPVS or to a dataplane-aware CNI like Cilium for sub-millisecond service lookups.',
  'Vertical Pod Autoscaler recommendations are based on rolling 8-day windows. Verify they match peak hours before applying or your batch jobs will OOM at 3am.',
  'Horizontal Pod Autoscaler with custom metrics requires the metrics API and a stable signal. Use 95th percentile latency, not request rate, to scale latency-sensitive services.',
  'Network throughput cap on cloud nodes is often the bottleneck before CPU. Bench with iperf3 across AZs before assuming the application is slow.',
  'A noisy neighbour pod can starve kubelet itself. Reserve resources via kubeReserved and systemReserved on every node template.',
  'DNS lookups inside the cluster hit CoreDNS through every pod resolver. Cache locally with NodeLocal DNSCache or accept tail-latency cliffs at scale.',
  'Pod startup latency dominates rolling deploys. Pre-pull large images via DaemonSet and watch image_pull_duration_seconds — it explains most slow rollouts.',
];

const TOPIC_FILLER: Record<SyntheticDoc['metadata']['topic'], string> = {
  'k8s-security':
    ' Context: kubernetes hardening guidance, pod security admission, RBAC review, attack surface reduction, and defence-in-depth across the control plane and worker fleet.',
  compliance:
    ' Context: compliance program guidance, control mapping, evidence collection, auditor review, and recurring assessment of policy enforcement effectiveness.',
  performance:
    ' Context: performance engineering guidance, capacity planning, p95 and p99 latency tracking, throughput budgets, and saturation alerting across services.',
};

/**
 * Pad a seed up to at least 200 chars (spec requires 200-500). We append
 * a topic-stable filler sentence so embeddings still cluster on topic.
 */
function padSeed(
  seed: string,
  topic: SyntheticDoc['metadata']['topic']
): string {
  const filler = TOPIC_FILLER[topic];
  let out = seed;
  while (out.length < 200) out += filler;
  if (out.length > 500) out = out.slice(0, 500);
  return out;
}

function buildDocs(): SyntheticDoc[] {
  const out: SyntheticDoc[] = [];
  const push = (
    topic: SyntheticDoc['metadata']['topic'],
    seed: string,
    severity: SyntheticDoc['metadata']['severity'],
    tags: string[]
  ): void => {
    const content = padSeed(seed, topic);
    out.push({
      id: corpusId(content),
      content,
      metadata: { topic, severity, tags },
    });
  };
  const severities: SyntheticDoc['metadata']['severity'][] = [
    'low',
    'medium',
    'high',
    'critical',
  ];
  K8S_SEEDS.forEach((c, i) =>
    push('k8s-security', c, severities[i % severities.length] ?? 'medium', [
      'kubernetes',
      'security',
    ])
  );
  COMPLIANCE_SEEDS.forEach((c, i) =>
    push('compliance', c, severities[i % severities.length] ?? 'medium', [
      'compliance',
      'audit',
    ])
  );
  PERFORMANCE_SEEDS.forEach((c, i) =>
    push('performance', c, severities[i % severities.length] ?? 'medium', [
      'performance',
      'observability',
    ])
  );
  return out;
}

const CACHED_CORPUS = buildDocs();

/**
 * Returns the canonical 30-doc corpus. The same array is returned each
 * time so referential identity is stable across calls within a test run.
 */
export function syntheticCorpus(): readonly SyntheticDoc[] {
  return CACHED_CORPUS;
}

/**
 * Build a fresh batch of `count` extra documents that do NOT overlap the
 * canonical corpus. Used by the concurrent-ingest test. The `salt`
 * argument makes ids stable across workers.
 */
export function extraDocs(count: number, salt: string): SyntheticDoc[] {
  const base = `Extra synthetic document for concurrent ingest test. salt=${salt}. `;
  const out: SyntheticDoc[] = [];
  for (let i = 0; i < count; i++) {
    const content =
      base +
      `Iteration ${i}. ` +
      'It must be at least two hundred characters so embeddings cluster sensibly. ' +
      'Adding filler about kubernetes, compliance, and performance keeps topic ' +
      'distribution mixed without colliding with the curated corpus seeds.';
    out.push({
      id: corpusId(content),
      content,
      metadata: {
        topic: 'k8s-security',
        severity: 'low',
        tags: ['synthetic', 'concurrent'],
      },
    });
  }
  return out;
}

/**
 * Build a deterministic single document of approximately `sizeBytes`
 * length. Used by the large-payload contract test.
 */
export function largeDoc(sizeBytes: number, marker: string): SyntheticDoc {
  const block =
    'kubernetes admission controller policy enforcement audit trail compliance ';
  const repeat = Math.max(1, Math.ceil(sizeBytes / block.length));
  const content = (`MARKER=${marker} ` + block.repeat(repeat)).slice(
    0,
    sizeBytes
  );
  return {
    id: corpusId(content),
    content,
    metadata: {
      topic: 'k8s-security',
      severity: 'high',
      tags: ['large-payload', marker],
    },
  };
}

/** Topic count utility for test assertions. */
export function topicCounts(
  docs: readonly SyntheticDoc[]
): Record<SyntheticDoc['metadata']['topic'], number> {
  const counts = {
    'k8s-security': 0,
    compliance: 0,
    performance: 0,
  };
  for (const d of docs) counts[d.metadata.topic] += 1;
  return counts;
}
