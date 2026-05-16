// ReportService unit tests — exercises generate-success, generate-fail,
// list filtering, and the artifact stream path.

import { ReportService } from '../../../src/contexts/dashboard/application/report.service';
import { InMemoryReportRepository } from '../../../src/contexts/dashboard/infrastructure/persistence/report.repository';
import { JsonReportRenderer } from '../../../src/contexts/dashboard/infrastructure/renderer/json-renderer';
import { CsvReportRenderer } from '../../../src/contexts/dashboard/infrastructure/renderer/csv-renderer';
import { LocalFsObjectStorageAdapter } from '../../../src/contexts/dashboard/infrastructure/object-storage/local-fs-storage-adapter';
import {
  FixedClock,
  type DomainEvent,
  type EventBus,
  type UserId,
} from '../../../src/shared/kernel';
import {
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../../../src/shared/errors';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'noip-report-'));
}

function makeBus(): { bus: EventBus; published: DomainEvent<unknown>[] } {
  const published: DomainEvent<unknown>[] = [];
  const bus: EventBus = {
    publish: e => published.push(e),
    publishMany: events => events.forEach(e => published.push(e)),
    subscribe: () => () => undefined,
  };
  return { bus, published };
}

describe('ReportService', () => {
  const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));

  async function makeService() {
    const root = await tmpRoot();
    const repository = new InMemoryReportRepository();
    const { bus, published } = makeBus();
    const storage = new LocalFsObjectStorageAdapter({ root });
    const service = new ReportService({
      repository,
      storage,
      renderers: [new JsonReportRenderer(), new CsvReportRenderer()],
      bus,
      clock,
    });
    return { service, repository, published, storage, root };
  }

  it('generateReport renders, persists, uploads, and publishes report.generated', async () => {
    const { service, published, root } = await makeService();
    const report = await service.generateReport({
      kind: 'executive_summary',
      scope: {},
      format: 'json',
      generatedBy: { userId: 'u1' as UserId },
    });
    expect(report.status).toBe('generated');
    expect(report.artifactUri?.startsWith('file://')).toBe(true);
    expect(report.artifactKey?.startsWith('dashboard/reports/')).toBe(true);
    expect(published.map(e => e.type)).toEqual(['report.generated']);
    // Artifact actually exists on disk.
    const fullPath = path.join(root, report.artifactKey!);
    const bytes = await fs.readFile(fullPath, 'utf8');
    expect(bytes).toContain('"kind":');
  });

  it('generateReport rejects an unsupported format up front', async () => {
    const { service } = await makeService();
    await expect(
      service.generateReport({
        kind: 'posture',
        scope: {},
        format: 'pdf',
        generatedBy: { userId: 'u1' as UserId },
      })
    ).rejects.toThrow(ValidationError);
  });

  it('generateReport accepts custom panels and renders them', async () => {
    const { service } = await makeService();
    const report = await service.generateReport({
      kind: 'incident',
      scope: {},
      format: 'csv',
      generatedBy: { userId: 'u1' as UserId },
      panels: [
        {
          id: 'one',
          title: 'One',
          data: {
            widgetType: 'metric',
            payload: { v: 1 },
            resolvedAt: clock.nowInstant(),
          },
        },
      ],
    });
    expect(report.format).toBe('csv');
    expect(report.artifactKey?.endsWith('.csv')).toBe(true);
  });

  it('generateReport marks the row failed when rendering throws', async () => {
    const root = await tmpRoot();
    const repository = new InMemoryReportRepository();
    const { bus, published } = makeBus();
    const storage = new LocalFsObjectStorageAdapter({ root });
    const failingRenderer = {
      supports: (f: string) => f === 'json',
      async render(): Promise<never> {
        throw new Error('renderer boom');
      },
    };
    const service = new ReportService({
      repository,
      storage,
      renderers: [failingRenderer as never],
      bus,
      clock,
    });
    await expect(
      service.generateReport({
        kind: 'posture',
        scope: {},
        format: 'json',
        generatedBy: { userId: 'u1' as UserId },
      })
    ).rejects.toThrow('renderer boom');
    // No success event published.
    expect(published).toHaveLength(0);
    // Failure status persisted.
    const rows = await repository.list({});
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.failureReason).toBe('renderer boom');
  });

  it('listReports filters and requires auth', async () => {
    const { service } = await makeService();
    await service.generateReport({
      kind: 'executive_summary',
      scope: {},
      format: 'json',
      generatedBy: { userId: 'u1' as UserId },
    });
    await service.generateReport({
      kind: 'compliance',
      scope: {},
      format: 'csv',
      generatedBy: { userId: 'u1' as UserId },
    });
    await expect(service.listReports({}, null)).rejects.toThrow(
      UnauthorizedError
    );
    const principal = { userId: 'u1' as UserId };
    const csvs = await service.listReports({ format: 'csv' }, principal);
    expect(csvs).toHaveLength(1);
    expect(csvs[0]!.kind).toBe('compliance');
  });

  it('getArtifact returns 404 on missing reports', async () => {
    const { service } = await makeService();
    await expect(
      service.getArtifact('00000000-0000-7000-8000-000000000123' as never, {
        userId: 'u1' as UserId,
      })
    ).rejects.toThrow(NotFoundError);
  });

  it('getArtifact streams the persisted bytes for a generated report', async () => {
    const { service } = await makeService();
    const report = await service.generateReport({
      kind: 'executive_summary',
      scope: {},
      format: 'json',
      generatedBy: { userId: 'u1' as UserId },
    });
    const principal = { userId: 'u1' as UserId };
    const out = await service.getArtifact(report.id, principal);
    const chunks: Buffer[] = [];
    for await (const chunk of out.stream) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    expect(text).toContain('Executive Summary');
  });
});
