// PromptComposer — builds typed messages from registered templates and
// retrieved RAG context.
//
// Templates are stable. The composer caches the system-prompt hash by
// template name so the AnthropicAdapter can attach `cache_control:
// ephemeral` to the same string across calls (Anthropic prompt caching).
//
// Output is provider-neutral (LLMMessage[]); the adapter translates.

import { createHash } from 'node:crypto';
import type { LLMMessage } from './ports/llm-client';
import type {
  AIContextRef,
  AnalysisType,
  PromptTemplateName,
} from './value-objects';
import type { RagHit } from './ports/rag-store';

export interface PromptTemplate {
  name: PromptTemplateName;
  /**
   * Stable system prompt. Anything user-specific belongs in the user
   * message; this string is hashed and reused so prompt caching works.
   */
  system: string;
  /** Default top-k retrieval. */
  topK: number;
  /** Default RAG metadata filter. */
  filter?: Record<string, unknown>;
  /** Header for the user message — followed by the rendered scope JSON. */
  userIntro: string;
}

/**
 * Default template registry. The names align with the analysis types
 * used by the AIService and the HTTP edge.
 */
export const DEFAULT_TEMPLATES: Readonly<
  Record<PromptTemplateName, PromptTemplate>
> = {
  comprehensive: {
    name: 'comprehensive',
    system: [
      'You are NOIP, an infrastructure intelligence assistant.',
      'You produce *grounded* analyses based on the provided context.',
      'Always emit the JSON schema below; do not include any text outside it.',
      'Schema: { "insights": [...], "recommendations": [...], "predictions": [...], "confidence": number }',
      'Each insight must include "supportingContextIds" referencing the RAG ids you used.',
    ].join('\n'),
    topK: 6,
    userIntro: 'Comprehensive infrastructure analysis. Scope payload follows:',
  },
  security_focused: {
    name: 'security_focused',
    system: [
      'You are NOIP, a Kubernetes security analyst.',
      'Reason from the provided findings + RAG context only; do not speculate.',
      'Always emit the JSON schema below.',
      'Schema: { "insights": [...], "recommendations": [...], "predictions": [...], "confidence": number }',
      'Each insight must cite "supportingContextIds".',
    ].join('\n'),
    topK: 8,
    filter: { type: 'incident' },
    userIntro: 'Security analysis. Scope + recent findings follow:',
  },
  performance_optimization: {
    name: 'performance_optimization',
    system: [
      'You are NOIP, a Kubernetes performance optimisation assistant.',
      'Reason from metrics + retrieved context. No speculation.',
      'Always emit the JSON schema below.',
      'Schema: { "insights": [...], "recommendations": [...], "predictions": [...], "confidence": number }',
    ].join('\n'),
    topK: 5,
    userIntro: 'Performance analysis. Metrics follow:',
  },
  cost_optimization: {
    name: 'cost_optimization',
    system: [
      'You are NOIP, a Kubernetes cost optimisation assistant.',
      'Reason from usage data + retrieved context. No speculation.',
      'Always emit the JSON schema below.',
      'Schema: { "insights": [...], "recommendations": [...], "predictions": [...], "confidence": number }',
    ].join('\n'),
    topK: 5,
    userIntro: 'Cost analysis. Usage payload follows:',
  },
  compliance: {
    name: 'compliance',
    system: [
      'You are NOIP, a compliance analyst.',
      'Map findings to the relevant frameworks (SOC2, ISO27001, HIPAA, PCI-DSS, GDPR).',
      'Always emit the JSON schema below.',
      'Schema: { "insights": [...], "recommendations": [...], "predictions": [...], "confidence": number }',
      'Cite supporting context for every insight.',
    ].join('\n'),
    topK: 6,
    filter: { type: 'compliance' },
    userIntro: 'Compliance analysis. Resources + findings follow:',
  },
};

