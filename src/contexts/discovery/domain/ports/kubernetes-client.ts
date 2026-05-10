// Domain port for the kube apiserver. The infrastructure-side
// `KubernetesAdapter` (DDD-16) is the only implementation that ships;
// tests substitute an in-memory fake so the application service can be
// exercised without a cluster.

import type { Scope, KubernetesResourceRecord } from '../value-objects';

/** Spec used by `getCluster` — the production adapter ignores most
 * fields because the in-cluster client already knows how to dial home.
 */
export interface ClusterSpec {
  endpoint?: string;
  kubeconfigPath?: string;
}

/**
 * Snapshot of cluster-level metadata, kept compatible with the legacy
 * `ClusterInfo` HTTP type so the existing dashboard widgets keep
 * rendering through the migration.
 */
export interface ClusterInfoView {
  name: string;
  endpoint: string;
  version: string;
  nodeCount: number;
  namespaceCount: number;
  podCount: number;
  serviceCount: number;
  lastScan: Date;
}

export interface NodeInfoView {
  name: string;
  status: string;
  roles: string[];
  version: string;
  osImage: string;
  kernelVersion: string;
  cpuCapacity: string;
  memoryCapacity: string;
}

/**
 * The port. All methods translate kube-client errors to the typed
 * domain errors in `src/shared/errors`. Foreign types (`V1Pod`,
 * `KubeConfig`, …) never escape implementations of this interface.
 */
export interface KubernetesClient {
  /**
   * Streams every resource matching `scope`. The adapter paginates
   * via `limit` + `continue` tokens internally; the consumer just
   * iterates.
   */
  listResources(scope: Scope): AsyncIterable<KubernetesResourceRecord>;

  getCluster(spec: ClusterSpec): Promise<ClusterInfoView>;
  getNamespaces(): Promise<string[]>;
  getNodeInfo(): Promise<NodeInfoView[]>;
}
