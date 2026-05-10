import { ILLMClient } from './ports';

export interface MockLLMClientOptions {
  /**
   * Either a fixed response string, or a function that produces the
   * response from the prompt. When set, `complete` returns this verbatim
   * instead of the templated default.
   */
  canned?: string | ((prompt: string) => string);
}

const MODEL_NAME = 'mock-llm-1';

/**
 * Deterministic in-process `ILLMClient` for tests.
 *
 * Default behaviour: produce a templated response of the form
 * `"mock-llm-1: <hash>"` where `<hash>` is a stable 32-bit FNV-1a hash of
 * the prompt rendered as 8 hex digits. This guarantees the same prompt
 * always yields the same text without any randomness.
 *
 * Pass `{ canned }` to override the default — handy when a test needs to
 * pin a specific response.
 *
 * `usage` is a naive whitespace-split token count (good enough for tests
 * that only need `promptTokens + completionTokens === totalTokens`), and
 * `modelUsed` is always `'mock-llm-1'`.
 */
export class MockLLMClient implements ILLMClient {
  private readonly canned?: string | ((prompt: string) => string);

  constructor(options: MockLLMClientOptions = {}) {
    if (options.canned !== undefined) {
      this.canned = options.canned;
    }
  }

  async complete(input: {
    prompt: string;
    model?: string;
    maxTokens?: number;
    temperature?: number;
    metadata?: Record<string, unknown>;
  }): Promise<{
    text: string;
    finishReason: 'stop' | 'length' | 'error';
    usage?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
    modelUsed: string;
  }> {
    const text =
      this.canned !== undefined
        ? typeof this.canned === 'function'
          ? this.canned(input.prompt)
          : this.canned
        : `${MODEL_NAME}: ${fnv1a32(input.prompt)}`;

    const promptTokens = countTokens(input.prompt);
    const completionTokens = countTokens(text);

    return {
      text,
      finishReason: 'stop',
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      modelUsed: MODEL_NAME,
    };
  }
}

function countTokens(s: string): number {
  if (!s) return 0;
  const trimmed = s.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/** 32-bit FNV-1a hash, returned as 8-character lowercase hex. */
function fnv1a32(s: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    // Equivalent to multiply by 16777619 mod 2^32.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
