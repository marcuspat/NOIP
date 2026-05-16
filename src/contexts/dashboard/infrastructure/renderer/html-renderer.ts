// HTML renderer — produces a self-contained document with one
// `<section>` per panel. No client-side JavaScript, no external
// stylesheet; everything inlines so the artifact remains valid when
// served as a download or pasted into an email.
//
// Security note: every dynamic value flows through `escapeHtml`. We do
// NOT pretty-print the payload via `JSON.stringify(value, null, 2)`
// then drop the result into a `<pre>` raw — we encode the JSON string
// itself so a payload containing `</pre>` cannot escape the block.

import { Readable } from 'node:stream';
import type {
  RenderInput,
  RenderResult,
  ReportRenderer,
} from '../../domain/ports/report-renderer';
import type { Format } from '../../domain/value-objects';

export function escapeHtml(value: unknown): string {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (str === undefined) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = [
  'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:32px;color:#222;}',
  'header{border-bottom:2px solid #ccc;margin-bottom:24px;padding-bottom:8px;}',
  'h1{margin:0 0 8px;font-size:24px;}',
  '.meta{color:#666;font-size:13px;}',
  'section.panel{margin-bottom:24px;padding:16px;border:1px solid #e5e5e5;border-radius:6px;background:#fafafa;}',
  'section.panel h2{margin:0 0 8px;font-size:16px;}',
  '.payload{font-family:Menlo,Consolas,monospace;font-size:12px;background:#f4f4f4;padding:12px;border-radius:4px;overflow:auto;white-space:pre-wrap;word-break:break-word;}',
  '.resolved{color:#888;font-size:11px;margin-top:4px;}',
].join('\n');

export function renderHtmlString(input: RenderInput): string {
  const head = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(input.title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<header>',
    `<h1>${escapeHtml(input.title)}</h1>`,
    `<div class="meta">kind=${escapeHtml(input.kind)} format=${escapeHtml(
      input.format
    )} generatedAt=${escapeHtml(input.generatedAt)}</div>`,
    `<div class="meta">scope=${escapeHtml(input.scope)}</div>`,
    '</header>',
  ].join('\n');

  const panels = input.panels
    .map(p => {
      const payloadJson = JSON.stringify(p.data.payload, null, 2);
      return [
        '<section class="panel">',
        `<h2>${escapeHtml(p.title)}</h2>`,
        `<div class="meta">type=${escapeHtml(p.data.widgetType)} id=${escapeHtml(p.id)}</div>`,
        `<pre class="payload">${escapeHtml(payloadJson)}</pre>`,
        `<div class="resolved">resolved at ${escapeHtml(p.data.resolvedAt)}</div>`,
        '</section>',
      ].join('\n');
    })
    .join('\n');

  const tail = '</body></html>';
  return `${head}\n${panels}\n${tail}`;
}

export class HtmlReportRenderer implements ReportRenderer {
  supports(format: Format): boolean {
    return format === 'html';
  }

  async render(input: RenderInput): Promise<RenderResult> {
    const html = renderHtmlString(input);
    const bytes = new TextEncoder().encode(html);
    return {
      contentType: 'text/html; charset=utf-8',
      extension: 'html',
      stream(): Readable {
        return Readable.from([Buffer.from(bytes)]);
      },
      async buffer(): Promise<Uint8Array> {
        return bytes;
      },
    };
  }
}
