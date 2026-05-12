import { BaseService } from './base.service';
import { createHash } from 'crypto';
import {
  AIAnalysisRequest,
  AIAnalysisResult,
  AIContext,
  AILearningPattern,
} from '../types';
import { config } from '../config';
import axios from 'axios';
import { redact } from '../utils/redact';
import type {
  IAgentDB,
  IReasoningBank,
  ILLMClient,
} from './ai/ports';
import { MockAgentDB } from './ai/mock-agentdb.adapter';
import { MockReasoningBank } from './ai/mock-reasoning-bank.adapter';

/**
 * Optional injection point for ADR-0011 ports. When provided, AIService
 * uses these instead of its built-in axios path (LLM) and the default
 * mock adapters for AgentDB / ReasoningBank. When omitted, the service
 * falls back to in-process mocks so unit tests have no external deps.
 */
export interface AIServicePorts {
  llm?: ILLMClient;
  agentDB?: IAgentDB;
  reasoningBank?: IReasoningBank;
}

/**
 * Convert an arbitrary string (e.g. a free-text query) into a deterministic
 * fixed-dimension vector. We hash with SHA-256 and reinterpret the first 16
 * bytes as 16 floats in `[0, 1)`. This is purely structural — the mock
 * AgentDB does cosine similarity on these vectors and does not interpret
 * them semantically.
 */
function stringToVector(input: string, dims: number = 16): number[] {
  const digest = createHash('sha256').update(input).digest();
  const out: number[] = new Array(dims);
  for (let i = 0; i < dims; i++) {
    out[i] = (digest[i % digest.length] as number) / 256;
  }
  return out;
}

/**
 * Derive a deterministic vector from a learning pattern. Legacy code
 * passes pre-computed `embeddings` on the pattern; when present we use
 * those, otherwise we hash the pattern id so identical ids reproducibly
 * map to the same vector.
 */
function patternToVector(pattern: AILearningPattern): number[] {
  if (Array.isArray(pattern.embeddings) && pattern.embeddings.length > 0) {
    return pattern.embeddings;
  }
  return stringToVector(pattern.id);
}

export class AIService extends BaseService {
  private agentDB: IAgentDB | null = null;
  private reasoningBank: IReasoningBank | null = null;
  private contextCache: Map<string, AIContext> = new Map();
  private learningEnabled: boolean = true;
  private contextMemory: AIContext[] = [];
  private readonly llmPort?: ILLMClient;
  private readonly agentDBPort?: IAgentDB;
  private readonly reasoningBankPort?: IReasoningBank;

  constructor(ports: AIServicePorts = {}) {
    super('AIService');
    this.llmPort = ports.llm;
    this.agentDBPort = ports.agentDB;
    this.reasoningBankPort = ports.reasoningBank;
  }

  async initialize(): Promise<void> {
    this.logOperation('Initializing Advanced AI service');

    // ADR-0011: always wire up an IAgentDB and an IReasoningBank so the
    // rest of the service can rely on them being non-null. If the caller
    // injected ports via the constructor we use those; otherwise we fall
    // back to the in-process mock adapters (safe for tests and local dev).
    await this.initializeAgentDB();
    await this.initializeReasoningBank();

    if (!config.services.ai.enabled) {
      this.logOperation('AI service disabled in configuration');
      // Still load context memory so getters work in disabled mode.
      await this.loadContextMemory();
      return;
    }

    if (!config.services.ai.apiKey) {
      this.logOperation('AI service API key not configured');
    }

    // Load existing context memory
    await this.loadContextMemory();

    this.logOperation('Advanced AI service initialized successfully');
  }

  private async initializeAgentDB(): Promise<void> {
    if (this.agentDBPort) {
      this.agentDB = this.agentDBPort;
      this.logOperation('AgentDB port injected (ADR-0011)');
      return;
    }
    this.agentDB = new MockAgentDB();
    this.logOperation('AgentDB defaulted to in-process MockAgentDB');
  }

  private async initializeReasoningBank(): Promise<void> {
    if (this.reasoningBankPort) {
      this.reasoningBank = this.reasoningBankPort;
      this.logOperation('ReasoningBank port injected (ADR-0011)');
      return;
    }
    this.reasoningBank = new MockReasoningBank();
    this.logOperation('ReasoningBank defaulted to in-process MockReasoningBank');
  }

