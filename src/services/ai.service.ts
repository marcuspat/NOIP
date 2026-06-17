import Anthropic from '@anthropic-ai/sdk';
import { BaseService } from './base.service';

export class AIService extends BaseService {
  private client: Anthropic;

  constructor() {
    super('AIService');
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }

  async initialize(): Promise<void> {
    this.logOperation('Initializing AI service');
    if (!process.env.ANTHROPIC_API_KEY) {
      this.logOperation('WARNING: ANTHROPIC_API_KEY not set â AI analysis will be unavailable');
    }
    this.logOperation('AI service initialized');
  }

  async analyzeInfrastructure(clusterData: any): Promise<any> {
    return this.unwrapWithErrorHandling(async () => {
      this.logOperation('Analyzing infrastructure with AI');
      const message = await this.client.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: `You are a Kubernetes infrastructure expert. Analyze the following cluster data and provide structured recommendations.

Cluster Data:
${JSON.stringify(clusterData, null, 2)}

Respond with a JSON object containing:
{
  "summary": "Brief overview of cluster health",
  "score": <number 0-100>,
  "findings": [{ "severity": "critical|high|medium|low", "title": "...", "description": "...", "recommendation": "..." }],
  "optimizations": ["list of optimization suggestions"],
  "risks": ["list of identified risks"]
}

Return ONLY valid JSON, no markdown fences.`,
        }],
      });

      const content = message.content[0];
      if (content.type !== 'text') throw new Error('Unexpected response type from AI');
      return JSON.parse(content.text);
    }, 'Infrastructure analysis failed');
  }

  async analyzeSecurity(scanResults: any[]): Promise<any> {
    return this.unwrapWithErrorHandling(async () => {
      this.logOperation('Analyzing security findings with AI');
      const message = await this.client.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: `You are a Kubernetes security expert. Analyze these security scan results and provide actionable remediation guidance.

Scan Results:
${JSON.stringify(scanResults, null, 2)}

Respond with a JSON object:
{
  "riskLevel": "critical|high|medium|low",
  "score": <number 0-100>,
  "criticalIssues": [{ "issue": "...", "remediation": "...", "urgency": "immediate|soon|planned" }],
  "recommendations": ["prioritized list of security improvements"],
  "complianceImpact": ["affected compliance frameworks"]
}

Return ONLY valid JSON, no markdown fences.`,
        }],
      });

      const content = message.content[0];
      if (content.type !== 'text') throw new Error('Unexpected response type from AI');
      return JSON.parse(content.text);
    }, 'Security analysis failed');
  }

  async analyzeCompliance(resources: any[]): Promise<any> {
    return this.unwrapWithErrorHandling(async () => {
      this.logOperation('Analyzing compliance posture with AI');
      const message = await this.client.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: `You are a cloud compliance expert. Analyze these Kubernetes resources for SOC2, HIPAA, and PCI-DSS compliance gaps.

Resources:
${JSON.stringify(resources, null, 2)}

Respond with a JSON object:
{
  "overallScore": <number 0-100>,
  "frameworks": {
    "soc2": { "score": <number>, "gaps": ["..."], "passedControls": ["..."] },
    "hipaa": { "score": <number>, "gaps": ["..."], "passedControls": ["..."] },
    "pciDss": { "score": <number>, "gaps": ["..."], "passedControls": ["..."] }
  },
  "prioritizedRemediation": ["ordered list of remediation steps"]
}

Return ONLY valid JSON, no markdown fences.`,
        }],
      });

      const content = message.content[0];
      if (content.type !== 'text') throw new Error('Unexpected response type from AI');
      return JSON.parse(content.text);
    }, 'Compliance analysis failed');
  }

  async generateReport(data: { cluster?: any; security?: any[]; compliance?: any[] }): Promise<any> {
    return this.unwrapWithErrorHandling(async () => {
      this.logOperation('Generating comprehensive AI report');
      const message = await this.client.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: `You are a senior DevSecOps engineer. Generate a comprehensive NetOps Intelligence Report for the following data.

${data.cluster ? `Cluster State:\n${JSON.stringify(data.cluster, null, 2)}\n` : ''}
${data.security ? `Security Findings:\n${JSON.stringify(data.security, null, 2)}\n` : ''}
${data.compliance ? `Compliance Resources:\n${JSON.stringify(data.compliance, null, 2)}\n` : ''}

Respond with a JSON object:
{
  "executiveSummary": "2-3 sentence C-suite summary",
  "overallHealthScore": <number 0-100>,
  "topPriorities": [{ "rank": 1, "action": "...", "impact": "...", "effort": "low|medium|high" }],
  "infraAnalysis": { "summary": "...", "score": <number>, "keyFindings": ["..."] },
  "securityAnalysis": { "riskLevel": "...", "score": <number>, "criticalIssues": ["..."] },
  "complianceAnalysis": { "overallScore": <number>, "gaps": ["..."] },
  "roadmap": { "immediate": ["..."], "shortTerm": ["..."], "longTerm": ["..."] }
}

Return ONLY valid JSON, no markdown fences.`,
        }],
      });

      const content = message.content[0];
      if (content.type !== 'text') throw new Error('Unexpected response type from AI');
      return JSON.parse(content.text);
    }, 'Report generation failed');
  }

  private async unwrapWithErrorHandling<T>(operation: () => Promise<T>, errorMessage: string): Promise<T> {
    const result = await this.withErrorHandling(operation, errorMessage);
    if (!result.success) {
      throw new Error(result.error || errorMessage);
    }
    return result.data as T;
  }

  async healthCheck(): Promise<{ status: string; details: any }> {
    if (!process.env.ANTHROPIC_API_KEY) {
      return { status: 'unhealthy', details: { error: 'ANTHROPIC_API_KEY not configured' } };
    }
    return {
      status: 'healthy',
      details: { model: 'claude-3-5-sonnet-20241022', provider: 'Anthropic' },
    };
  }

  async stop(): Promise<void> {
    this.logOperation('AI service stopped');
  }
}
