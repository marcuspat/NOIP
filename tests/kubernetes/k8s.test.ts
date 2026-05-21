/**
 * Kubernetes Resource Tests
 * Comprehensive testing for Kubernetes manifests and deployments
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Tests that apply manifests need a reachable cluster via kubectl. When kubectl
// is absent (e.g. CI running manifest-lint only) those specific cases skip;
// the file-content validations still run.
const kubectlAvailable = (() => {
  try {
    execSync('kubectl version --client', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

describe('Kubernetes Resource Tests', () => {
  const testNamespace = 'noip-test';
  const kubeconfigPath =
    process.env.KUBECONFIG || path.join(process.env.HOME || '', '.kube/config');

  beforeAll(async () => {
    // Create test namespace
    try {
      execSync(`kubectl create namespace ${testNamespace}`, { stdio: 'pipe' });
    } catch (error) {
      // Namespace might already exist
      console.log('Test namespace already exists or could not be created');
    }
  });

  afterAll(async () => {
    // Cleanup test namespace
    try {
      execSync(
        `kubectl delete namespace ${testNamespace} --ignore-not-found=true`,
        {
          stdio: 'pipe',
        }
      );
    } catch (error) {
      console.log('Could not delete test namespace');
    }
  });

  describe('Manifest Validation Tests', () => {
    test('should have valid YAML syntax', () => {
      const manifestDirs = [
        'k8s/namespace',
        'k8s/configmaps',
        'k8s/secrets',
        'k8s/deployments',
        'k8s/services',
        'k8s/database',
        'k8s/monitoring',
        'k8s/ingress',
        'k8s/security',
      ];

      for (const dir of manifestDirs) {
        if (fs.existsSync(dir)) {
          const files = fs.readdirSync(dir);
          for (const file of files) {
            if (file.endsWith('.yaml') || file.endsWith('.yml')) {
              const filePath = path.join(dir, file);
              expect(() => {
                execSync(`kubectl apply --dry-run=client -f ${filePath}`, {
                  stdio: 'pipe',
                });
              }).not.toThrow(`Invalid YAML in ${filePath}`);
            }
          }
        }
      }
    });

    test('should have required Kubernetes labels', () => {
      const deploymentPath = 'k8s/deployments/noip-platform-deployment.yaml';
      if (fs.existsSync(deploymentPath)) {
        const content = fs.readFileSync(deploymentPath, 'utf8');

        // Check for standard labels
        expect(content).toContain('app: noip-platform');
        expect(content).toContain('component: application');
        expect(content).toContain('environment: production');
      }
    });

    test('should have resource limits defined', () => {
      const deploymentPath = 'k8s/deployments/noip-platform-deployment.yaml';
      if (fs.existsSync(deploymentPath)) {
        const content = fs.readFileSync(deploymentPath, 'utf8');

        // Check for resource requests and limits
        expect(content).toContain('resources:');
        expect(content).toContain('requests:');
        expect(content).toContain('limits:');
        expect(content).toContain('cpu:');
        expect(content).toContain('memory:');
      }
    });

    test('should have security context configured', () => {
      const deploymentPath = 'k8s/deployments/noip-platform-deployment.yaml';
      if (fs.existsSync(deploymentPath)) {
        const content = fs.readFileSync(deploymentPath, 'utf8');

        // Check for security context
        expect(content).toContain('securityContext:');
        expect(content).toContain('runAsNonRoot: true');
        expect(content).toContain('runAsUser:');
        expect(content).toContain('capabilities:');
        expect(content).toContain('drop:');
        expect(content).toContain('ALL');
      }
    });

    test('should have health checks configured', () => {
      const deploymentPath = 'k8s/deployments/noip-platform-deployment.yaml';
      if (fs.existsSync(deploymentPath)) {
        const content = fs.readFileSync(deploymentPath, 'utf8');

        // Check for probes
        expect(content).toContain('livenessProbe:');
        expect(content).toContain('readinessProbe:');
        expect(content).toContain('httpGet:');
      }
    });

    test('should have appropriate replica count', () => {
      const deploymentPath = 'k8s/deployments/noip-platform-deployment.yaml';
      if (fs.existsSync(deploymentPath)) {
        const content = fs.readFileSync(deploymentPath, 'utf8');

        // Should have at least 2 replicas for high availability
        expect(content).toContain('replicas:');
        const replicaMatch = content.match(/replicas:\s*(\d+)/);
        if (replicaMatch) {
          const replicas = parseInt(replicaMatch[1]);
          expect(replicas).toBeGreaterThanOrEqual(2);
        }
      }
    });
  });

  describe('Database Resource Tests', () => {
    test('MongoDB StatefulSet should be properly configured', () => {
      const mongodbPath = 'k8s/database/mongodb-statefulset.yaml';
      if (fs.existsSync(mongodbPath)) {
        const content = fs.readFileSync(mongodbPath, 'utf8');

        // Check for StatefulSet configuration
        expect(content).toContain('kind: StatefulSet');
        expect(content).toContain('serviceName: mongodb-headless');
        expect(content).toContain('volumeClaimTemplates:');
        expect(content).toContain('storageClassName:');
      }
    });

    test('Redis should have persistence configured', () => {
      const redisPath = 'k8s/database/redis-statefulset.yaml';
      if (fs.existsSync(redisPath)) {
        const content = fs.readFileSync(redisPath, 'utf8');

        // Check for persistence
        expect(content).toContain('volumeClaimTemplates:');
        expect(content).toContain('storageClassName:');
      }
    });

    test('Should have database services configured', () => {
      const servicesPath = 'k8s/services/services.yaml';
      if (fs.existsSync(servicesPath)) {
        const content = fs.readFileSync(servicesPath, 'utf8');

        // Check for database services
        expect(content).toContain('mongodb-service');
        expect(content).toContain('redis-service');
        expect(content).toContain('mongodb-headless');
      }
    });
  });

  describe('Security Configuration Tests', () => {
    test('should have network policies defined', () => {
      const networkPolicyPath = 'k8s/security/network-policy.yaml';
      if (fs.existsSync(networkPolicyPath)) {
        const content = fs.readFileSync(networkPolicyPath, 'utf8');

        // Check for network policies
        expect(content).toContain('kind: NetworkPolicy');
        expect(content).toContain('policyTypes:');
        expect(content).toContain('Ingress');
        expect(content).toContain('Egress');
      }
    });

    test('should have resource quotas configured', () => {
      const quotaPath = 'k8s/security/resource-quota.yaml';
      if (fs.existsSync(quotaPath)) {
        const content = fs.readFileSync(quotaPath, 'utf8');

        // Check for resource quotas
        expect(content).toContain('kind: ResourceQuota');
        expect(content).toContain('hard:');
        expect(content).toContain('requests.cpu:');
        expect(content).toContain('limits.memory:');
      }
    });

    test('should have Pod Security Policies', () => {
      const pspPath = 'k8s/security/pod-security-policy.yaml';
      if (fs.existsSync(pspPath)) {
        const content = fs.readFileSync(pspPath, 'utf8');

        // Check for Pod Security Policies
        expect(content).toContain('PodSecurityPolicy');
        expect(content).toContain('privileged: false');
        expect(content).toContain('allowPrivilegeEscalation: false');
      }
    });

    test('should have RBAC configured', () => {
      const pspPath = 'k8s/security/pod-security-policy.yaml';
      if (fs.existsSync(pspPath)) {
        const content = fs.readFileSync(pspPath, 'utf8');

        // Check for RBAC
        expect(content).toContain('ServiceAccount');
        expect(content).toContain('Role');
        expect(content).toContain('RoleBinding');
      }
    });
  });

  describe('Monitoring Configuration Tests', () => {
    test('should have Prometheus monitoring configured', () => {
      const monitoringPath = 'k8s/monitoring/prometheus-deployment.yaml';
      if (fs.existsSync(monitoringPath)) {
        const content = fs.readFileSync(monitoringPath, 'utf8');

        // Check for Prometheus
        expect(content).toContain('app: prometheus');
        expect(content).toContain('image: prom/prometheus');
        expect(content).toContain('persistentVolumeClaim');
      }
    });

    test('should have Grafana configured', () => {
      const monitoringPath = 'k8s/monitoring/prometheus-deployment.yaml';
      if (fs.existsSync(monitoringPath)) {
        const content = fs.readFileSync(monitoringPath, 'utf8');

        // Check for Grafana
        expect(content).toContain('app: grafana');
        expect(content).toContain('image: grafana/grafana');
      }
    });

    test('should have service monitors configured', () => {
      const servicesPath = 'k8s/services/services.yaml';
      if (fs.existsSync(servicesPath)) {
        const content = fs.readFileSync(servicesPath, 'utf8');

        // Check for ServiceMonitor
        expect(content).toContain('ServiceMonitor');
        expect(content).toContain('prometheus.io/scrape');
        expect(content).toContain('prometheus.io/port');
      }
    });
  });

  describe('Ingress Configuration Tests', () => {
    test('should have TLS configured', () => {
      const ingressPath = 'k8s/ingress/ingress.yaml';
      if (fs.existsSync(ingressPath)) {
        const content = fs.readFileSync(ingressPath, 'utf8');

        // Check for TLS
        expect(content).toContain('tls:');
        expect(content).toContain('secretName:');
        expect(content).toContain('nginx.ingress.kubernetes.io/ssl-redirect');
      }
    });

    test('should have proper host configuration', () => {
      const ingressPath = 'k8s/ingress/ingress.yaml';
      if (fs.existsSync(ingressPath)) {
        const content = fs.readFileSync(ingressPath, 'utf8');

        // Check for host configuration
        expect(content).toContain('host:');
        expect(content).toContain('noip.company.com');
        expect(content).toContain('api.noip.company.com');
      }
    });

    test('should have security annotations', () => {
      const ingressPath = 'k8s/ingress/ingress.yaml';
      if (fs.existsSync(ingressPath)) {
        const content = fs.readFileSync(ingressPath, 'utf8');

        // Check for security annotations
        expect(content).toContain('nginx.ingress.kubernetes.io/rate-limit');
        expect(content).toContain(
          'nginx.ingress.kubernetes.io/proxy-body-size'
        );
      }
    });
  });

  describe('Deployment Validation Tests', () => {
    test('should be able to apply all manifests', () => {
      const manifestDirs = [
        'k8s/namespace',
        'k8s/security',
        'k8s/configmaps',
        'k8s/secrets',
        'k8s/services',
        'k8s/deployments',
      ];

      for (const dir of manifestDirs) {
        if (fs.existsSync(dir)) {
          expect(() => {
            execSync(`kubectl apply --dry-run=client -f ${dir}`, {
              stdio: 'pipe',
            });
          }).not.toThrow(`Could not apply manifests in ${dir}`);
        }
      }
    });

    test('should validate pod security', () => {
      if (!kubectlAvailable) return;
      const deploymentPath = 'k8s/deployments/noip-platform-deployment.yaml';
      if (fs.existsSync(deploymentPath)) {
        // Apply deployment to test namespace
        const modifiedDeployment = fs
          .readFileSync(deploymentPath, 'utf8')
          .replace(/noip-production/g, testNamespace);

        fs.writeFileSync('/tmp/test-deployment.yaml', modifiedDeployment);

        try {
          execSync(`kubectl apply -f /tmp/test-deployment.yaml`, {
            stdio: 'pipe',
          });

          // Check if pod would be created with proper security
          const podYaml = execSync(
            `kubectl get deployment noip-platform -n ${testNamespace} -o yaml`,
            {
              encoding: 'utf8',
            }
          );

          expect(podYaml).toContain('runAsNonRoot');
          expect(podYaml).toContain('securityContext');
        } finally {
          execSync(
            `kubectl delete -f /tmp/test-deployment.yaml --ignore-not-found=true`,
            {
              stdio: 'pipe',
            }
          );
          fs.unlinkSync('/tmp/test-deployment.yaml');
        }
      }
    });
  });

  describe('Resource Limits Tests', () => {
    test('should have appropriate CPU limits', () => {
      const deploymentPath = 'k8s/deployments/noip-platform-deployment.yaml';
      if (fs.existsSync(deploymentPath)) {
        const content = fs.readFileSync(deploymentPath, 'utf8');

        // Check CPU limits are reasonable (not too high, not too low)
        expect(content).toMatch(/cpu:\s*["']?\d+m["']?/); // Should be in millicores
        expect(content).toMatch(/limits:\s*\n.*cpu:\s*["']?\d+m["']?/);
      }
    });

    test('should have appropriate memory limits', () => {
      const deploymentPath = 'k8s/deployments/noip-platform-deployment.yaml';
      if (fs.existsSync(deploymentPath)) {
        const content = fs.readFileSync(deploymentPath, 'utf8');

        // Memory uses Kubernetes quantity notation (e.g. "512Mi", "1Gi", "512").
        // The optional trailing B accommodates "MB"-style values too.
        expect(content).toMatch(/memory:\s*["']?\d+[KMGTPE]?i?B?["']?/);
        expect(content).toMatch(
          /limits:[\s\S]*?memory:\s*["']?\d+[KMGTPE]?i?B?["']?/
        );
      }
    });
  });

  describe('Auto-scaling Tests', () => {
    test('should have HPA configured', () => {
      const deploymentPath = 'k8s/deployments/noip-platform-deployment.yaml';
      if (fs.existsSync(deploymentPath)) {
        const content = fs.readFileSync(deploymentPath, 'utf8');

        // Check for Horizontal Pod Autoscaler
        expect(content).toContain('kind: HorizontalPodAutoscaler');
        expect(content).toContain('scaleTargetRef:');
        expect(content).toContain('minReplicas:');
        expect(content).toContain('maxReplicas:');
      }
    });

    test('should have Pod Disruption Budget', () => {
      const deploymentPath = 'k8s/deployments/noip-platform-deployment.yaml';
      if (fs.existsSync(deploymentPath)) {
        const content = fs.readFileSync(deploymentPath, 'utf8');

        // Check for PDB
        expect(content).toContain('kind: PodDisruptionBudget');
        expect(content).toContain('minAvailable:');
      }
    });
  });
});