  private async loadContextMemory(): Promise<void> {
    try {
      // Load persistent context memory
      // In production, this would load from database
      this.contextMemory = [
        {
          id: 'default-security-context',
          type: 'security_analysis',
          content:
            'Previous security analyses identified common patterns in RBAC misconfigurations and network policies',
          timestamp: new Date(),
          confidence: 0.92,
          embeddings: new Array(1536).fill(0.1), // Mock embedding
        },
        {
          id: 'default-performance-context',
          type: 'performance_analysis',
          content:
            'Historical performance data shows resource optimization opportunities in scaling and memory management',
          timestamp: new Date(),
          confidence: 0.89,
          embeddings: new Array(1536).fill(0.1), // Mock embedding
        },
      ];

      // Mirror the bootstrap contexts into AgentDB so port-backed lookups
      // can find them. We hash the content for the vector (the legacy
      // 1536-dim flat embeddings are not useful for similarity search).
      if (this.agentDB) {
        for (const ctx of this.contextMemory) {
          const vector = stringToVector(ctx.content);
          await this.agentDB.upsert(vector, ctx, {
            contextId: ctx.id,
            type: ctx.type,
          });
        }
      }

      this.logOperation('Context memory loaded', {
        contexts: this.contextMemory.length,
      });
    } catch (error) {
      this.logOperation('Failed to load context memory', error);
    }
  }

  async analyzeInfrastructure(data: any): Promise<AIAnalysisResult> {
    const startTime = Date.now();

    try {
      // Get recommended strategy from ReasoningBank. The legacy contract
      // returned a single strategy object; the port returns a ranked list,
      // so we take the head and adapt the shape.
      const reasoningContext = {
        task: 'infrastructure_analysis',
        dataSize: JSON.stringify(data).length,
        clusterNodes: data.nodes?.length || 0,
        hasMetrics: !!data.metrics,
      };

      const recommendations = this.reasoningBank
        ? await this.reasoningBank.recommendStrategy(reasoningContext)
        : [];
      const topStrategy = recommendations[0]?.strategy;

      // Retrieve relevant context for infrastructure analysis. The legacy
      // call was a string-keyed lookup; the port takes a vector, so we
      // hash the query string into a fixed-dimension vector (see
      // `stringToVector` above) for a stable nearest-neighbour search.
      const relevantContext = await this.retrieveContext(
        'infrastructure performance',
        5
      );

      const request: AIAnalysisRequest = {
        type: 'performance',
        data,
        context: 'Kubernetes cluster infrastructure analysis',
        strategy: topStrategy?.id,
        relevantContext,
        learningEnabled: this.learningEnabled,
      };

      const result = await this.performAdvancedAIAnalysis(request);

      // Learn from this analysis if enabled
      if (this.learningEnabled && this.reasoningBank) {
        const strategyUsed = topStrategy ?? {
          id: 'standard_analysis',
          description: 'Default analysis strategy',
        };
        await this.reasoningBank.recordExperience({
          context: reasoningContext,
          strategy: strategyUsed,
          outcome: {
            success: true,
            notes: `confidence=${result.confidence}; insights=${result.insights.length}; ms=${Date.now() - startTime}`,
          },
        });
      }

      return result;
    } catch (error) {
      this.logOperation('Advanced infrastructure analysis failed', error);
      throw error;
    }
  }

  /**
   * Internal helper: convert a string query to a vector and call
   * `IAgentDB.query`, then project the stored payloads back to AIContext
   * shapes. Returns an empty array if AgentDB is not yet initialized.
   */
  private async retrieveContext(
    query: string,
    limit: number
  ): Promise<AIContext[]> {
    if (!this.agentDB) return [];
    const vector = stringToVector(query);
    const hits = await this.agentDB.query(vector, limit);
    const contexts: AIContext[] = [];
    for (const hit of hits) {
      const payload = hit.payload as Partial<AIContext> | null | undefined;
      if (payload && typeof payload === 'object' && 'content' in payload) {
        contexts.push(payload as AIContext);
      }
    }
    return contexts;
  }

