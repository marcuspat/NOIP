import { MockAgentDB } from '../../../../src/services/ai/mock-agentdb.adapter';
import { MockReasoningBank } from '../../../../src/services/ai/mock-reasoning-bank.adapter';
import { MockLLMClient } from '../../../../src/services/ai/mock-llm.client';

describe('MockAgentDB', () => {
  it('upsert + query returns nearest by cosine similarity', async () => {
    const db = new MockAgentDB();
    const idA = await db.upsert([1, 0, 0], { name: 'a' });
    const idB = await db.upsert([0, 1, 0], { name: 'b' });
    const idC = await db.upsert([0.9, 0.1, 0], { name: 'c' });

    const results = await db.query([1, 0, 0], 2);

    expect(results).toHaveLength(2);
    expect(results[0]?.id).toBe(idA);
    expect(results[1]?.id).toBe(idC);
    expect(results[0]?.score).toBeCloseTo(1, 5);
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? -Infinity);
    // idB is excluded because it has the lowest score and k = 2
    expect(results.map(r => r.id)).not.toContain(idB);
  });

  it('returns deterministic ordering across runs', async () => {
    const make = async () => {
      const db = new MockAgentDB();
      await db.upsert([1, 0], { n: 1 });
      await db.upsert([0, 1], { n: 2 });
      await db.upsert([1, 1], { n: 3 });
      return db.query([1, 0.5], 3);
    };

    const a = await make();
    const b = await make();
    expect(a).toEqual(b);
  });

  it('delete removes entries and count tracks', async () => {
    const db = new MockAgentDB();
    expect(await db.count()).toBe(0);

    const id1 = await db.upsert([1, 0], { v: 1 });
    await db.upsert([0, 1], { v: 2 });
    expect(await db.count()).toBe(2);

    await db.delete(id1);
    expect(await db.count()).toBe(1);

    const results = await db.query([1, 0], 5);
    expect(results.map(r => r.id)).not.toContain(id1);
  });

  it('delete is a no-op on unknown ids', async () => {
    const db = new MockAgentDB();
    await db.upsert([1, 0], {});
    await expect(db.delete('nonexistent')).resolves.toBeUndefined();
    expect(await db.count()).toBe(1);
  });

  it('filter narrows query results by metadata equality', async () => {
    const db = new MockAgentDB();
    await db.upsert([1, 0], { name: 'a' }, { tenant: 'x', kind: 'doc' });
    await db.upsert([1, 0], { name: 'b' }, { tenant: 'y', kind: 'doc' });
    await db.upsert([1, 0], { name: 'c' }, { tenant: 'x', kind: 'note' });

    const results = await db.query([1, 0], 10, { tenant: 'x' });

    expect(results).toHaveLength(2);
    const names = results.map(r => (r.payload as { name: string }).name).sort();
    expect(names).toEqual(['a', 'c']);

    const narrower = await db.query([1, 0], 10, { tenant: 'x', kind: 'doc' });
    expect(narrower).toHaveLength(1);
    expect((narrower[0]?.payload as { name: string }).name).toBe('a');
  });

  it('filter excludes entries without metadata', async () => {
    const db = new MockAgentDB();
    await db.upsert([1, 0], { name: 'no-meta' });
    await db.upsert([1, 0], { name: 'with-meta' }, { tenant: 'x' });

    const results = await db.query([1, 0], 10, { tenant: 'x' });
    expect(results).toHaveLength(1);
    expect((results[0]?.payload as { name: string }).name).toBe('with-meta');
  });
});

