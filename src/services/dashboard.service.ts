import { BaseService } from './base.service';
import { DashboardConfig, DashboardWidget } from '../types';

export class DashboardService extends BaseService {
  private dashboardConfigs: Map<string, DashboardConfig> = new Map();

  constructor() {
    super('DashboardService');
  }

  async initialize(): Promise<void> {
    this.logOperation('Initializing dashboard service');

    // Initialize default dashboard configurations
    await this.createDefaultDashboards();
  }

  async createDashboard(
    config: Omit<DashboardConfig, 'id'>
  ): Promise<DashboardConfig> {
    const dashboard: DashboardConfig = {
      id: 'dashboard-' + Date.now(),
      ...config,
    };

    this.dashboardConfigs.set(dashboard.id, dashboard);
    this.logOperation('Created dashboard', {
      id: dashboard.id,
      name: dashboard.name,
    });

    return dashboard;
  }

  async getDashboard(id: string): Promise<DashboardConfig | null> {
    return this.dashboardConfigs.get(id) || null;
  }

  async getAllDashboards(): Promise<DashboardConfig[]> {
    return Array.from(this.dashboardConfigs.values());
  }

  async updateDashboard(
    id: string,
    updates: Partial<DashboardConfig>
  ): Promise<DashboardConfig | null> {
    const existing = this.dashboardConfigs.get(id);
    if (!existing) {
      return null;
    }

    const updated = { ...existing, ...updates };
    this.dashboardConfigs.set(id, updated);
    this.logOperation('Updated dashboard', { id, name: updated.name });

    return updated;
  }

  async deleteDashboard(id: string): Promise<boolean> {
    const deleted = this.dashboardConfigs.delete(id);
    if (deleted) {
      this.logOperation('Deleted dashboard', { id });
    }
    return deleted;
  }

  async addWidget(
    dashboardId: string,
    widget: Omit<DashboardWidget, 'id'>
  ): Promise<DashboardWidget | null> {
    const dashboard = this.dashboardConfigs.get(dashboardId);
    if (!dashboard) {
      return null;
    }

    const newWidget: DashboardWidget = {
      id: 'widget-' + Date.now(),
      ...widget,
    };

    dashboard.widgets.push(newWidget);
    this.dashboardConfigs.set(dashboardId, dashboard);
    this.logOperation('Added widget to dashboard', {
      dashboardId,
      widgetId: newWidget.id,
    });

    return newWidget;
  }

  async removeWidget(dashboardId: string, widgetId: string): Promise<boolean> {
    const dashboard = this.dashboardConfigs.get(dashboardId);
    if (!dashboard) {
      return false;
    }

    const initialLength = dashboard.widgets.length;
    dashboard.widgets = dashboard.widgets.filter(w => w.id !== widgetId);
    const removed = dashboard.widgets.length < initialLength;

    if (removed) {
      this.dashboardConfigs.set(dashboardId, dashboard);
      this.logOperation('Removed widget from dashboard', {
        dashboardId,
        widgetId,
      });
    }

    return removed;
  }

  async getWidgetData(_widgetId: string): Promise<any> {
    // Mock widget data generation based on widget type
    const mockDataGenerators = {
      chart: () => ({
        labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'],
        datasets: [
          {
            label: 'CPU Usage',
            data: [65, 59, 80, 81, 56, 55],
            borderColor: 'rgb(75, 192, 192)',
            backgroundColor: 'rgba(75, 192, 192, 0.2)',
          },
          {
            label: 'Memory Usage',
            data: [28, 48, 40, 19, 86, 27],
            borderColor: 'rgb(255, 99, 132)',
            backgroundColor: 'rgba(255, 99, 132, 0.2)',
          },
        ],
      }),
      metric: () => ({
        value: Math.floor(Math.random() * 100),
        trend: 'up',
        change: '+5.2%',
        status: 'healthy',
      }),
      table: () => ({
        headers: ['Name', 'Namespace', 'Status', 'CPU', 'Memory'],
        rows: [
          ['noip-api', 'default', 'Running', '250m', '512Mi'],
          ['noip-db', 'noip', 'Running', '500m', '1Gi'],
          ['noip-cache', 'noip', 'Running', '100m', '256Mi'],
        ],
      }),
      alert: () => ({
        alerts: [
          {
            level: 'warning',
            message: 'High memory usage detected in noip-api',
            timestamp: new Date(),
          },
          {
            level: 'info',
            message: 'Scheduled maintenance completed',
            timestamp: new Date(),
          },
        ],
      }),
    };

    // For demo purposes, generate random data
    const widgetTypes = Object.keys(mockDataGenerators);
    const randomType =
      widgetTypes[Math.floor(Math.random() * widgetTypes.length)];
    return mockDataGenerators[randomType as keyof typeof mockDataGenerators]();
  }

