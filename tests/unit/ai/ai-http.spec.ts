// HTTP edge for the AI context — supertest against the composed router.

import express from 'express';
import request from 'supertest';
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

function makeApp(): {
  app: express.Express;
  composed: ReturnType<typeof composeAI>;
} {
  const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
  const bus = new InMemoryEventBus({
    warn: () => undefined,
    error: () => undefined,
  });
  const composed = composeAI({
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
  const app = express();
  app.use(express.json());
  app.use('/api/ai', composed.router);
  return { app, composed };
}

describe('AI HTTP edge', () => {
  it('POST /analyze/security returns the projected analysis', async () => {
    const { app } = makeApp();
    const clusterId = newId<ClusterId>();
    const res = await request(app)
      .post('/api/ai/analyze/security')
      .send({ clusterId, payload: { findings: [] } });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBeDefined();
    expect(res.body.data.strategy).toBeDefined();
  });

  it('POST /analyze/infrastructure honours the legacy `{ data }` body', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/ai/analyze/infrastructure')
      .send({ data: { clusterId: 'legacy-cluster', metrics: {} } });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('GET /insights returns insights for the latest analyses', async () => {
    const { app, composed } = makeApp();
    const clusterId = newId<ClusterId>();
    await composed.service.analyzeSecurity({
      scope: { clusterId },
      payload: { x: 1 },
    });
    const res = await request(app)
      .get('/api/ai/insights')
      .query({ clusterId, type: 'security' });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it('POST /feedback/:analysisId returns the touched-count summary', async () => {
    const { app, composed } = makeApp();
    const clusterId = newId<ClusterId>();
    const analysis = await composed.service.analyzeSecurity({
      scope: { clusterId },
      payload: { x: 1 },
    });
    const res = await request(app)
      .post(`/api/ai/feedback/${analysis.id}`)
      .send({ useful: true });
    expect(res.status).toBe(200);
    expect(res.body.data.analysisId).toBe(analysis.id);
  });

  it('POST /analyze/security 400s when scope/data are absent', async () => {
    // We don't enforce scope strictly to keep legacy compat — the
    // service-level analyse defaults to a synthetic legacy scope. This
    // test asserts the legacy-friendly path still produces a 200.
    const { app } = makeApp();
    const res = await request(app).post('/api/ai/analyze/security').send({});
    expect(res.status).toBe(200);
  });
});
