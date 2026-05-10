// AnalysisOrchestrator — security.scan.completed triggers, debounce
// (24h discovery.cluster.scanned), idempotency lock.

import {
  composeAI,
  InMemoryAnalysisRepository,
  InMemoryLearningPatternRepository,
  InMemoryAIContextProjectionRepository,
  InMemoryRagStore,
  NoOpIngestionBridge,
  AnthropicAdapter,
} from '../../../src/contexts/ai/api';
import {
  FixedClock,
  InMemoryEventBus,
  newId,
  type ClusterId,
} from '../../../src/shared/kernel';

function setup(): ReturnType<typeof composeAI> {
  const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
  const bus = new InMemoryEventBus({
    warn: () => undefined,
    error: () => undefined,
  });
  return composeAI({
    bus,
    clock,
    llmClient: new AnthropicAdapter({ clock }),
    ragStore: new InMemoryRagStore(),
    ingestion: new NoOpIngestionBridge(),
    repos: {
      analyses: new InMemoryAnalysisRepository(),
      patterns: new InMemoryLearningPatternRepository(),
      contexts: new InMemoryAIContextProjectionRepository(),
    },
  });
}

describe('AnalysisOrchestrator', () => {
  it('triggers security analysis when scan score < 70', async () => {
    const composed = setup();
    const cluster = newId<ClusterId>();
    const out = await composed.orchestrator.onSecurityScanCompleted({
      scanId: 'scan-1',
      scope: { clusterId: cluster },
      counts: { critical: 0, high: 2 },
      score: 55,
    });
    expect((out as { skipped: false }).skipped).toBe(false);
  });

  it('skips when the scan score is healthy and no critical findings', async () => {
    const composed = setup();
    const cluster = newId<ClusterId>();
    const out = await composed.orchestrator.onSecurityScanCompleted({
      scanId: 'scan-2',
      scope: { clusterId: cluster },
      counts: { critical: 0, high: 0 },
      score: 95,
    });
    expect((out as { skipped: true; reason: string }).skipped).toBe(true);
  });

  it('always triggers when there is a critical finding count', async () => {
    const composed = setup();
    const cluster = newId<ClusterId>();
    const out = await composed.orchestrator.onSecurityScanCompleted({
      scanId: 'scan-3',
      scope: { clusterId: cluster },
      counts: { critical: 1, high: 0 },
      score: 99,
    });
    expect((out as { skipped: false }).skipped).toBe(false);
  });

  it('debounces discovery.cluster.scanned within the 24h lock', async () => {
    const composed = setup();
    const cluster = newId<ClusterId>();
    const a = await composed.orchestrator.onClusterScanned({
      clusterId: cluster,
      scanId: 'scan-x',
    });
    const b = await composed.orchestrator.onClusterScanned({
      clusterId: cluster,
      scanId: 'scan-y',
    });
    expect((a as { skipped: false }).skipped).toBe(false);
    expect((b as { skipped: true; reason: string }).reason).toBe(
      'debounced_24h'
    );
  });

  it('idempotency lock blocks duplicate scan-completed for the same scanId', async () => {
    const composed = setup();
    const cluster = newId<ClusterId>();
    const payload = {
      scanId: 'dup-scan',
      scope: { clusterId: cluster },
      counts: { critical: 1 },
      score: 60,
    };
    const a = await composed.orchestrator.onSecurityScanCompleted(payload);
    const b = await composed.orchestrator.onSecurityScanCompleted(payload);
    expect((a as { skipped: false }).skipped).toBe(false);
    expect((b as { skipped: true; reason: string }).reason).toBe(
      'idempotent_lock'
    );
  });
});
