// HTTP edge for the Discovery context.
//
// Endpoints per DDD-06:
//   - GET    /clusters
//   - POST   /clusters
//   - DELETE /clusters/:id
//   - GET    /clusters/:id
//   - POST   /clusters/:id/scan
//   - GET    /clusters/:id/snapshots
//   - GET    /clusters/:id/snapshots/:snapshotId
//   - GET    /clusters/:id/resources?namespace=&kind=…
//   - GET    /clusters/:id/namespaces
//   - GET    /clusters/:id/nodes
//   - GET    /clusters/:id/drift
//   - GET    /drift/:driftId
//
// Plus legacy aliases that the existing integration suite hits:
//   - GET    /cluster, /resources, /namespaces, /nodes
//
// All errors flow through the `toHttpResponse` mapper from the shared
// errors module so we never leak stack traces.

import express, { type Request, type Response, type Router } from 'express';
import {
  toHttpResponse,
  ValidationError,
  isDomainError,
} from '../../../shared/errors';
import type { DiscoveryService } from '../application/discovery.service';
import type { ClusterId, DriftId, SnapshotId } from '../../../shared/kernel';
import { tryParseId } from '../../../shared/kernel';

function send(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

function ok(res: Response, data: unknown, status = 200): void {
  send(res, status, { success: true, data });
}

function fail(res: Response, err: unknown): void {
  const mapped = toHttpResponse(err);
  send(res, mapped.status, { success: false, ...mapped.body });
}

function parseClusterId(raw: string): ClusterId {
  const id = tryParseId<ClusterId>(raw);
  if (!id) throw new ValidationError('invalid cluster id', { id: raw });
  return id;
}

function parseSnapshotId(raw: string): SnapshotId {
  const id = tryParseId<SnapshotId>(raw);
  if (!id) throw new ValidationError('invalid snapshot id', { id: raw });
  return id;
}

function parseDriftId(raw: string): DriftId {
  const id = tryParseId<DriftId>(raw);
  if (!id) throw new ValidationError('invalid drift id', { id: raw });
  return id;
}

export interface DiscoveryRoutesOptions {
  /**
   * When true, mount the legacy `/cluster`, `/resources`, `/namespaces`,
   * `/nodes` aliases. Defaults to true; tests that just want the
   * canonical endpoints set this to false.
   */
  legacy?: boolean;
}

/**
 * Returns an Express router that calls into the supplied
 * DiscoveryService. The router is stateless — re-mountable across
 * request cycles.
 */
export function discoveryRoutes(
  service: DiscoveryService,
  opts: DiscoveryRoutesOptions = {}
): Router {
  const router = express.Router();
  const legacy = opts.legacy !== false;

  // ---------------------------------------------------------------------------
  // Clusters
  // ---------------------------------------------------------------------------
  router.get('/clusters', async (_req: Request, res: Response) => {
    try {
      const clusters = await service.listClusters();
      ok(
        res,
        clusters.map((c) => c.toPersistence())
      );
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/clusters', async (req: Request, res: Response) => {
    try {
      const body = req.body as Record<string, unknown>;
      const name = typeof body['name'] === 'string' ? body['name'] : '';
      const endpoint =
        typeof body['endpoint'] === 'string' ? body['endpoint'] : '';
      const credentials = body['credentials'];
      if (
        typeof credentials !== 'object' ||
        credentials === null ||
        typeof (credentials as { ref?: unknown }).ref !== 'string'
      ) {
        throw new ValidationError(
          'credentials.ref is required',
          { received: credentials }
        );
      }
      const cluster = await service.registerCluster({
        name,
        endpoint,
        credentials: { ref: (credentials as { ref: string }).ref },
        ...(typeof body['version'] === 'string'
          ? { version: body['version'] }
          : {}),
      });
      ok(res, cluster.toPersistence(), 201);
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/clusters/:id', async (req: Request, res: Response) => {
    try {
      const id = parseClusterId(req.params['id'] ?? '');
      const cluster = await service.getCluster(id);
      ok(res, cluster.toPersistence());
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete('/clusters/:id', async (req: Request, res: Response) => {
    try {
      const id = parseClusterId(req.params['id'] ?? '');
      await service.deleteCluster(id);
      send(res, 204, '');
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/clusters/:id/scan', async (req: Request, res: Response) => {
    try {
      const id = parseClusterId(req.params['id'] ?? '');
      const result = await service.triggerScan(id);
      const status = result.status === 'failed' ? 502 : 202;
      send(res, status, { success: result.status !== 'failed', data: result });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---------------------------------------------------------------------------
  // Snapshots
  // ---------------------------------------------------------------------------
  router.get('/clusters/:id/snapshots', async (req: Request, res: Response) => {
    try {
      const id = parseClusterId(req.params['id'] ?? '');
      const range: { from?: Date; to?: Date } = {};
      if (typeof req.query['from'] === 'string')
        range.from = new Date(req.query['from']);
      if (typeof req.query['to'] === 'string')
        range.to = new Date(req.query['to']);
      const limit =
        typeof req.query['limit'] === 'string'
          ? parseInt(req.query['limit'], 10)
          : undefined;
      const list = await service.listSnapshots(id, range, limit);
      ok(res, list);
    } catch (err) {
      fail(res, err);
    }
  });

  router.get(
    '/clusters/:id/snapshots/:snapshotId',
    async (req: Request, res: Response) => {
      try {
        // The cluster id parsing is purely defensive — we look up
        // by snapshot id alone.
        parseClusterId(req.params['id'] ?? '');
        const snapshotId = parseSnapshotId(req.params['snapshotId'] ?? '');
        const snap = await service.getLatestSnapshotById(snapshotId);
        ok(res, snap.toPersistence());
      } catch (err) {
        fail(res, err);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Resources / namespaces / nodes (per-cluster forms)
  // ---------------------------------------------------------------------------
  router.get(
    '/clusters/:id/resources',
    async (req: Request, res: Response) => {
      try {
        const namespace =
          typeof req.query['namespace'] === 'string'
            ? req.query['namespace']
            : undefined;
        // We always serve the latest snapshot; richer filtering
        // (kind, label) is added in Phase 5.
        const id = parseClusterId(req.params['id'] ?? '');
        const snap = await service.getLatestSnapshot(id);
        const records = snap.records.filter((r) =>
          namespace === undefined ? true : r.namespace === namespace
        );
        ok(res, records);
      } catch (err) {
        fail(res, err);
      }
    }
  );

  router.get(
    '/clusters/:id/namespaces',
    async (_req: Request, res: Response) => {
      try {
        const namespaces = await service.getNamespaces();
        ok(res, namespaces);
      } catch (err) {
        fail(res, err);
      }
    }
  );

  router.get('/clusters/:id/nodes', async (_req: Request, res: Response) => {
    try {
      const nodes = await service.getNodeInfo();
      ok(res, nodes);
    } catch (err) {
      fail(res, err);
    }
  });

  // ---------------------------------------------------------------------------
  // Drift
  // ---------------------------------------------------------------------------
  router.get('/clusters/:id/drift', async (req: Request, res: Response) => {
    try {
      const id = parseClusterId(req.params['id'] ?? '');
      const list = await service.listDriftReports(id);
      ok(
        res,
        list.map((d) => d.toPersistence())
      );
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/drift/:driftId', async (req: Request, res: Response) => {
    try {
      const driftId = parseDriftId(req.params['driftId'] ?? '');
      const r = await service.getDriftReport(driftId);
      ok(res, r.toPersistence());
    } catch (err) {
      fail(res, err);
    }
  });

  // ---------------------------------------------------------------------------
  // Legacy aliases (kept stable for the existing integration suite)
  // ---------------------------------------------------------------------------
  if (legacy) {
    router.get('/cluster', async (_req, res) => {
      try {
        const info = await service.scanCluster();
        ok(res, info);
      } catch (err) {
        fail(res, err);
      }
    });

    router.get('/resources', async (req, res) => {
      try {
        const namespace =
          typeof req.query['namespace'] === 'string'
            ? req.query['namespace']
            : undefined;
        const records = await service.getResources(namespace);
        // The legacy contract used `metadata.{name,namespace,labels,annotations}`,
        // so we re-shape the new domain record onto it for backwards
        // compatibility. We do NOT touch the canonical surface.
        const projected = records.map((r) => ({
          apiVersion: r.apiVersion,
          kind: r.kind,
          metadata: {
            name: r.name,
            ...(r.namespace !== undefined ? { namespace: r.namespace } : {}),
            labels: r.labels,
            annotations: r.annotations,
          },
          spec: r.spec,
          status: r.status,
        }));
        ok(res, projected);
      } catch (err) {
        fail(res, err);
      }
    });

    router.get('/namespaces', async (_req, res) => {
      try {
        const list = await service.getNamespaces();
        ok(res, list);
      } catch (err) {
        fail(res, err);
      }
    });

    router.get('/nodes', async (_req, res) => {
      try {
        const list = await service.getNodeInfo();
        ok(res, list);
      } catch (err) {
        fail(res, err);
      }
    });
  }

  // Catch-all error handler so a non-domain-error exception still
  // gets the canonical envelope.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  router.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    if (isDomainError(err)) {
      fail(res, err);
      return;
    }
    fail(res, err);
  });

  return router;
}

export default discoveryRoutes;