  async analyzeSecurity(scanResults: any[]): Promise<AIAnalysisResult> {
    const request: AIAnalysisRequest = {
      type: 'security',
      data: { scanResults },
      context: 'Security scan results analysis',
    };

    return this.performAdvancedAIAnalysis(request);
  }

  async analyzeCompliance(resources: any[]): Promise<AIAnalysisResult> {
    const request: AIAnalysisRequest = {
      type: 'compliance',
      data: { resources },
      context: 'Infrastructure compliance analysis',
    };

    return this.performAdvancedAIAnalysis(request);
  }

  async analyzeCost(usageData: any): Promise<AIAnalysisResult> {
    const request: AIAnalysisRequest = {
      type: 'cost',
      data: usageData,
      context: 'Infrastructure cost optimization analysis',
    };

    return this.performAdvancedAIAnalysis(request);
  }

  private async performAdvancedAIAnalysis(
    request: AIAnalysisRequest
  ): Promise<AIAnalysisResult> {
    const startTime = Date.now();

    try {
      // Enhanced analysis with context awareness and learning
      if (
        config.services.ai.apiKey &&
        config.services.ai.apiKey !== 'your-api-key'
      ) {
        return await this.callEnhancedClaudeAPI(request);
      } else {
        return this.getAdvancedMockAnalysis(request);
      }
    } catch (error) {
      this.logOperation('Advanced AI analysis failed', error);
      throw error;
    } finally {
      const processingTime = Date.now() - startTime;
      this.logOperation('Advanced AI analysis completed', {
        type: request.type,
        strategy: request.strategy,
        contextCount: request.relevantContext?.length || 0,
        processingTime,
      });
    }
  }

  private async callEnhancedClaudeAPI(
    request: AIAnalysisRequest
  ): Promise<AIAnalysisResult> {
    // Build enhanced prompt with context and learning, then run it through
    // the centralised secret redactor before it leaves our process
    // (ADR-0010, ADR-0015).
    const rawPrompt = this.buildEnhancedPrompt(request);
    const prompt = redact(rawPrompt);

    let content: string;
    if (this.llmPort) {
      // ADR-0011: ports-based path (used by tests and pluggable providers).
      const out = await this.llmPort.complete({
        prompt,
        model: 'claude-3-sonnet-20240229',
        maxTokens: config.services.ai.maxTokens,
      });
      content = out.text;
    } else {
      const response = await axios.post(
        config.services.ai.endpoint + '/v1/messages',
        {
          model: 'claude-3-sonnet-20240229',
          max_tokens: config.services.ai.maxTokens,
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.services.ai.apiKey,
            'anthropic-version': '2023-06-01',
          },
        }
      );

      content = (response.data as any).content[0].text;
    }
    const result = this.parseEnhancedAIResponse(content, request);

    // Store learned pattern if AgentDB is available
    if (this.agentDB && this.learningEnabled) {
      await this.storeLearningPattern(request, result);
    }