describe('MockReasoningBank', () => {
  const ctx = { task: 'analyze', region: 'us-east' };
  const stratA = { id: 'A', description: 'strategy A' };
  const stratB = { id: 'B', description: 'strategy B' };

  it('records and recommends ranked strategies for a context', async () => {
    const bank = new MockReasoningBank();

    // A: 2/3 success → (2+1)/(3+2) = 0.6
    await bank.recordExperience({ context: ctx, strategy: stratA, outcome: { success: true } });
    await bank.recordExperience({ context: ctx, strategy: stratA, outcome: { success: true } });
    await bank.recordExperience({ context: ctx, strategy: stratA, outcome: { success: false } });

    // B: 0/1 success → (0+1)/(1+2) ≈ 0.333
    await bank.recordExperience({ context: ctx, strategy: stratB, outcome: { success: false } });

    const recs = await bank.recommendStrategy(ctx);

    expect(recs).toHaveLength(2);
    expect(recs[0]?.strategy.id).toBe('A');
    expect(recs[0]?.weight).toBeCloseTo(0.6, 5);
    expect(recs[1]?.strategy.id).toBe('B');
    expect(recs[1]?.weight).toBeCloseTo(1 / 3, 5);
  });

  it('Laplace smoothing surfaces a never-successful strategy', async () => {
    const bank = new MockReasoningBank();
    await bank.recordExperience({ context: ctx, strategy: stratA, outcome: { success: false } });
    const recs = await bank.recommendStrategy(ctx);
    expect(recs).toHaveLength(1);
    // (0 + 1) / (1 + 2) = 1/3, strictly > 0
    expect(recs[0]?.weight).toBeCloseTo(1 / 3, 5);
    expect(recs[0]?.weight).toBeGreaterThan(0);
  });

  it('identical contexts dedupe into one bucket per strategy', async () => {
    const bank = new MockReasoningBank();
    const ctxA = { task: 'analyze', region: 'us-east' };
    const ctxB = { task: 'analyze', region: 'us-east' }; // structurally identical

    await bank.recordExperience({ context: ctxA, strategy: stratA, outcome: { success: true } });
    await bank.recordExperience({ context: ctxB, strategy: stratA, outcome: { success: true } });

    const recs = await bank.recommendStrategy({ task: 'analyze', region: 'us-east' });
    expect(recs).toHaveLength(1);
    // (2+1)/(2+2) = 0.75
    expect(recs[0]?.weight).toBeCloseTo(0.75, 5);
  });

  it('recency breaks ties on equal weight', async () => {
    const bank = new MockReasoningBank();
    // Both strategies have 1/1 → weight (1+1)/(1+2) = 2/3
    await bank.recordExperience({ context: ctx, strategy: stratA, outcome: { success: true } });
    await bank.recordExperience({ context: ctx, strategy: stratB, outcome: { success: true } });

    const recs = await bank.recommendStrategy(ctx);
    expect(recs[0]?.strategy.id).toBe('B'); // most recent
    expect(recs[1]?.strategy.id).toBe('A');
  });

  it('only returns strategies for the requested context', async () => {
    const bank = new MockReasoningBank();
    await bank.recordExperience({
      context: { task: 'one' },
      strategy: stratA,
      outcome: { success: true },
    });
    await bank.recordExperience({
      context: { task: 'two' },
      strategy: stratB,
      outcome: { success: true },
    });

    const recs = await bank.recommendStrategy({ task: 'one' });
    expect(recs).toHaveLength(1);
    expect(recs[0]?.strategy.id).toBe('A');
  });

  it('count tracks total recorded experiences', async () => {
    const bank = new MockReasoningBank();
    expect(await bank.count()).toBe(0);
    await bank.recordExperience({ context: ctx, strategy: stratA, outcome: { success: true } });
    await bank.recordExperience({ context: ctx, strategy: stratA, outcome: { success: false } });
    expect(await bank.count()).toBe(2);
  });
});

describe('MockLLMClient', () => {
  it('produces deterministic output for the same prompt', async () => {
    const client = new MockLLMClient();
    const a = await client.complete({ prompt: 'hello world' });
    const b = await client.complete({ prompt: 'hello world' });
    expect(a.text).toBe(b.text);
  });

  it('produces different output for different prompts', async () => {
    const client = new MockLLMClient();
    const a = await client.complete({ prompt: 'hello' });
    const b = await client.complete({ prompt: 'goodbye' });
    expect(a.text).not.toBe(b.text);
  });

  it('usage.totalTokens === promptTokens + completionTokens', async () => {
    const client = new MockLLMClient();
    const result = await client.complete({ prompt: 'one two three four five' });
    expect(result.usage).toBeDefined();
    expect(result.usage!.totalTokens).toBe(
      result.usage!.promptTokens + result.usage!.completionTokens
    );
    expect(result.usage!.promptTokens).toBe(5);
  });

  it('respects a string canned override', async () => {
    const client = new MockLLMClient({ canned: 'fixed response' });
    const result = await client.complete({ prompt: 'anything at all' });
    expect(result.text).toBe('fixed response');
  });

  it('respects a function canned override', async () => {
    const client = new MockLLMClient({
      canned: prompt => `echo:${prompt.toUpperCase()}`,
    });
    const result = await client.complete({ prompt: 'hi' });
    expect(result.text).toBe('echo:HI');
  });

  it("finishReason is 'stop' on the default path", async () => {
    const client = new MockLLMClient();
    const result = await client.complete({ prompt: 'whatever' });
    expect(result.finishReason).toBe('stop');
  });

  it("modelUsed is 'mock-llm-1'", async () => {
    const client = new MockLLMClient();
    const result = await client.complete({ prompt: 'test' });
    expect(result.modelUsed).toBe('mock-llm-1');
  });
});
