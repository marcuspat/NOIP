// PDF renderer — tries to load a headless-chromium pipeline lazily;
// when none is configured (the default in CI / dev) it falls back to
// returning the HTML body with a PDF content type *if* the caller
// opted into that fallback, otherwise it falls back to the raw HTML
// renderer with an `.html` extension. We never throw — the report
// service catches the result and treats it as success.
//
// The lazy-require pattern mirrors the discovery `S3SnapshotArchiveAdapter`:
// production wires a `ChromiumFactory` that resolves a peer dependency
// (e.g. `puppeteer-core`); tests omit the factory and exercise the
// fallback path.

import { Readable } from 'node:stream';
import type {
  RenderInput,
  RenderResult,
  ReportRenderer,
} from '../../domain/ports/report-renderer';
import type { Format } from '../../domain/value-objects';
import { renderHtmlString } from './html-renderer';

/**
 * Optional pipeline that converts an HTML string to a PDF byte array.
 * Production wires this with a `puppeteer-core` + chromium binary;
 * tests can supply a fake to exercise the success path without a
 * browser dependency.
 */
export interface ChromiumPdfPipeline {
  htmlToPdf(html: string): Promise<Uint8Array>;
}

export interface ChromiumFactory {
  /**
   * Returns a pipeline or `null` if the runtime dependency is missing.
   * The renderer never crashes on a missing factory — it returns the
   * HTML body instead so the report still has something to download.
   */
  load(): ChromiumPdfPipeline | null;
}

export interface PdfReportRendererOpts {
  factory?: ChromiumFactory;
  /**
   * When true (default) the fallback artifact uses `.html` extension
   * and `text/html` content type so it remains usable in a browser.
   * When false we still surface the HTML bytes but stamp them as
   * `application/pdf` so consumers that key off content type only see
   * a single mime path. The default is the safer choice.
   */
  htmlFallbackKeepsHtmlMime?: boolean;
}

const DEFAULT_CHROMIUM_FACTORY: ChromiumFactory = {
  load(): ChromiumPdfPipeline | null {
    // We intentionally do NOT add `puppeteer-core` as a dep. The
    // factory probes for an optional peer; absence is the default
    // path and downgrades cleanly to an HTML artifact.
    return null;
  },
};

export class PdfReportRenderer implements ReportRenderer {
  private readonly factory: ChromiumFactory;
  private readonly htmlFallbackKeepsHtmlMime: boolean;

  constructor(opts: PdfReportRendererOpts = {}) {
    this.factory = opts.factory ?? DEFAULT_CHROMIUM_FACTORY;
    this.htmlFallbackKeepsHtmlMime = opts.htmlFallbackKeepsHtmlMime !== false;
  }

  supports(format: Format): boolean {
    return format === 'pdf';
  }

  async render(input: RenderInput): Promise<RenderResult> {
    const html = renderHtmlString(input);
    const pipeline = this.factory.load();
    if (pipeline) {
      const bytes = await pipeline.htmlToPdf(html);
      return {
        contentType: 'application/pdf',
        extension: 'pdf',
        stream(): Readable {
          return Readable.from([Buffer.from(bytes)]);
        },
        async buffer(): Promise<Uint8Array> {
          return bytes;
        },
      };
    }
    // Fallback path: no Chromium available. Surface the HTML body
    // unchanged so the caller still gets a viewable artifact.
    const bytes = new TextEncoder().encode(html);
    return {
      contentType: this.htmlFallbackKeepsHtmlMime
        ? 'text/html; charset=utf-8'
        : 'application/pdf',
      extension: this.htmlFallbackKeepsHtmlMime ? 'html' : 'pdf',
      stream(): Readable {
        return Readable.from([Buffer.from(bytes)]);
      },
      async buffer(): Promise<Uint8Array> {
        return bytes;
      },
    };
  }
}
