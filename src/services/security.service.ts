import * as k8s from '@kubernetes/client-node';
import { BaseService } from './base.service';

export interface SecurityFinding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: string;
  resource: string;
  namespace?: string;
  title: string;
  description: string;
  remediation: string;
}

export class SecurityService extends BaseService {
  private kc: k8s.KubeConfig;
  private coreV1Api: k8s.CoreV1Api;
  private appsV1Api: k8s.AppsV1Api;
  private rbacApi: k8s.RbacAuthorizationV1Api;
  private networkingApi: k8s.NetworkingV1Api;

  constructor() {
    super('SecurityService');
    this.kc = new k8s.KubeConfig();
    try {
      this.kc.loadFromCluster();
    } catch {
      this.kc.loadFromDefault();
    }
    this.coreV1Api = this.kc.makeApiClient(k8s.CoreV1Api);
    this.appsV1Api = this.kc.makeApiClient(k8s.AppsV1Api);
    this.rbacApi = this.kc.makeApiClient(k8s.RbacAuthorizationV1Api);
    this.networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
  }

  async initialize(): Promise<void> {
    this.logOperation('Initializing security service');
    this.logOperation('Security service initialized');
  }

  async scanPodSecurity(): Promise<SecurityFinding[]> {
    this.logOperation('Scanning pod security standards');
    const findings: SecurityFinding[] = [];

    try {
      const podsResp = await this.coreV1Api.listPodForAllNamespaces();

      for (const pod of podsResp.items) {
        const ns = pod.metadata?.namespace ?? 'default';
        const name = pod.metadata?.name ?? 'unknown';
        const allContainers = [
          ...(pod.spec?.containers ?? []),
          ...(pod.spec?.initContainers ?? []),
        ];

        for (const container of allContainers) {
          const sc = container.securityContext;

          if (sc?.privileged === true) {
            findings.push({
              severity: 'critical', category: 'Pod Security',
              resource: `${ns}/${name}/${container.name}`, namespace: ns,
              title: 'Privileged container detected',
              description: `Container ${container.name} in pod ${name} runs as privileged`,
              remediation: 'Remove privileged: true. Use specific capabilities (e.g. NET_ADMIN) instead.',
            });
          }

          if (!sc?.runAsNonRoot && sc?.runAsUser === undefined) {
            findings.push({
              severity: 'high', category: 'Pod Security',
              resource: `${ns}/${name}/${container.name}`, namespace: ns,
              title: 'Container may run as root',
              description: `Container ${container.name} does not set runAsNonRoot or runAsUser`,
              remediation: 'Set securityContext.runAsNonRoot: true or specify a non-zero runAsUser.',
            });
          }

          if (sc?.readOnlyRootFilesystem !== true) {
            findings.push({
              severity: 'medium', category: 'Pod Security',
              resource: `${ns}/${name}/${container.name}`, namespace: ns,
              title: 'Writable root filesystem',
              description: `Container ${container.name} has a writable root filesystem`,
              remediation: 'Set securityContext.readOnlyRootFilesystem: true. Mount emptyDir/PVC for writable paths.',
            });
          }

          if (sc?.allowPrivilegeEscalation !== false) {
            findings.push({
              severity: 'medium', category: 'Pod Security',
              resource: `${ns}/${name}/${container.name}`, namespace: ns,
              title: 'Privilege escalation allowed',
              description: `Container ${container.name} may escalate privileges via setuid/setgid`,
              remediation: 'Set securityContext.allowPrivilegeEscalation: false.',
            });
          }

          if (!container.resources?.limits?.memory || !container.resources?.limits?.cpu) {
            findings.push({
              severity: 'low', category: 'Resource Management',
              resource: `${ns}/${name}/${container.name}`, namespace: ns,
              title: 'Missing resource limits',
              description: `Container ${container.name} lacks CPU and/or memory limits`,
              remediation: 'Define resources.limits.cpu and resources.limits.memory to prevent noisy-neighbour issues.',
            });
          }
        }

        if (pod.spec?.hostNetwork) {
          findings.push({
            severity: 'high', category: 'Network Security',
            resource: `${ns}/${name}`, namespace: ns,
            title: 'Pod uses host network namespace',
            description: `Pod ${name} runs with hostNetwork: true, sharing the node network stack`,
            remediation: 'Remove hostNetwork: true unless the workload explicitly requires it.',
          });
        }

        if (pod.spec?.hostPID) {
          findings.push({
            severity: 'critical', category: 'Pod Security',
            resource: `${ns}/${name}`, namespace: ns,
            title: 'Pod shares host PID namespace',
            description: `Pod ${name} uses hostPID: true, enabling visibility into all host processes`,
            remediation: 'Remove hostPID: true from pod spec.',
          });
        }

        if (pod.spec?.hostIPC) {
          findings.push({
            severity: 'high', category: 'Pod Security',
            resource: `${ns}/${name}`, namespace: ns,
            title: 'Pod shares host IPC namespace',
            description: `Pod ${name} uses hostIPC: true`,
            remediation: 'Remove hostIPC: true from pod spec.',
          });
        }
      }
    } catch (error) {
      this.logOperation('Pod security scan failed', error);
      throw error;
    }

    this.logOperation('Pod security scan completed', { findings: findings.length });
    return findings;
  }

