export interface ServiceResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: Date;
  requestId: string;
}

export interface ServiceConfig {
  name: string;
  version: string;
  environment: string;
  port: number;
  healthCheckEndpoint: string;
}

export interface KubernetesResource {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: any;
  status?: any;
}

export interface SecurityScanResult {
  scanId: string;
  timestamp: Date;
  severity: 'low' | 'medium' | 'high' | 'critical';
  category: string;
  description: string;
  recommendation?: string;
  affectedResources: string[];
}

export interface ClusterInfo {
  name: string;
  endpoint: string;
  version: string;
  nodeCount: number;
  namespaceCount: number;
  podCount: number;
  serviceCount: number;
  lastScan: Date;
}

export interface AIAnalysisRequest {
  type: 'security' | 'performance' | 'compliance' | 'cost';
  data: any;
  context?: string;
  strategy?: string;
  relevantContext?: AIContext[];
  learningEnabled?: boolean;
}

export interface AIAnalysisResult {
  insights: string[];
  recommendations: string[];
  confidence: number;
  processingTime: number;
  timestamp: Date;
  context?: {
    strategy?: string;
    relevantContextCount?: number;
    patternsIdentified?: number;
    predictions?: string[];
    predictiveAnalysis?: boolean;
  };
  learning?: {
    patterns: string[];
    newObservations: string[];
  };
  predictions?: string[];
}

export interface AIContext {
  id: string;
  type: string;
  content: string;
  timestamp: Date;
  confidence: number;
  embeddings: number[];
}

export interface AILearningPattern {
  id: string;
  type: string;
  pattern: string;
  confidence: number;
  successRate: number;
  context?: any;
  timestamp: Date;
  embeddings: number[];
  usageCount: number;
  lastUsed: Date;
}

export interface DashboardWidget {
  id: string;
  type: 'chart' | 'metric' | 'table' | 'alert';
  title: string;
  config: any;
  position: { x: number; y: number; w: number; h: number };
}

export interface DashboardConfig {
  id: string;
  name: string;
  description: string;
  widgets: DashboardWidget[];
  layout: 'grid' | 'flex';
  refreshInterval: number;
}