    return result;
  }

  private buildEnhancedPrompt(request: AIAnalysisRequest): string {
    let prompt = '';

    // Add context and strategy information
    if (request.strategy) {
      prompt += `ANALYSIS STRATEGY: ${request.strategy}\n\n`;
    }

    if (request.relevantContext && request.relevantContext.length > 0) {
      prompt += 'RELEVANT CONTEXT FROM PREVIOUS ANALYSES:\n';
      request.relevantContext.forEach((ctx, index) => {
        prompt += `${index + 1}. ${ctx.content} (Confidence: ${ctx.confidence})\n`;
      });
      prompt += '\n';
    }

    // Add the main analysis prompt
    const basePrompts = {
      security: `
        Analyze the following Kubernetes security scan results with contextual awareness and provide:
        1. Key security insights and patterns learned from previous analyses
        2. Prioritized recommendations based on historical effectiveness
        3. Risk assessment considering current threat landscape
        4. Predictive security recommendations to prevent future issues
        5. Learning observations for continuous improvement

        Data: ${JSON.stringify(request.data, null, 2)}
      `,
      performance: `
        Analyze the following Kubernetes infrastructure performance data with contextual awareness and provide:
        1. Performance bottlenecks identified through pattern recognition
        2. Resource utilization insights based on historical data
        3. Scaling recommendations informed by previous optimizations
        4. Predictive analysis for potential future issues
        5. Architecture improvement suggestions with success probability

        Data: ${JSON.stringify(request.data, null, 2)}
      `,
      compliance: `
        Analyze the following Kubernetes resources for compliance with contextual awareness and provide:
        1. Compliance violations identified through pattern matching
        2. Regulatory framework alignment based on historical interpretations
        3. Remediation steps prioritized by effectiveness
        4. Predictive compliance recommendations
        5. Documentation improvements based on previous audit findings

        Data: ${JSON.stringify(request.data, null, 2)}
      `,
      cost: `
        Analyze the following infrastructure cost data with contextual awareness and provide:
        1. Cost optimization opportunities identified through pattern analysis
        2. Resource allocation efficiency based on historical usage
        3. Budget recommendations informed by previous optimizations
        4. Predictive cost analysis for future scaling
        5. Cost-saving strategies with estimated impact

        Data: ${JSON.stringify(request.data, null, 2)}
      `,
    };

    prompt +=
      basePrompts[request.type] ||
      `
      Analyze the following data with contextual awareness and provide:
      1. Key insights based on pattern recognition
      2. Recommendations informed by historical data
      3. Predictive analysis for future considerations
      4. Learning observations for continuous improvement

      Data: ${JSON.stringify(request.data, null, 2)}
    `;

    if (request.learningEnabled) {
      prompt +=
        '\n\nPlease also identify patterns that could be learned for future analysis improvements.';
    }

    return prompt;
  }

  private parseEnhancedAIResponse(
    content: string,
    request: AIAnalysisRequest
  ): AIAnalysisResult {
    const lines = content.split('\n').filter(line => line.trim());

    // Enhanced parsing with pattern recognition
    const insights = this.extractInsights(lines);
    const recommendations = this.extractRecommendations(lines);
    const patterns = this.extractPatterns(lines);
    const predictions = this.extractPredictions(lines);

    return {
      insights:
        insights.length > 0 ? insights : this.getDefaultInsights(request.type),
      recommendations:
        recommendations.length > 0
          ? recommendations
          : this.getDefaultRecommendations(request.type),
      confidence: this.calculateConfidence(content, request),
      processingTime: 0,
      timestamp: new Date(),
      context: {
        strategy: request.strategy,
        relevantContextCount: request.relevantContext?.length || 0,
        patternsIdentified: patterns.length,
        predictions: predictions,
      },
      learning: {
        patterns,
        newObservations: this.extractLearningObservations(lines),
      },
    };
  }

  private getAdvancedMockAnalysis(
    request: AIAnalysisRequest
  ): AIAnalysisResult {
    // Enhanced mock results with learning and context awareness
    const contextMultiplier = request.relevantContext ? 1.15 : 1.0;
    const strategyMultiplier = request.strategy ? 1.1 : 1.0;

    const enhancedMockResults = {
      security: {
        insights: [
          'Context-aware security analysis identified patterns in RBAC misconfigurations',
          'Historical data shows network policy violations are most common security issue',
          'Machine learning patterns indicate unauthorized access attempts in similar environments',
          'Predictive analysis suggests container escape vulnerabilities need immediate attention',
        ],
        recommendations: [
          'Implement network policies based on historical security patterns (95% success rate)',
          'Use non-root containers across all deployments (proven effective in 89% of cases)',
          'Enable and configure Pod Security Policies (learned from previous incidents)',
          'Implement automated security scanning based on identified patterns',
          'Deploy predictive security monitoring for anomaly detection',
        ],
        patterns: ['rbac_misconfig_pattern', 'network_policy_violation_trend'],
        predictions: ['container_escape_risk', 'lateral_movement_attempt'],
      },
      performance: {
        insights: [
          'Pattern recognition identifies memory pressure during peak hours (consistent with historical data)',
          'Context-aware analysis shows network latency patterns similar to previous optimizations',
          'Machine learning indicates CPU throttling correlates with specific workloads',
          'Predictive analysis suggests scaling needs for upcoming traffic patterns',
        ],
        recommendations: [
          'Optimize resource requests based on historical usage patterns (92% effectiveness)',
          'Implement horizontal pod autoscaling with predictive scaling (learned thresholds)',
          'Consider service mesh for better observability (proven in similar environments)',
          'Implement predictive performance monitoring based on learned patterns',
          'Optimize network policies based on performance impact analysis',
        ],
        patterns: ['memory_pressure_pattern', 'network_latency_correlation'],
        predictions: ['scaling_event_70%', 'performance_degradation_risk'],
      },
      compliance: {
        insights: [
          'Context-aware compliance analysis shows common patterns in audit logging gaps',
          'Historical data indicates backup procedure compliance issues',
          'Pattern recognition shows recurring documentation deficiencies',
          'Predictive analysis suggests compliance risks in upcoming changes',
        ],
        recommendations: [
          'Implement comprehensive audit logging based on compliance patterns (98% success)',
          'Document and test backup procedures using proven templates',
          'Review compliance using pattern-based checklists',
          'Implement predictive compliance monitoring for risk prevention',
          'Use automated compliance validation based on learned patterns',
        ],
        patterns: ['audit_logging_gap_pattern', 'backup_compliance_trend'],
        predictions: ['compliance_violation_risk', 'audit_failure_probability'],
      },
      cost: {
        insights: [
          'Pattern recognition identifies resource over-provisioning patterns (consistent across environments)',
          'Context-aware analysis shows unused volume patterns similar to historical optimizations',
          'Machine learning identifies inefficient instance sizing patterns',
          'Predictive analysis suggests cost optimization opportunities in upcoming scaling',
        ],
        recommendations: [
          'Right-size instances based on learned usage patterns (94% cost reduction)',
          'Implement resource quotas informed by historical data',
          'Clean up unused resources using pattern-based identification',
          'Consider spot instances for non-critical workloads (proven effective)',
          'Implement predictive cost optimization based on usage patterns',
        ],
        patterns: ['overprovisioning_pattern', 'unused_resource_trend'],
        predictions: ['cost_saving_opportunity', 'budget_overrun_risk'],
      },
    };

    const result =
      enhancedMockResults[request.type] || enhancedMockResults.performance;

    return {
      ...result,
      confidence: Math.min(0.95, 0.78 * contextMultiplier * strategyMultiplier),
      processingTime: 1200,
      timestamp: new Date(),
      context: {
        strategy: request.strategy,
        relevantContextCount: request.relevantContext?.length || 0,
        patternsIdentified: result.patterns?.length || 0,
        predictions: result.predictions || [],
      },
      learning: {
        patterns: result.patterns || [],
        newObservations: [
          'Context-aware analysis completed',
          'Pattern matching applied',
        ],
      },
    };
  }

  private async callClaudeAPI(
    request: AIAnalysisRequest
  ): Promise<AIAnalysisResult> {
    const prompt = redact(this.buildPrompt(request));

    if (this.llmPort) {
      const out = await this.llmPort.complete({
        prompt,
        model: 'claude-3-sonnet-20240229',
        maxTokens: config.services.ai.maxTokens,
      });
      return this.parseAIResponse(out.text);
    }

    const response = await axios.post(
      config.services.ai.endpoint + '/v1/messages',
      {
        model: 'claude-3-sonnet-20240229',
        max_tokens: config.services.ai.maxTokens,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.services.ai.apiKey,
          'anthropic-version': '2023-06-01',
        },
      }
    );

    const content = (response.data as any).content[0].text;
    return this.parseAIResponse(content);
  }

  private buildPrompt(request: AIAnalysisRequest): string {
    const prompts = {
      security: `
        Analyze the following Kubernetes security scan results and provide:
        1. Key security insights and patterns
        2. Prioritized recommendations for remediation
        3. Risk assessment and potential impact
        4. Best practices for improvement

        Data: ${JSON.stringify(request.data, null, 2)}
      `,
      performance: `
        Analyze the following Kubernetes infrastructure performance data and provide:
        1. Performance bottlenecks and optimization opportunities
        2. Resource utilization insights
        3. Scaling recommendations
        4. Architecture improvement suggestions

        Data: ${JSON.stringify(request.data, null, 2)}
      `,
      compliance: `
        Analyze the following Kubernetes resources for compliance issues and provide:
        1. Compliance violations and risks
        2. Regulatory framework alignment
        3. Remediation steps for compliance
        4. Documentation and monitoring recommendations

        Data: ${JSON.stringify(request.data, null, 2)}
      `,
      cost: `
        Analyze the following infrastructure cost data and provide:
        1. Cost optimization opportunities
        2. Resource allocation efficiency
        3. Budget recommendations
        4. Cost-saving strategies

        Data: ${JSON.stringify(request.data, null, 2)}
      `,
    };

    return (
      prompts[request.type] ||
      `
      Analyze the following data and provide insights and recommendations:
      ${JSON.stringify(request.data, null, 2)}
    `
    );
  }

  private parseAIResponse(content: string): AIAnalysisResult {
    // Simple parsing logic - in production, this would be more sophisticated
    const lines = content.split('\n').filter(line => line.trim());

    const insights = lines
      .filter(
        line =>
          line.includes('insight') ||
          line.includes('finding') ||
          line.includes('observation')
      )
      .slice(0, 5);

    const recommendations = lines
      .filter(
        line =>
          line.includes('recommend') ||
          line.includes('suggest') ||
          line.includes('should')
      )
      .slice(0, 5);

    return {
      insights:
        insights.length > 0
          ? insights
          : [
              'Infrastructure analysis completed successfully',
              'Regular monitoring and maintenance recommended',
              'Consider implementing automated remediation',
            ],
      recommendations:
        recommendations.length > 0
          ? recommendations
          : [
              'Review and update security policies regularly',
              'Implement comprehensive monitoring and alerting',
              'Consider infrastructure-as-code practices',
              'Regular backup and disaster recovery testing',
            ],
      confidence: 0.85,
      processingTime: 0,
      timestamp: new Date(),
    };
  }

  private getMockAnalysis(request: AIAnalysisRequest): AIAnalysisResult {
    const mockResults = {
      security: {
        insights: [
          'Multiple security vulnerabilities detected in cluster configuration',
          'RBAC policies need immediate attention',
          'Container security context not properly configured',
        ],
        recommendations: [
          'Implement network policies to restrict pod communication',
          'Use non-root containers across all deployments',
          'Enable and configure Pod Security Policies',
          'Regular security scanning and vulnerability assessment',
        ],
      },
      performance: {
        insights: [
          'Resource utilization shows room for optimization',
          'Some pods experiencing memory pressure',
          'Network latency detected between services',
        ],
        recommendations: [
          'Optimize resource requests and limits',
          'Implement horizontal pod autoscaling',
          'Consider service mesh for better observability',
          'Monitor and optimize network policies',
        ],
      },
      compliance: {
        insights: [
          'Partial compliance with industry standards',
          'Missing audit logging configuration',
          'Backup procedures need documentation',
        ],
        recommendations: [
          'Implement comprehensive audit logging',
          'Document and test backup procedures',
          'Review compliance with relevant regulations',
          'Implement policy-as-code framework',
        ],
      },
      cost: {
        insights: [
          'Resource over-provisioning detected',
          'Unused volumes costing money',
          'Inefficient instance sizing',
        ],
        recommendations: [
          'Right-size instances based on actual usage',
          'Implement resource quotas and limits',
          'Clean up unused resources regularly',
          'Consider spot instances for non-critical workloads',
        ],
      },
    };

    const result = mockResults[request.type] || mockResults.performance;

    return {
      ...result,
      confidence: 0.78,
      processingTime: 1500,
      timestamp: new Date(),
    };
  }

  async healthCheck(): Promise<{
    status: string;
    enabled: boolean;
    apiKeyConfigured: boolean;
    advancedFeatures: any;
  }> {
    const reasoningBankMetrics = this.reasoningBank
      ? { totalExperiences: await this.reasoningBank.count() }
      : null;
    const agentDBCount = this.agentDB ? await this.agentDB.count() : 0;

    return {
      status: 'healthy',
      enabled: config.services.ai.enabled,
      apiKeyConfigured:
        !!config.services.ai.apiKey &&
        config.services.ai.apiKey !== 'your-api-key',
      advancedFeatures: {
        agentDBEnabled: !!this.agentDB,
        agentDBEntries: agentDBCount,
        reasoningBankEnabled: !!this.reasoningBank,
        learningEnabled: this.learningEnabled,
        contextMemorySize: this.contextMemory.length,
        reasoningBankMetrics,
      },
    };
  }

  // Advanced AI Capabilities

  async storeLearningPattern(
    request: AIAnalysisRequest,
    result: AIAnalysisResult
  ): Promise<void> {
    if (!this.agentDB || !result.learning?.patterns.length) return;

    for (const pattern of result.learning.patterns) {
      const learningPattern: AILearningPattern = {
        id: `pattern_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: request.type,
        pattern: pattern,
        confidence: result.confidence,
        successRate: result.insights.length > 0 ? 0.85 : 0.65,
        context: request.context,
        timestamp: new Date(),
        embeddings: new Array(1536).fill(0.1), // Mock embedding
        usageCount: 0,
        lastUsed: new Date(),
      };

      // Legacy `insertPattern(pattern)` had no vector arg. The port
      // requires a vector; we derive a deterministic one from the
      // pattern's `embeddings` (when present) or hash its id.
      const vector = patternToVector(learningPattern);
      await this.agentDB.upsert(vector, learningPattern, {
        type: learningPattern.type,
        patternId: learningPattern.id,
      });
    }
  }

  async analyzeWithPredictiveInsights(
    data: any,
    analysisType: string
  ): Promise<AIAnalysisResult & { predictions: string[] }> {
    const baseAnalysis = await this.performAdvancedAIAnalysis({
      type: analysisType as any,
      data,
      context: `Predictive analysis for ${analysisType}`,
      strategy: 'predictive_analysis',
    });

    // Add predictive insights based on learned patterns
    const predictions = await this.generatePredictions(analysisType, data);

    return {
      ...baseAnalysis,
      predictions,
      context: {
        ...baseAnalysis.context,
        predictiveAnalysis: true,
      },
    };
  }

  private async generatePredictions(
    analysisType: string,
    data: any
  ): Promise<string[]> {
    // Mock predictive insights based on analysis type and historical patterns
    const predictionMap = {
      security: [
        'High probability of container escape attempts in next 30 days',
        'Unauthorized access patterns detected in similar environments',
        'API vulnerability exploitation likely within 2 weeks',
      ],
      performance: [
        'Memory pressure expected to increase by 40% during peak hours',
        'Network latency predicted to degrade by 25% with current scaling',
        'CPU throttling likely at 80% current load within 48 hours',
      ],
      compliance: [
        'Audit logging gaps likely to be flagged in next compliance review',
        'Backup procedures may fail compliance validation in 60 days',
        'Documentation deficiencies expected in upcoming audit',
      ],
      cost: [
        'Resource costs projected to increase 35% without optimization',
        'Unused resources will cost an estimated $2,400/month if not addressed',
        'Instance over-provisioning will result in $8,500 monthly overspend',
      ],
    };

    return (
      (predictionMap as Record<string, string[]>)[analysisType] || [
        'Predictive analysis indicates potential areas for optimization',
      ]
    );
  }

  // Helper methods for enhanced parsing
  private extractInsights(lines: string[]): string[] {
    return lines
      .filter(
        line =>
          line.includes('insight') ||
          line.includes('finding') ||
          line.includes('observation') ||
          line.includes('identified')
      )
      .slice(0, 8);
  }

  private extractRecommendations(lines: string[]): string[] {
    return lines
      .filter(
        line =>
          line.includes('recommend') ||
          line.includes('suggest') ||
          line.includes('should') ||
          line.includes('implement')
      )
      .slice(0, 8);
  }

  private extractPatterns(lines: string[]): string[] {
    return lines
      .filter(
        line =>
          line.includes('pattern') ||
          line.includes('trend') ||
          line.includes('recurrent')
      )
      .slice(0, 5);
  }

  private extractPredictions(lines: string[]): string[] {
    return lines
      .filter(
        line =>
          line.includes('predict') ||
          line.includes('expect') ||
          line.includes('likely') ||
          line.includes('forecast')
      )
      .slice(0, 5);
  }

  private extractLearningObservations(lines: string[]): string[] {
    return lines
      .filter(
        line =>
          line.includes('learn') ||
          line.includes('improvement') ||
          line.includes('enhancement')
      )
      .slice(0, 3);
  }

  private calculateConfidence(
    content: string,
    request: AIAnalysisRequest
  ): number {
    let confidence = 0.85; // Base confidence

    // Boost confidence based on context availability
    if (request.relevantContext && request.relevantContext.length > 0) {
      confidence += 0.05 * Math.min(request.relevantContext.length, 3);
    }

    // Boost confidence based on strategy
    if (request.strategy) {
      confidence += 0.05;
    }

    // Adjust based on content length and quality indicators
    const contentLength = content.length;
    if (contentLength > 1000) confidence += 0.02;
    if (contentLength > 2000) confidence += 0.03;

    // Look for confidence indicators in content
    if (content.includes('high confidence') || content.includes('certain'))
      confidence += 0.05;
    if (content.includes('low confidence') || content.includes('uncertain'))
      confidence -= 0.1;

    return Math.min(0.98, Math.max(0.5, confidence));
  }

  private getDefaultInsights(type: string): string[] {
    const defaults = {
      security: [
        'Security analysis completed with context-aware insights',
        'Historical security patterns applied to current findings',
        'Predictive security assessment performed',
      ],
      performance: [
        'Performance analysis completed with pattern recognition',
        'Historical performance data used for optimization',
        'Predictive scaling recommendations provided',
      ],
      compliance: [
        'Compliance analysis performed with historical context',
        'Pattern-based compliance validation completed',
        'Predictive compliance recommendations generated',
      ],
      cost: [
        'Cost analysis completed with historical optimization patterns',
        'Resource usage patterns analyzed for cost savings',
        'Predictive cost recommendations provided',
      ],
    };

    return (defaults as Record<string, string[]>)[type] || defaults.performance;
  }

  private getDefaultRecommendations(type: string): string[] {
    const defaults = {
      security: [
        'Implement context-aware security monitoring',
        'Apply learned security patterns to infrastructure',
        'Deploy predictive security threat detection',
      ],
      performance: [
        'Optimize resources based on learned usage patterns',
        'Implement predictive scaling based on historical data',
        'Apply performance optimization patterns from similar environments',
      ],
      compliance: [
        'Implement pattern-based compliance monitoring',
        'Apply learned compliance frameworks to infrastructure',
        'Deploy predictive compliance validation',
      ],
      cost: [
        'Apply learned cost optimization patterns',
        'Implement predictive cost monitoring',
        'Use historical data for resource right-sizing',
      ],
    };

    return (defaults as Record<string, string[]>)[type] || defaults.performance;
  }

  // Context Management Methods
  async updateContextMemory(context: AIContext): Promise<void> {
    if (this.agentDB) {
      // Legacy `updateContext(ctx)` mapped to a port `upsert(vector,
      // payload, metadata)`. Use the context's own embedding if it has
      // one, otherwise hash its content for a stable vector.
      const vector =
        Array.isArray(context.embeddings) && context.embeddings.length > 0
          ? context.embeddings
          : stringToVector(context.content || context.id);
      await this.agentDB.upsert(vector, context, {
        contextId: context.id,
        type: context.type,
      });
    }

    // Update local cache
    const index = this.contextMemory.findIndex(ctx => ctx.id === context.id);
    if (index >= 0) {
      this.contextMemory[index] = context;
    } else {
      this.contextMemory.push(context);
    }
  }

  async getContextMemory(
    query: string,
    limit: number = 5
  ): Promise<AIContext[]> {
    if (this.agentDB) {
      // Legacy `retrieveContext(query, opts)` mapped to `query(vector,
      // k, filter)`. We hash the string query to a vector here.
      const fromDB = await this.retrieveContext(query, limit);
      if (fromDB.length > 0) return fromDB;
    }

    // Fallback to local search
    return this.contextMemory
      .filter(ctx => ctx.content.toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, limit);
  }

  async getLearningMetrics(): Promise<any> {
    if (!this.reasoningBank) {
      return { learningEnabled: false };
    }

    const totalExperiences = await this.reasoningBank.count();
    return {
      learningEnabled: this.learningEnabled,
      contextMemorySize: this.contextMemory.length,
      agentDBEnabled: !!this.agentDB,
      reasoningBankMetrics: { totalExperiences },
    };
  }

  enableLearning(enabled: boolean): void {
    this.learningEnabled = enabled;
    this.logOperation('Learning ' + (enabled ? 'enabled' : 'disabled'));
  }
}
