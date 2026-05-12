/**
 * ADR-0011 integration tests for `AIService` <-> port wiring.
 *
 * These tests verify that:
 *   1. When an `ILLMClient` is injected, the LLM code path runs through
 *      the port and never hits axios (i.e. no real HTTP).
 *   2. When no ports are injected, `initialize()` succeeds and the
 *      service is backed by the in-process Mock adapters from
 *      `src/services/ai/`.
 *
 * We mock the `axios` module up-front so that any accidental fall-through
 * to the legacy HTTP path is caught loudly instead of escaping the test.
 *
 * We also mock `../../../../src/config` so we can flip the AI api key at
 * will without touching real env vars (config snapshots them at import).
 */

import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('../../../../src/config', () => ({
  config: {
    services: {
      ai: {
        enabled: true,
        apiKey: 'test-key',
        endpoint: 'https://api.anthropic.test',
        maxTokens: 1000,
      },
    },
  },
}));

import { config } from '../../../../src/config';
import { AIService } from '../../../../src/services/ai.service';
import { MockLLMClient } from '../../../../src/services/ai/mock-llm.client';
import { MockAgentDB } from '../../../../src/services/ai/mock-agentdb.adapter';
import { MockReasoningBank } from '../../../../src/services/ai/mock-reasoning-bank.adapter';

describe('AIService (ADR-0011 ports integration)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset config defaults each test — individual tests may override.
    (config as any).services.ai.enabled = true;
    (config as any).services.ai.apiKey = 'test-key';
  });

  describe('with an injected ILLMClient port', () => {
    it('uses the LLM port and never calls axios', async () => {
      const llm = new MockLLMClient({
        canned:
          'insight: identified bottleneck pattern\nrecommend: implement caching\nshould scale horizontally',
      });
      const completeSpy = jest.spyOn(llm, 'complete');

      const service = new AIService({ llm });
      await service.initialize();

      const result = await service.analyzeSecurity([
        { kind: 'Pod', metadata: { name: 'p' } },
      ]);

      expect(result).toBeDefined();
      expect(result.insights.length).toBeGreaterThan(0);
      expect(result.recommendations.length).toBeGreaterThan(0);
      expect(completeSpy).toHaveBeenCalledTimes(1);
      // Critically: axios must never be called when an LLM port is wired.
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('returns deterministic output for the same canned response', async () => {
      const llm = new MockLLMClient({
        canned: 'insight: stable observation\nrecommend: keep monitoring',
      });
      const service = new AIService({ llm });
      await service.initialize();

      const a = await service.analyzeCompliance([{ kind: 'X' }]);
      const b = await service.analyzeCompliance([{ kind: 'X' }]);

      expect(a.insights).toEqual(b.insights);
      expect(a.recommendations).toEqual(b.recommendations);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('respects the default MockLLMClient hash-based output', async () => {
      const llm = new MockLLMClient(); // no canned override
      const service = new AIService({ llm });
      await service.initialize();

      // Just confirm we get a result and that axios was bypassed.
      const result = await service.analyzeCost({ total: 100 });
      expect(result).toBeDefined();
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });
  });

  describe('with no ports injected', () => {
    it('initialize() falls back to mock adapters without throwing', async () => {
      // Remove apiKey so the mock-analysis branch is taken (no LLM at all).
      (config as any).services.ai.apiKey = '';

      const service = new AIService();
      await expect(service.initialize()).resolves.toBeUndefined();

      const health = await service.healthCheck();
      expect(health.advancedFeatures.agentDBEnabled).toBe(true);
      expect(health.advancedFeatures.reasoningBankEnabled).toBe(true);
      // The two default contexts loaded by loadContextMemory should have
      // been mirrored into the mock AgentDB.
      expect(health.advancedFeatures.agentDBEntries).toBeGreaterThanOrEqual(2);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('analyzeInfrastructure works end-to-end against the default mock ports', async () => {
      (config as any).services.ai.apiKey = '';
      const service = new AIService();
      await service.initialize();

      const result = await service.analyzeInfrastructure({
        nodes: [{ name: 'n1' }, { name: 'n2' }],
        metrics: { cpu: 0.4 },
      });

      expect(result).toBeDefined();
      expect(Array.isArray(result.insights)).toBe(true);
      expect(Array.isArray(result.recommendations)).toBe(true);
      expect(mockedAxios.post).not.toHaveBeenCalled();

      // A successful run should have recorded one experience in the bank.
      const metrics = await service.getLearningMetrics();
      expect(metrics.learningEnabled).toBe(true);
      expect(metrics.reasoningBankMetrics.totalExperiences).toBeGreaterThan(0);
    });
  });

  describe('with explicit AgentDB / ReasoningBank ports', () => {
    it('uses the injected ports rather than the default mocks', async () => {
      (config as any).services.ai.apiKey = '';

      const agentDB = new MockAgentDB();
      const reasoningBank = new MockReasoningBank();
      const upsertSpy = jest.spyOn(agentDB, 'upsert');
      const recordSpy = jest.spyOn(reasoningBank, 'recordExperience');

      const service = new AIService({ agentDB, reasoningBank });
      await service.initialize();

      // loadContextMemory mirrors its bootstrap contexts into the injected
      // AgentDB. This proves the constructor-supplied port was used.
      expect(upsertSpy).toHaveBeenCalled();

      await service.analyzeInfrastructure({ nodes: [], metrics: null });
      expect(recordSpy).toHaveBeenCalled();
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });
  });
});
