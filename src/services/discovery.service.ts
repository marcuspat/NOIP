import * as k8s from '@kubernetes/client-node';
import { BaseService } from './base.service';
import { ClusterInfo, KubernetesResource } from '../types';
import { config } from '../config';

export class DiscoveryService extends BaseService {
  private kc: k8s.KubeConfig;
  private coreV1Api: k8s.CoreV1Api;
  private appsV1Api: k8s.AppsV1Api;
  private networksV1Api: k8s.NetworkingV1Api;
  private scanInterval: NodeJS.Timeout | null = null;
  private lastScanTime: Date | null = null;

  constructor() {
    super('DiscoveryService');
    this.kc = new k8s.KubeConfig();
    try {
      // In-cluster config when running inside a pod
      this.kc.loadFromCluster();
    } catch {
      // Fall back to kubeconfig file / KUBECONFIG env var for local/dev
      this.kc.loadFromDefault();
    }
    this.coreV1Api = this.kc.makeApiClient(k8s.CoreV1Api);
    this.appsV1Api = this.kc.makeApiClient(k8s.AppsV1Api);
    this.networksV1Api = this.kc.makeApiClient(k8s.NetworkingV1Api);
  }

  async initialize(): Promise<void> {
    this.logOperation('Initializing discovery service');
    if (config.services.discovery.enabled) {
      this.startScanning();
    }
  }

  async scanCluster(): Promise<ClusterInfo> {
    this.logOperation('Starting cluster scan');
    try {
      const [nodesResp, namespacesResp, podsResp, servicesResp] =
        await Promise.all([
          this.coreV1Api.listNode(),
          this.coreV1Api.listNamespace(),
          this.coreV1Api.listPodForAllNamespaces(),
          this.coreV1Api.listServiceForAllNamespaces(),
        ]);

      const nodes = nodesResp.items;
      const serverVersion =
        nodes[0]?.status?.nodeInfo?.kubeletVersion ?? 'unknown';

      const clusterInfo: ClusterInfo = {
        name:
          this.kc.getCurrentCluster()?.name ??
          config.services.discovery.k8sEndpoint ??
          'kubernetes',
        endpoint:
          this.kc.getCurrentCluster()?.server ??
          config.services.discovery.k8sEndpoint,
        version: serverVersion,
        nodeCount: nodes.length,
        namespaceCount: namespacesResp.items.length,
        podCount: podsResp.items.length,
        serviceCount: servicesResp.items.length,
        lastScan: new Date(),
      };

      this.lastScanTime = clusterInfo.lastScan;
      this.logOperation('Cluster scan completed', {
        nodeCount: clusterInfo.nodeCount,
        podCount: clusterInfo.podCount,
      });
      return clusterInfo;
    } catch (error) {
      this.logOperation('Cluster scan failed', error);
      throw error;
    }
  }

  async getResources(namespace?: string): Promise<KubernetesResource[]> {
    this.logOperation('Fetching resources', { namespace });
    try {
      const [podsResp, servicesResp, deploymentsResp] = await Promise.all([
        namespace
          ? this.coreV1Api.listNamespacedPod(namespace)
          : this.coreV1Api.listPodForAllNamespaces(),
        namespace
          ? this.coreV1Api.listNamespacedService(namespace)
          : this.coreV1Api.listServiceForAllNamespaces(),
        namespace
          ? this.appsV1Api.listNamespacedDeployment(namespace)
          : this.appsV1Api.listDeploymentForAllNamespaces(),
      ]);

      const resources: KubernetesResource[] = [
        ...podsResp.items.map((r) => this.normalizeResource(r, 'Pod', 'v1')),
        ...servicesResp.items.map((r) =>
          this.normalizeResource(r, 'Service', 'v1')
        ),
        ...deploymentsResp.items.map((r) =>
          this.normalizeResource(r, 'Deployment', 'apps/v1')
        ),
      ];

      this.logOperation('Fetched resources', { count: resources.length });
      return resources;
    } catch (error) {
      this.logOperation('Failed to fetch resources', error);
      throw error;
    }
  }

  async getNamespaces(): Promise<string[]> {
    this.logOperation('Fetching namespaces');
    try {
      const resp = await this.coreV1Api.listNamespace();
      const namespaces = resp.items
        .map((ns) => ns.metadata?.name ?? '')
        .filter(Boolean)
        .sort();
      this.logOperation('Fetched namespaces', { count: namespaces.length });
      return namespaces;
    } catch (error) {
      this.logOperation('Failed to fetch namespaces', error);
      throw error;
    }
  }

  async getNodeInfo(): Promise<
    {
      name: string | undefined;
      status: string;
      roles: string[];
      version: string | undefined;
      osImage: string | undefined;
      kernelVersion: string | undefined;
      cpuCapacity: string | undefined;
      memoryCapacity: string | undefined;
    }[]
  > {
    this.logOperation('Fetching node information');
    try {
      const resp = await this.coreV1Api.listNode();
      const nodes = resp.items.map((node) => ({
        name: node.metadata?.name,
        status:
          node.status?.conditions?.find((c) => c.type === 'Ready')?.status ===
          'True'
            ? 'Ready'
            : 'NotReady',
        roles: Object.keys(node.metadata?.labels ?? {})
          .filter((l) => l.startsWith('node-role.kubernetes.io/'))
          .map((l) => l.replace('node-role.kubernetes.io/', '')),
        version: node.status?.nodeInfo?.kubeletVersion,
        osImage: node.status?.nodeInfo?.osImage,
        kernelVersion: node.status?.nodeInfo?.kernelVersion,
        cpuCapacity: node.status?.capacity?.['cpu'],
        memoryCapacity: node.status?.capacity?.['memory'],
      }));
      this.logOperation('Fetched node info', { count: nodes.length });
      return nodes;
    } catch (error) {
      this.logOperation('Failed to fetch node info', error);
      throw error;
    }
  }

  private normalizeResource(
    resource: any,
    kind: string,
    apiVersion: string
  ): KubernetesResource {
    return {
      apiVersion: resource.apiVersion ?? apiVersion,
      kind: resource.kind ?? kind,
      metadata: {
        name: resource.metadata?.name,
        namespace: resource.metadata?.namespace,
        labels: resource.metadata?.labels ?? {},
        annotations: resource.metadata?.annotations ?? {},
        creationTimestamp: resource.metadata?.creationTimestamp,
        uid: resource.metadata?.uid,
      },
      spec: resource.spec,
      status: resource.status,
    };
  }

  private startScanning(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
    }

    this.scanInterval = setInterval(async () => {
      try {
        await this.scanCluster();
      } catch (error) {
        this.logOperation('Scheduled scan failed', error);
      }
    }, config.services.discovery.scanInterval);

    this.logOperation('Started automatic scanning', {
      interval: config.services.discovery.scanInterval,
    });
  }

  async stop(): Promise<void> {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
      this.logOperation('Stopped automatic scanning');
    }
  }

  async healthCheck(): Promise<{ status: string; lastScan?: Date }> {
    try {
      await this.coreV1Api.listNamespace();
      return { status: 'healthy', lastScan: this.lastScanTime ?? undefined };
    } catch (error) {
      this.logOperation('Health check failed', error);
      return { status: 'unhealthy' };
    }
  }
}
