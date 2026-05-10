// Wires `@kubernetes/client-node` into the `RawKubernetesClient`
// abstraction the adapter consumes. The split keeps the kube-client
// dependency isolated to one file: tests stub `RawKubernetesClient`
// directly without ever loading `@kubernetes/client-node`.
//
// Authentication strategy (in order of precedence):
//   1. Explicit `kubeconfigPath` — load from file.
//   2. `inCluster=true` — load from the service-account token mounted
//      at `/var/run/secrets/kubernetes.io/serviceaccount/`.
//   3. Auto-detect: `loadFromDefault()`, which honours `KUBECONFIG`
//      and the in-cluster mounts depending on environment.

import {
  KubeConfig,
  CoreV1Api,
  AppsV1Api,
  type V1Pod,
  type V1Service,
  type V1ConfigMap,
  type V1Namespace,
  type V1Node,
  type V1Deployment,
  type V1StatefulSet,
  type V1DaemonSet,
} from '@kubernetes/client-node';
import type {
  RawKubernetesClient,
  RawListPage,
  RawKubeObject,
  KindRef,
} from './kubernetes-adapter';
import type { NodeInfoView } from '../../domain/ports/kubernetes-client';

export interface KubernetesClientFactoryOptions {
  kubeconfigPath?: string;
  inCluster?: boolean;
}

interface KubeListResp<T> {
  items: T[];
  metadata?: { continue?: string };
}

/**
 * Translates a `V1Node` to `NodeInfoView`. Pulls the few fields the
 * legacy HTTP type carried; everything else is dropped.
 */
function nodeToView(n: V1Node): NodeInfoView {
  const status = n.status?.conditions?.find(c => c.type === 'Ready');
  const labels = n.metadata?.labels ?? {};
  const roles: string[] = Object.keys(labels)
    .filter(k => k.startsWith('node-role.kubernetes.io/'))
    .map(k => k.substring('node-role.kubernetes.io/'.length))
    .filter(s => s.length > 0);
  return {
    name: n.metadata?.name ?? 'unknown',
    status: status?.status === 'True' ? 'Ready' : 'NotReady',
    roles,
    version: n.status?.nodeInfo?.kubeletVersion ?? 'unknown',
    osImage: n.status?.nodeInfo?.osImage ?? 'unknown',
    kernelVersion: n.status?.nodeInfo?.kernelVersion ?? 'unknown',
    cpuCapacity: String(n.status?.capacity?.['cpu'] ?? 'unknown'),
    memoryCapacity: String(n.status?.capacity?.['memory'] ?? 'unknown'),
  };
}

export class KubernetesClientFactory implements RawKubernetesClient {
  private readonly core: CoreV1Api;
  private readonly apps: AppsV1Api;
  private readonly endpoint: string;
  private readonly clusterName: string;

  private constructor(kc: KubeConfig) {
    this.core = kc.makeApiClient(CoreV1Api);
    this.apps = kc.makeApiClient(AppsV1Api);
    const ctx = kc.getCurrentCluster();
    this.endpoint = ctx?.server ?? 'unknown';
    this.clusterName = ctx?.name ?? 'unknown';
  }

  /**
   * Loads kube config and constructs a factory. Throws if no
   * configuration can be discovered.
   */
  static fromConfig(
    opts: KubernetesClientFactoryOptions = {}
  ): KubernetesClientFactory {
    const kc = new KubeConfig();
    if (opts.kubeconfigPath) {
      kc.loadFromFile(opts.kubeconfigPath);
    } else if (opts.inCluster) {
      kc.loadFromCluster();
    } else {
      kc.loadFromDefault();
    }
    return new KubernetesClientFactory(kc);
  }

  // ---------------------------------------------------------------------------
  // RawKubernetesClient
  // ---------------------------------------------------------------------------
  async listKinds(): Promise<KindRef[]> {
    // The 0.21 client doesn't expose `/apis` discovery directly. For
    // now we return the static set the adapter ships with — the
    // application service treats discovery as an opt-in feature
    // (`discoverKinds: false`).
    return [
      { apiVersion: 'v1', kind: 'Node', namespaced: false },
      { apiVersion: 'v1', kind: 'Namespace', namespaced: false },
      { apiVersion: 'v1', kind: 'Pod', namespaced: true },
      { apiVersion: 'v1', kind: 'Service', namespaced: true },
      { apiVersion: 'v1', kind: 'ConfigMap', namespaced: true },
      { apiVersion: 'apps/v1', kind: 'Deployment', namespaced: true },
      { apiVersion: 'apps/v1', kind: 'StatefulSet', namespaced: true },
      { apiVersion: 'apps/v1', kind: 'DaemonSet', namespaced: true },
    ];
  }