  private async createDefaultDashboards(): Promise<void> {
    // Executive Dashboard
    await this.createDashboard({
      name: 'Executive Overview',
      description: 'High-level infrastructure overview for executives',
      widgets: [
        {
          id: 'exec-status',
          type: 'metric',
          title: 'System Status',
          config: { metric: 'system_health', showTrend: true },
          position: { x: 0, y: 0, w: 3, h: 2 },
        },
        {
          id: 'exec-cost',
          type: 'metric',
          title: 'Monthly Cost',
          config: { metric: 'cost', format: 'currency' },
          position: { x: 3, y: 0, w: 3, h: 2 },
        },
        {
          id: 'exec-security',
          type: 'metric',
          title: 'Security Score',
          config: { metric: 'security_score', max: 100 },
          position: { x: 6, y: 0, w: 3, h: 2 },
        },
        {
          id: 'exec-alerts',
          type: 'alert',
          title: 'Critical Alerts',
          config: { severity: ['critical', 'high'] },
          position: { x: 9, y: 0, w: 3, h: 2 },
        },
      ],
      layout: 'grid',
      refreshInterval: 60000, // 1 minute
    });

    // Operations Dashboard
    await this.createDashboard({
      name: 'Operations',
      description: 'Detailed operational metrics and monitoring',
      widgets: [
        {
          id: 'ops-resources',
          type: 'chart',
          title: 'Resource Utilization',
          config: { type: 'line', metrics: ['cpu', 'memory', 'storage'] },
          position: { x: 0, y: 0, w: 6, h: 4 },
        },
        {
          id: 'ops-pods',
          type: 'table',
          title: 'Pod Status',
          config: { namespace: 'all', showDetails: true },
          position: { x: 6, y: 0, w: 6, h: 4 },
        },
        {
          id: 'ops-nodes',
          type: 'chart',
          title: 'Node Distribution',
          config: { type: 'pie', metric: 'node_status' },
          position: { x: 0, y: 4, w: 6, h: 4 },
        },
        {
          id: 'ops-services',
          type: 'table',
          title: 'Service Health',
          config: { includeEndpoints: true },
          position: { x: 6, y: 4, w: 6, h: 4 },
        },
      ],
      layout: 'grid',
      refreshInterval: 30000, // 30 seconds
    });

    // Security Dashboard
    await this.createDashboard({
      name: 'Security',
      description: 'Security monitoring and compliance',
      widgets: [
        {
          id: 'sec-score',
          type: 'metric',
          title: 'Security Score',
          config: { metric: 'security_score', showHistory: true },
          position: { x: 0, y: 0, w: 4, h: 3 },
        },
        {
          id: 'sec-vulnerabilities',
          type: 'chart',
          title: 'Vulnerability Trends',
          config: { type: 'bar', groupBy: 'severity' },
          position: { x: 4, y: 0, w: 8, h: 3 },
        },
        {
          id: 'sec-scan-results',
          type: 'table',
          title: 'Latest Scan Results',
          config: { showDetails: true, filterBy: 'severity' },
          position: { x: 0, y: 3, w: 12, h: 5 },
        },
      ],
      layout: 'grid',
      refreshInterval: 300000, // 5 minutes
    });

    this.logOperation('Created default dashboards', { count: 3 });
  }

  async healthCheck(): Promise<{ status: string; dashboardCount: number }> {
    return {
      status: 'healthy',
      dashboardCount: this.dashboardConfigs.size,
    };
  }
}
