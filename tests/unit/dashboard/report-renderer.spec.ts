// Report renderer unit tests for the four registered formats.
//
// We cover: format support gating, content-type / extension stamping,
// buffered vs streamed output equivalence, HTML escaping, CSV
// formatting, and the PDF fallback path.

import {
  CsvReportRenderer,
  HtmlReportRenderer,
  JsonReportRenderer,
  PdfReportRenderer,
  escapeHtml,
  renderHtmlString,
} from '../../../src/contexts/dashboard/api';
import type {
  RenderInput,
  RenderPanel,
} from '../../../src/contexts/dashboard/domain/ports/report-renderer';
import { FixedClock, asInstant } from '../../../src/shared/kernel';

const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));

function panel(overrides: Partial<RenderPanel> = {}): RenderPanel {
  return {
    id: 'p1',
    title: 'Panel 1',
    data: {
      widgetType: 'metric',
      payload: { value: 42 },
      resolvedAt: clock.nowInstant(),
    },
    ...overrides,
  };
}

function input(overrides: Partial<RenderInput> = {}): RenderInput {
  return {
    kind: 'executive_summary',
    scope: {},
    format: 'json',
    generatedAt: clock.nowInstant(),
    title: 'Test Report',
    panels: [panel()],
    ...overrides,
  };
}

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString('utf8');
}

describe('JsonReportRenderer', () => {
  const renderer = new JsonReportRenderer();

  it('only supports json', () => {
    expect(renderer.supports('json')).toBe(true);
    expect(renderer.supports('csv')).toBe(false);
  });

  it('stamps content-type + extension', async () => {
    const r = await renderer.render(input());
    expect(r.contentType).toBe('application/json; charset=utf-8');
    expect(r.extension).toBe('json');
  });

  it('renders the panels into the output', async () => {
    const r = await renderer.render(input());
    const buf = Buffer.from(await r.buffer()).toString('utf8');
    const parsed = JSON.parse(buf);
    expect(parsed.title).toBe('Test Report');
    expect(parsed.panels[0].id).toBe('p1');
    expect(parsed.panels[0].data.payload.value).toBe(42);
  });

  it('stream() and buffer() yield identical bytes', async () => {
    const r = await renderer.render(input());
    const fromStream = await streamToString(r.stream());
    const fromBuffer = Buffer.from(await r.buffer()).toString('utf8');
    expect(fromStream).toBe(fromBuffer);
  });
});

describe('CsvReportRenderer', () => {
  const renderer = new CsvReportRenderer();

  it('only supports csv', () => {
    expect(renderer.supports('csv')).toBe(true);
    expect(renderer.supports('json')).toBe(false);
  });

  it('stream and buffer agree byte-for-byte', async () => {
    const r = await renderer.render(input());
    const fromStream = await streamToString(r.stream());
    const fromBuffer = Buffer.from(await r.buffer()).toString('utf8');
    expect(fromStream).toBe(fromBuffer);
  });

  it('emits metadata + a header row + one data row per panel', async () => {
    const r = await renderer.render(
      input({
        panels: [
          panel({ id: 'a', title: 'A' }),
          panel({ id: 'b', title: 'B' }),
        ],
      })
    );
    const text = await streamToString(r.stream());
    const lines = text.trim().split('\r\n');
    expect(lines.find(l => l.startsWith('#title,'))).toBeDefined();
    expect(lines).toContain('panelId,panelTitle,widgetType,resolvedAt,payload');
    // Header + 2 panel rows + 5 metadata rows = 8 lines.
    expect(lines.length).toBe(8);
  });

  it('escapes commas and quotes per RFC-4180', async () => {
    const r = await renderer.render(
      input({
        panels: [
          panel({
            id: 'p',
            title: 'a,"b"',
            data: {
              widgetType: 'metric',
              payload: 'has "quote", and comma',
              resolvedAt: asInstant('2026-05-10T00:00:00.000Z'),
            },
          }),
        ],
      })
    );
    const text = await streamToString(r.stream());
    // Title `a,"b"` becomes `"a,""b"""` (wrap + double the inner quotes).
    expect(text).toContain('"a,""b"""');
    // The payload is a string; csvEscape doubles each inner quote
    // and wraps the value in quotes. We assert on the row directly.
    expect(text).toContain('"has ""quote"", and comma"');
  });

  it('streams large reports without buffering everything up-front', async () => {
    const panels: RenderPanel[] = [];
    for (let i = 0; i < 5000; i++) {
      panels.push(
        panel({
          id: `p-${i}`,
          title: `Panel ${i}`,
          data: {
            widgetType: 'metric',
            payload: { i },
            resolvedAt: clock.nowInstant(),
          },
        })
      );
    }
    const r = await renderer.render(input({ panels }));
    let chunks = 0;
    let bytes = 0;
    for await (const chunk of r.stream()) {
      chunks += 1;
      bytes += (chunk as Buffer).byteLength;
    }
    // The async iterator yields one chunk per line, so we expect way
    // more than one chunk; this is what proves it streams.
    expect(chunks).toBeGreaterThan(panels.length);
    expect(bytes).toBeGreaterThan(0);
  });
});

describe('HtmlReportRenderer', () => {
  const renderer = new HtmlReportRenderer();

  it('supports html only', () => {
    expect(renderer.supports('html')).toBe(true);
    expect(renderer.supports('pdf')).toBe(false);
  });

  it('escapes panel titles and payload', async () => {
    const r = await renderer.render(
      input({
        title: '<script>alert(1)</script>',
        panels: [
          panel({
            title: '<img onerror=x>',
            data: {
              widgetType: 'metric',
              payload: { html: '<b>bold</b>' },
              resolvedAt: clock.nowInstant(),
            },
          }),
        ],
      })
    );
    const text = await streamToString(r.stream());
    expect(text).not.toContain('<script>alert(1)</script>');
    expect(text).toContain('&lt;script&gt;');
    expect(text).toContain('&lt;img onerror=x&gt;');
  });

  it('exposes renderHtmlString and escapeHtml as named exports', () => {
    expect(typeof renderHtmlString).toBe('function');
    expect(escapeHtml('<a>')).toBe('&lt;a&gt;');
  });
});

describe('PdfReportRenderer', () => {
  it('falls back to HTML when no Chromium factory is wired', async () => {
    const renderer = new PdfReportRenderer();
    const r = await renderer.render(input({ format: 'pdf' }));
    expect(r.extension).toBe('html');
    expect(r.contentType.startsWith('text/html')).toBe(true);
    const text = await streamToString(r.stream());
    expect(text).toContain('Test Report');
  });

  it('uses the supplied factory when available', async () => {
    const renderer = new PdfReportRenderer({
      factory: {
        load() {
          return {
            async htmlToPdf() {
              return new TextEncoder().encode('%PDF-stub%');
            },
          };
        },
      },
    });
    const r = await renderer.render(input({ format: 'pdf' }));
    expect(r.extension).toBe('pdf');
    expect(r.contentType).toBe('application/pdf');
    const buf = Buffer.from(await r.buffer()).toString('utf8');
    expect(buf).toBe('%PDF-stub%');
  });

  it('htmlFallbackKeepsHtmlMime=false stamps PDF mime on the fallback bytes', async () => {
    const renderer = new PdfReportRenderer({
      htmlFallbackKeepsHtmlMime: false,
    });
    const r = await renderer.render(input({ format: 'pdf' }));
    expect(r.contentType).toBe('application/pdf');
    expect(r.extension).toBe('pdf');
  });
});