  async listKindPage(args: {
    kind: KindRef;
    namespace?: string;
    labelSelector?: string;
    limit: number;
    continueToken?: string;
  }): Promise<RawListPage> {
    const { kind, namespace, labelSelector, limit, continueToken } = args;
    let list: KubeListResp<RawKubeObject>;

    // Dispatch to the kind-specific list call. We support the
    // workload kinds the default policy depends on; everything else
    // returns an empty page so the adapter degrades gracefully.
    if (kind.kind === 'Pod') {
      const resp = namespace
        ? await this.core.listNamespacedPod(
            namespace,
            undefined,
            undefined,
            continueToken,
            undefined,
            labelSelector,
            limit
          )
        : await this.core.listPodForAllNamespaces(
            undefined,
            continueToken,
            undefined,
            labelSelector,
            limit
          );
      list = resp.body as KubeListResp<V1Pod> as KubeListResp<RawKubeObject>;
    } else if (kind.kind === 'Service') {
      const resp = namespace
        ? await this.core.listNamespacedService(
            namespace,
            undefined,
            undefined,
            continueToken,
            undefined,
            labelSelector,
            limit
          )
        : await this.core.listServiceForAllNamespaces(
            undefined,
            continueToken,
            undefined,
            labelSelector,
            limit
          );
      list =
        resp.body as KubeListResp<V1Service> as KubeListResp<RawKubeObject>;
    } else if (kind.kind === 'ConfigMap') {
      const resp = namespace
        ? await this.core.listNamespacedConfigMap(
            namespace,
            undefined,
            undefined,
            continueToken,
            undefined,
            labelSelector,
            limit
          )
        : await this.core.listConfigMapForAllNamespaces(
            undefined,
            continueToken,
            undefined,
            labelSelector,
            limit
          );
      list =
        resp.body as KubeListResp<V1ConfigMap> as KubeListResp<RawKubeObject>;
    } else if (kind.kind === 'Namespace') {
      const resp = await this.core.listNamespace(
        undefined,
        undefined,
        continueToken,
        undefined,
        labelSelector,
        limit
      );
      list =
        resp.body as KubeListResp<V1Namespace> as KubeListResp<RawKubeObject>;
    } else if (kind.kind === 'Node') {
      const resp = await this.core.listNode(
        undefined,
        undefined,
        continueToken,
        undefined,
        labelSelector,
        limit
      );
      list = resp.body as KubeListResp<V1Node> as KubeListResp<RawKubeObject>;
    } else if (kind.kind === 'Deployment') {
      const resp = namespace
        ? await this.apps.listNamespacedDeployment(
            namespace,
            undefined,
            undefined,
            continueToken,
            undefined,
            labelSelector,
            limit
          )
        : await this.apps.listDeploymentForAllNamespaces(
            undefined,
            continueToken,
            undefined,
            labelSelector,
            limit
          );
      list =
        resp.body as KubeListResp<V1Deployment> as KubeListResp<RawKubeObject>;
    } else if (kind.kind === 'StatefulSet') {
      const resp = namespace
        ? await this.apps.listNamespacedStatefulSet(
            namespace,
            undefined,
            undefined,
            continueToken,
            undefined,
            labelSelector,
            limit
          )
        : await this.apps.listStatefulSetForAllNamespaces(
            undefined,
            continueToken,
            undefined,
            labelSelector,
            limit
          );
      list =
        resp.body as KubeListResp<V1StatefulSet> as KubeListResp<RawKubeObject>;
    } else if (kind.kind === 'DaemonSet') {
      const resp = namespace
        ? await this.apps.listNamespacedDaemonSet(
            namespace,
            undefined,
            undefined,
            continueToken,
            undefined,
            labelSelector,
            limit
          )
        : await this.apps.listDaemonSetForAllNamespaces(
            undefined,
            continueToken,
            undefined,
            labelSelector,
            limit
          );
      list =
        resp.body as KubeListResp<V1DaemonSet> as KubeListResp<RawKubeObject>;
    } else {
      // Unknown kind — empty page.
      return { items: [] };
    }

    // Each item in the kube response gains the kind/apiVersion from the
    // request context — kube responses sometimes omit them on items.
    const items = list.items.map(it => ({
      apiVersion: it.apiVersion ?? kind.apiVersion,
      kind: it.kind ?? kind.kind,
      metadata: it.metadata ?? {},
      spec: it.spec,
      status: it.status,
    })) as RawKubeObject[];

    const out: RawListPage = { items };
    if (list.metadata?.continue) out.continueToken = list.metadata.continue;
    return out;
  }

  async getClusterInfo(): Promise<{
    name: string;
    endpoint: string;
    version: string;
  }> {
    // Version is exposed via `/version`; the kube client doesn't have a
    // first-class binding so we cheat through the underlying axios.
    // Best-effort — fall back to '' when unavailable.
    const version = '';
    try {
      const versionApi = (
        this.core as unknown as {
          basePath: string;
        }
      ).basePath;
      // No-op placeholder; this will be wired through axios in a
      // follow-up. For now leave version blank rather than failing.
      void versionApi;
    } catch {
      // ignore
    }
    return {
      name: this.clusterName,
      endpoint: this.endpoint,
      version,
    };
  }

  async listNamespaces(): Promise<string[]> {
    const resp = await this.core.listNamespace();
    return (resp.body.items ?? [])
      .map(n => n.metadata?.name)
      .filter((n): n is string => typeof n === 'string');
  }

  async listNodeInfo(): Promise<NodeInfoView[]> {
    const resp = await this.core.listNode();
    return (resp.body.items ?? []).map(nodeToView);
  }
}