export interface ComposedPrompt {
  messages: LLMMessage[];
  /** Stable hash of the system prompt — used as Strategy.promptTemplateHash. */
  systemPromptHash: string;
  /** Selected RAG references used to ground the prompt. */
  retrieved: AIContextRef[];
}

export interface ComposeOptions {
  templateName: PromptTemplateName;
  /** Already-redacted scope payload to render into the user message. */
  scopePayload: unknown;
  /** Top retrieved chunks, ranked descending by score. */
  retrieved: RagHit[];
  /** Optional extra user-message tail (already redacted). */
  extraContext?: string;
}

/**
 * Compose a prompt for the LLM. Pure; no I/O.
 */
export class PromptComposer {
  private readonly templates: Record<PromptTemplateName, PromptTemplate>;
  // Stable hash cache; key = template name.
  private readonly systemHashCache = new Map<PromptTemplateName, string>();
  // Stable hash cache; key = system prompt content (so registered
  // overrides hash the same as the original when content matches).
  private readonly systemHashByContent = new Map<string, string>();

  constructor(
    templates: Readonly<
      Record<PromptTemplateName, PromptTemplate>
    > = DEFAULT_TEMPLATES
  ) {
    this.templates = { ...templates };
  }

  /** Look up a template by name (or by analysis type, see `forAnalysisType`). */
  getTemplate(name: PromptTemplateName): PromptTemplate {
    return this.templates[name];
  }

  /** Map AnalysisType → template name. */
  static templateForAnalysisType(t: AnalysisType): PromptTemplateName {
    switch (t) {
      case 'security':
        return 'security_focused';
      case 'performance':
        return 'performance_optimization';
      case 'cost':
        return 'cost_optimization';
      case 'compliance':
        return 'compliance';
      case 'comprehensive':
      default:
        return 'comprehensive';
    }
  }

  /**
   * Build the final messages plus a stable hash of the system prompt
   * (used as Strategy.promptTemplateHash and the prompt-cache key).
   */
  compose(opts: ComposeOptions): ComposedPrompt {
    const tpl = this.templates[opts.templateName];
    const systemPromptHash = this.hashSystem(tpl);

    const ragChunks = opts.retrieved
      .map(
        (h, i) =>
          `[#${i + 1}] (id=${h.id}, score=${h.score.toFixed(3)})\n${h.content}`
      )
      .join('\n\n');

    const userParts: string[] = [tpl.userIntro];
    if (ragChunks.length > 0) {
      userParts.push('Retrieved RAG context:');
      userParts.push(ragChunks);
    }
    userParts.push('Scope payload:');
    userParts.push(safeStringify(opts.scopePayload));
    if (opts.extraContext) {
      userParts.push('Additional context:');
      userParts.push(opts.extraContext);
    }
    userParts.push(
      'Respond with the JSON schema described in the system prompt only.'
    );

    const messages: LLMMessage[] = [
      { role: 'system', content: tpl.system, cacheable: true },
      { role: 'user', content: userParts.join('\n\n') },
    ];

    const retrieved: AIContextRef[] = opts.retrieved.map(h => {
      const ref: AIContextRef = {
        id: h.id as AIContextRef['id'],
        score: h.score,
      };
      const t = h.metadata['type'];
      if (typeof t === 'string') ref.type = t;
      const s = h.metadata['source'];
      if (typeof s === 'string') ref.source = s;
      return ref;
    });

    return { messages, systemPromptHash, retrieved };
  }

  private hashSystem(tpl: PromptTemplate): string {
    const cached = this.systemHashCache.get(tpl.name);
    if (cached) return cached;
    const cachedByContent = this.systemHashByContent.get(tpl.system);
    if (cachedByContent) {
      this.systemHashCache.set(tpl.name, cachedByContent);
      return cachedByContent;
    }
    const h = 'sha256:' + createHash('sha256').update(tpl.system).digest('hex');
    this.systemHashCache.set(tpl.name, h);
    this.systemHashByContent.set(tpl.system, h);
    return h;
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
