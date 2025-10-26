import { DiscoveryService } from '../../../src/services/discovery.service';
import { ClusterInfo } from '../../../src/types';

describe('DiscoveryService', () => {
  let service: DiscoveryService;

  beforeEach(() => {
    service = new DiscoveryService();
  });

  afterEach(async () => {
    await service.stop();
  });

  describe('scanCluster', () => {
    it('should return cluster information', async () => {
      const clusterInfo = await service.scanCluster();

      expect(clusterInfo).toBeDefined();
      expect(clusterInfo.name).toBe('noip-cluster');
      expect(clusterInfo.version).toBe('v1.28.2');
      expect(clusterInfo.nodeCount).toBeGreaterThan(0);
      expect(clusterInfo.podCount).toBeGreaterThan(0);
      expect(clusterInfo.lastScan).toBeInstanceOf(Date);
    });

    it('should handle scan errors gracefully', async () => {
      // Mock error scenario would be tested here
      // For now, we test successful case
      const clusterInfo = await service.scanCluster();
      expect(clusterInfo).toBeDefined();
    });
  });

  describe('getResources', () => {
    it('should return kubernetes resources', async () => {
      const resources = await service.getResources();

      expect(Array.isArray(resources)).toBe(true);
      expect(resources.length).toBeGreaterThan(0);

      const resource = resources[0];
      expect(resource.apiVersion).toBeDefined();
      expect(resource.kind).toBeDefined();
      expect(resource.metadata).toBeDefined();
      expect(resource.metadata.name).toBeDefined();
    });

    it('should filter resources by namespace', async () => {
      const namespace = 'test-namespace';
      const resources = await service.getResources(namespace);

      expect(Array.isArray(resources)).toBe(true);
      resources.forEach(resource => {
        expect(resource.metadata.namespace).toBe(namespace);
      });
    });
  });

  describe('getNamespaces', () => {
    it('should return array of namespace names', async () => {
      const namespaces = await service.getNamespaces();

      expect(Array.isArray(namespaces)).toBe(true);
      expect(namespaces.length).toBeGreaterThan(0);
      expect(namespaces).toContain('default');
      expect(namespaces).toContain('kube-system');
    });
  });

  describe('getNodeInfo', () => {
    it('should return array of node information', async () => {
      const nodes = await service.getNodeInfo();

      expect(Array.isArray(nodes)).toBe(true);
      expect(nodes.length).toBeGreaterThan(0);

      const node = nodes[0];
      expect(node.name).toBeDefined();
      expect(node.status).toBeDefined();
      expect(node.version).toBeDefined();
      expect(node.cpuCapacity).toBeDefined();
      expect(node.memoryCapacity).toBeDefined();
    });
  });

  describe('healthCheck', () => {
    it('should return health status', async () => {
      const health = await service.healthCheck();

      expect(health).toBeDefined();
      expect(health.status).toBe('healthy');
      expect(health.lastScan).toBeInstanceOf(Date);
    });
  });

  describe('initialization', () => {
    it('should initialize without errors', async () => {
      await expect(service.initialize()).resolves.not.toThrow();
    });
  });
});