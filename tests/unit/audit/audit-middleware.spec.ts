import express, { type Express } from 'express';
import request from 'supertest';

import {
  FixedClock,
  InMemoryEventBus,
  type DomainEvent,
  type EventBus,
} from '../../../src/shared/kernel';
import { HashChainAppender } from '../../../src/services/audit/hash-chain-appender.service';
import {
  auditMiddleware,
  NON_AUDITED_PATHS,
} from '../../../src/middleware/audit.middleware';
import { InMemoryAuditCollection, CapturingLogger } from './_stubs';

class RecordingBus extends InMemoryEventBus {
  public readonly events: Array<DomainEvent<unknown>> = [];
  override publish<T>(event: DomainEvent<T>): void {
    this.events.push(event as DomainEvent<unknown>);
    super.publish(event);
  }
}

function buildApp(
  appender: HashChainAppender,
  attachUser?: { _id: string }
): Express {
  const app = express();
  app.use(express.json());
  app.use(auditMiddleware({ appender }));
  if (attachUser) {
    app.use((req, _res, next) => {
      (req as unknown as { user: { _id: string } }).user = attachUser;
      next();
    });
  }
  app.get('/health/live', (_req, res) => {
    res.json({ status: 'live' });
  });
  app.get('/metrics', (_req, res) => {
    res.send('# HELP\n');
  });
  app.post('/api/users/:id', (req, res) => {
    res.status(201).json({ id: req.params['id'] });
  });
  app.get('/api/boom', (_req, res) => {
    res.status(500).json({ error: 'boom' });
  });
  return app;
}

function buildBusApp(bus: EventBus): Express {
  const app = express();
  app.use(express.json());
  app.use(
    auditMiddleware({
      bus,
      clock: new FixedClock(new Date('2026-05-10T00:00:00Z')),
    })
  );
  app.post('/api/users/:id', (req, res) => {
    res.status(201).json({ id: req.params['id'] });
  });
  app.get('/health/live', (_req, res) => {
    res.json({ status: 'live' });
  });
  return app;
}

function buildAppender(): {
  appender: HashChainAppender;
  collection: InMemoryAuditCollection;
  logger: CapturingLogger;
} {
  const collection = new InMemoryAuditCollection();
  const logger = new CapturingLogger();
  const appender = new HashChainAppender({
    collection,
    clock: new FixedClock(new Date('2026-05-10T00:00:00Z')),
    logger,
  });
  return { appender, collection, logger };
}

/** Wait for the response-finish-driven persistence to flush. */
async function flush(): Promise<void> {
  // The middleware schedules `appender.append(...).catch(...)` from a
  // `'finish'` listener. After the HTTP roundtrip resolves, microtasks
  // are still pending. One macrotask is sufficient.
  await new Promise<void>(resolve => setImmediate(resolve));
}

describe('auditMiddleware', () => {
  it('skips configured paths (/health/live, /metrics)', async () => {
    const { appender, collection } = buildAppender();
    const app = buildApp(appender);

    await request(app).get('/health/live').expect(200);
    await request(app).get('/metrics').expect(200);
    await flush();

    expect(collection.entries).toHaveLength(0);
    expect(NON_AUDITED_PATHS).toContain('/health');
    expect(NON_AUDITED_PATHS).toContain('/metrics');
  });

  it('emits one audit entry per request on response finish', async () => {
    const { appender, collection } = buildAppender();
    const app = buildApp(appender);

    await request(app)
      .post('/api/users/abc')
      .send({ name: 'alice', password: 'hunter2' })
      .expect(201);
    await flush();

    expect(collection.entries).toHaveLength(1);
    const entry = collection.entries[0]!;
    expect(entry.action).toBe('http.post./api/users/abc');
    expect(entry.resource).toBe('/api/users/abc');
    expect(entry.resourceId).toBe('abc');
    expect((entry.details as Record<string, unknown>)['statusCode']).toBe(201);
    // Sanitiser must redact password in the recorded body.
    const body = (entry.details as Record<string, unknown>)['body'] as Record<
      string,
      unknown
    >;
    expect(body['password']).toBe('<REDACTED:password>');
  });

  it('resolves actor from req.user when present', async () => {
    const { appender, collection } = buildAppender();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { user: { _id: string } }).user = { _id: 'u-42' };
      next();
    });
    app.use(auditMiddleware({ appender }));
    app.get('/api/me', (_req, res) => {
      res.json({});
    });

    await request(app).get('/api/me').expect(200);
    await flush();

    expect(collection.entries[0]?.actor.userId).toBe('u-42');
    expect(collection.entries[0]?.actor.system).toBeUndefined();
  });

  it('falls back to system actor for unauthenticated routes', async () => {
    const { appender, collection } = buildAppender();
    const app = buildApp(appender);

    await request(app).get('/api/boom').expect(500);
    await flush();

    expect(collection.entries[0]?.actor).toEqual({ system: true });
  });

  it('does not throw into the request path when the appender fails', async () => {
    const failingAppender = {
      append: jest.fn().mockRejectedValue(new Error('mongo down')),
    } as unknown as HashChainAppender;

    const app = express();
    app.use(express.json());
    app.use(auditMiddleware({ appender: failingAppender }));
    app.get('/ping', (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(app).get('/ping');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    await flush();
    expect((failingAppender.append as jest.Mock).mock.calls.length).toBe(1);
  });

  it('records sanitised headers (Authorization redacted)', async () => {
    const { appender, collection } = buildAppender();
    const app = buildApp(appender);

    await request(app)
      .get('/api/boom')
      .set('Authorization', 'Bearer abcdef')
      .expect(500);
    await flush();

    const headers = (collection.entries[0]?.details as Record<string, unknown>)[
      'headers'
    ] as Record<string, unknown>;
    expect(headers['authorization']).toBe('<REDACTED:authorization>');
  });

  // ADR-0018 — bus-based publication.

  it('publishes audit.request on the bus instead of calling append', async () => {
    const bus = new RecordingBus();
    const app = buildBusApp(bus);

    await request(app)
      .post('/api/users/zed')
      .send({ name: 'alice', password: 'hunter2' })
      .expect(201);
    await flush();

    const requests = bus.events.filter(e => e.type === 'audit.request');
    expect(requests).toHaveLength(1);
    const evt = requests[0]!;
    expect(evt.context).toBe('audit');
    expect(evt.aggregateType).toBe('request');
    const payload = evt.payload as Record<string, unknown> & {
      action: string;
      resource: string;
      details: Record<string, unknown>;
    };
    expect(payload.action).toBe('http.post./api/users/zed');
    expect(payload.resource).toBe('/api/users/zed');
    const body = payload.details['body'] as Record<string, unknown>;
    expect(body['password']).toBe('<REDACTED:password>');
  });

  it('skip-paths still apply when bus mode is on', async () => {
    const bus = new RecordingBus();
    const app = buildBusApp(bus);

    await request(app).get('/health/live').expect(200);
    await flush();
    expect(bus.events.filter(e => e.type === 'audit.request')).toHaveLength(0);
  });
});
