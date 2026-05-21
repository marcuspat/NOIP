import { BaseService } from './base.service';
import { ClusterInfo, KubernetesResource } from '../types';
import { config } from '../config';
import { EventBus, defaultBus } from '../utils/event-bus';
import {
  fingerprintResource,
  computeDrift,
} from './discovery/fingerprint';
import { ResourceRecord } from '../models/snapshot.model';

export class DiscoveryService extends BaseService {
  private scanInterval: NodeJS.Timeout | null = null;
  private readonly eventBus: EventBus;

  constructor(eventBus?: EventBus) {
    super('DiscoveryService');
    this.eventBus = eventBus ?? defaultBus;
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
      const mockClusterInfo: ClusterInfo = {
        name: 'noip-cluster',
        endpoint: config.services.discovery.k8sEndpoint,
        version: 'v1.28.2',
        nodeCount: 3,
        namespaceCount: 8,
        podCount: 42,
        serviceCount: 15,
        lastScan: new Date(),
      };

      const resources = await this.getResources();
      const records = this.resourcesToRecords(resources);

      this.eventBus.publish<SnapshotCompletedPayload>('discovery.SnapshotCompleted', {
        clusterName: mockClusterInfo.name,
        takenAt: mockClusterInfo.lastScan,
        resourceCount: records.length,
        triggeredBy: 'scheduled',
      });

      this.logOperation('Cluster scan completed', mockClusterInfo);
      return mockClusterInfo;
    } catch (error) {
      this.logOperation('Cluster scan failed', error);
      throw error;
    }
  }

  async detectDrift(
    clusterName: string,
    baseline: ResourceRecord[],
    current: ResourceRecord[]
  ): Promise<void> {
    const driftItems = computeDrift(baseline, current);
    if (driftItems.length === 0) return;

    this.eventBus.publish<DriftDetectedPayload>('discovery.DriftDetected', {
      clusterName,
      detectedAt: new Date(),
      driftCount: driftItems.length,
      items: driftItems,
    });

    this.logOperation('Drift detected', { clusterName, driftCount: driftItems.length });
  }

  resourcesToRecords(resources: KubernetesResource[]): ResourceRecord[] {
    return resources.map(r => ({
      apiVersion: r.apiVersion,
      kind: r.kind,
      namespace: r.metadata.namespace,
      name: r.metadata.name,
      fingerprint: fingerprintResource(r),
      rawSpec: (r.spec ?? {}) as Record<string, unknown>,
    }));
  }

  async getResources(namespace?: string): Promise<KubernetesResource[]> {
    this.logOperation('Fetching resources', { namespace });

    return [
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: {
          name: 'noip-api-pod',
          namespace: namespace || 'default',
          labels: { app: 'noip-api' },
        },
        status: { phase: 'Running' },
      },
      {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
          name: 'noip-api-service',
          namespace: namespace || 'default',
          labels: { app: 'noip-api' },
        },
        spec: {
          ports: [{ port: 80, targetPort: 3000 }],
          selector: { app: 'noip-api' },
        },
      },
      {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name: 'noip-api-deployment',
          namespace: namespace || 'default',
          labels: { app: 'noip-api' },
        },
        spec: {
          replicas: 3,
          selector: { matchLabels: { app: 'noip-api' } },
          template: {
            metadata: { labels: { app: 'noip-api' } },
            spec: {
              containers: [
                {
                  name: 'api',
                  image: 'noip/api:latest',
                  ports: [{ containerPort: 3000 }],
                },
              ],
            },
          },
        },
      },
    ];
  }

  async getNamespaces(): Promise<string[]> {
    this.logOperation('Fetching namespaces');

    return [
      'default',
      'kube-system',
      'kube-public',
      'noip',
      'monitoring',
      'logging',
    ];
  }

  async getNodeInfo(): Promise<any[]> {
    this.logOperation('Fetching node information');

    return [
      {
        name: 'node-1',
        status: 'Ready',
        roles: ['control-plane', 'master'],
        version: 'v1.28.2',
        osImage: 'Ubuntu 22.04.3 LTS',
        kernelVersion: '5.4.0-110-generic',
        cpuCapacity: '2',
        memoryCapacity: '4Gi',
      },
      {
        name: 'node-2',
        status: 'Ready',
        roles: ['worker'],
        version: 'v1.28.2',
        osImage: 'Ubuntu 22.04.3 LTS',
        kernelVersion: '5.4.0-110-generic',
        cpuCapacity: '4',
        memoryCapacity: '8Gi',
      },
      {
        name: 'node-3',
        status: 'Ready',
        roles: ['worker'],
        version: 'v1.28.2',
        osImage: 'Ubuntu 22.04.3 LTS',
        kernelVersion: '5.4.0-110-generic',
        cpuCapacity: '4',
        memoryCapacity: '8Gi',
      },
    ];
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
    return {
      status: 'healthy',
      lastScan: new Date(),
    };
  }
}

// Domain event payload types
export interface SnapshotCompletedPayload {
  clusterName: string;
  takenAt: Date;
  resourceCount: number;
  triggeredBy: 'scheduled' | 'manual' | 'drift-alert';
}

export interface DriftDetectedPayload {
  clusterName: string;
  detectedAt: Date;
  driftCount: number;
  items: import('../models/drift-report.model').DriftItem[];
}