  async scanNetworkPolicies(): Promise<SecurityFinding[]> {
    this.logOperation('Scanning network policy coverage');
    const findings: SecurityFinding[] = [];
    const systemNamespaces = new Set(['kube-system', 'kube-public', 'kube-node-lease']);

    try {
      const [namespacesResp, netpolResp] = await Promise.all([
        this.coreV1Api.listNamespace(),
        this.networkingApi.listNetworkPolicyForAllNamespaces(),
      ]);

      const coveredNamespaces = new Set(
        netpolResp.items.map(p => p.metadata?.namespace).filter(Boolean)
      );

      for (const ns of namespacesResp.items) {
        const nsName = ns.metadata?.name ?? '';
        if (systemNamespaces.has(nsName)) continue;

        if (!coveredNamespaces.has(nsName)) {
          findings.push({
            severity: 'high', category: 'Network Security',
            resource: nsName, namespace: nsName,
            title: 'No NetworkPolicy in namespace',
            description: `Namespace ${nsName} has no NetworkPolicy â all pod-to-pod traffic is unrestricted`,
            remediation: 'Create a default-deny NetworkPolicy and explicit allow rules for required traffic paths.',
          });
        }
      }

      // Check for policies with overly permissive egress (allow all)
      for (const policy of netpolResp.items) {
        if (policy.spec?.egress?.some(e => !e.to || e.to.length === 0)) {
          findings.push({
            severity: 'info', category: 'Network Security',
            resource: `${policy.metadata?.namespace}/${policy.metadata?.name}`,
            namespace: policy.metadata?.namespace,
            title: 'NetworkPolicy allows unrestricted egress',
            description: `Policy ${policy.metadata?.name} permits all outbound traffic`,
            remediation: 'Scope egress rules to specific destinations and ports.',
          });
        }
      }
    } catch (error) {
      this.logOperation('Network policy scan failed', error);
      throw error;
    }

    this.logOperation('Network policy scan completed', { findings: findings.length });
    return findings;
  }

  async scanRBAC(): Promise<SecurityFinding[]> {
    this.logOperation('Scanning RBAC configuration');
    const findings: SecurityFinding[] = [];

    try {
      const [clusterRoleBindings, roleBindings] = await Promise.all([
        this.rbacApi.listClusterRoleBinding(),
        this.rbacApi.listRoleBindingForAllNamespaces(),
      ]);

      // Flag broad cluster-admin bindings
      for (const binding of clusterRoleBindings.items) {
        if (binding.roleRef.name !== 'cluster-admin') continue;
        for (const subject of binding.subjects ?? []) {
          if (subject.kind === 'Group' && ['system:authenticated', 'system:unauthenticated'].includes(subject.name)) {
            findings.push({
              severity: 'critical', category: 'RBAC',
              resource: binding.metadata?.name ?? 'unknown',
              title: 'cluster-admin granted to broad group',
              description: `ClusterRoleBinding ${binding.metadata?.name} grants cluster-admin to ${subject.name}`,
              remediation: 'Delete this binding immediately and apply least-privilege roles.',
            });
          }
          if (subject.kind === 'ServiceAccount' && subject.name === 'default') {
            findings.push({
              severity: 'high', category: 'RBAC',
              resource: binding.metadata?.name ?? 'unknown',
              title: 'default ServiceAccount has cluster-admin',
              description: `Default service account bound to cluster-admin`,
              remediation: 'Create dedicated service accounts with minimal required permissions.',
            });
          }
        }
      }

      // Flag default service accounts with any role bindings in user namespaces
      const systemNamespaces = new Set(['kube-system', 'kube-public', 'kube-node-lease']);
      for (const binding of roleBindings.items) {
        const ns = binding.metadata?.namespace ?? '';
        if (systemNamespaces.has(ns)) continue;
        for (const subject of binding.subjects ?? []) {
          if (subject.kind === 'ServiceAccount' && subject.name === 'default') {
            findings.push({
              severity: 'medium', category: 'RBAC',
              resource: `${ns}/${binding.metadata?.name}`, namespace: ns,
              title: 'Default service account has role binding',
              description: `Default SA in ${ns} is bound to role ${binding.roleRef.name}`,
              remediation: 'Create a named service account and bind the role to it instead.',
            });
          }
        }
      }
    } catch (error) {
      this.logOperation('RBAC scan failed', error);
      throw error;
    }

    this.logOperation('RBAC scan completed', { findings: findings.length });
    return findings;
  }

  async scanResources(resources: any[]): Promise<SecurityFinding[]> {
    const [podFindings, netFindings, rbacFindings] = await Promise.all([
      this.scanPodSecurity(),
      this.scanNetworkPolicies(),
      this.scanRBAC(),
    ]);
    return [...podFindings, ...netFindings, ...rbacFindings];
  }

  async getSecurityScore(): Promise<number> {
    const findings = await this.scanResources([]);
    if (findings.length === 0) return 100;
    const weights: Record<string, number> = { critical: 25, high: 15, medium: 8, low: 3, info: 1 };
    const deductions = findings.reduce((sum, f) => sum + (weights[f.severity] ?? 0), 0);
    return Math.max(0, 100 - deductions);
  }

  async getSecurityRecommendations(): Promise<string[]> {
    const findings = await this.scanResources([]);
    const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    return findings
      .sort((a, b) => (severityOrder[a.severity] ?? 5) - (severityOrder[b.severity] ?? 5))
      .slice(0, 10)
      .map(f => `[${f.severity.toUpperCase()}] ${f.title}: ${f.remediation}`);
  }

  async healthCheck(): Promise<{ status: string; details?: any }> {
    try {
      await this.coreV1Api.listNamespace();
      return { status: 'healthy' };
    } catch (error) {
      return { status: 'unhealthy', details: { error: (error as Error).message } };
    }
  }

  async stop(): Promise<void> {
    this.logOperation('Security service stopped');
  }
}
