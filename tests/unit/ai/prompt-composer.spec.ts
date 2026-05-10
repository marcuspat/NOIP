// PromptComposer — template stability + cache_control flagging.

import { PromptComposer } from '../../../src/contexts/ai/domain/prompt-composer';
import type { RagHit } from '../../../src/contexts/ai/domain/ports/rag-store';

const RAG: RagHit[] = [
  {
    id: 'sha256:c1',
    content: 'historical: privileged container in cluster',
    metadata: { type: 'incident', source: 'audit' },
    score: 0.9,
  },
  {
    id: 'sha256:c2',
    content: 'historical: missing network policy',
    metadata: { type: 'incident' },
    score: 0.8,
  },
];

describe('PromptComposer', () => {
  it('produces a stable system-prompt hash for a given template', () => {
    const c = new PromptComposer();
    const a = c.compose({
      templateName: 'security_focused',
      scopePayload: { foo: 1 },
      retrieved: RAG,
    });
    const b = c.compose({
      templateName: 'security_focused',
      scopePayload: { foo: 'different' },
      retrieved: [],
    });
    expect(a.systemPromptHash).toBe(b.systemPromptHash);
    expect(a.systemPromptHash.startsWith('sha256:')).toBe(true);
  });

  it('flags the system message as cacheable for prompt caching', () => {
    const c = new PromptComposer();
    const out = c.compose({
      templateName: 'comprehensive',
      scopePayload: { x: 1 },
      retrieved: [],
    });
    const sys = out.messages.find(m => m.role === 'system');
    expect(sys?.cacheable).toBe(true);
  });

  it('renders retrieved RAG chunks into the user message in order', () => {
    const c = new PromptComposer();
    const out = c.compose({
      templateName: 'security_focused',
      scopePayload: { incident: 'x' },
      retrieved: RAG,
    });
    const user = out.messages.find(m => m.role === 'user')?.content ?? '';
    expect(user).toContain('historical: privileged container in cluster');
    expect(user.indexOf('[#1]')).toBeLessThan(user.indexOf('[#2]'));
  });

  it('records retrieved AIContextRefs with score + type', () => {
    const c = new PromptComposer();
    const out = c.compose({
      templateName: 'comprehensive',
      scopePayload: {},
      retrieved: RAG,
    });
    expect(out.retrieved.map(r => r.id)).toEqual(['sha256:c1', 'sha256:c2']);
    expect(out.retrieved[0]?.type).toBe('incident');
  });

  it('maps analysis types to template names per DDD-08', () => {
    expect(PromptComposer.templateForAnalysisType('security')).toBe(
      'security_focused'
    );
    expect(PromptComposer.templateForAnalysisType('cost')).toBe(
      'cost_optimization'
    );
    expect(PromptComposer.templateForAnalysisType('compliance')).toBe(
      'compliance'
    );
  });
});
