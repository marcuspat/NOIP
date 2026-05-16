// CSV renderer — streams a row per panel so large reports never
// materialise as one giant string in memory.
//
// Output layout (RFC-4180 + a metadata block):
//
//   #title,<title>
//   #generatedAt,<iso>
//   #kind,<kind>
//   #format,csv
//   panelId,panelTitle,widgetType,resolvedAt,payload
//   <id>,<title>,<type>,<resolvedAt>,<json-encoded-payload>
//
// The metadata block is prefixed with `#` so spreadsheet importers can
// either skip it (Excel `Data > From Text` lets the user pick the
// header row) or ingest it as commented context.

import { Readable } from 'node:stream';
import type {
  RenderInput,
  RenderResult,
  ReportRenderer,
} from '../../domain/ports/report-renderer';
import type { Format } from '../../domain/value-objects';

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  // Always wrap in quotes when there's any of CR, LF, comma, or quote.
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Async-iterable line generator. Each yielded line ends in `\r\n` per
 * RFC-4180. The renderer wraps this generator in a `Readable.from` —
 * Node's stream API turns the iterator into back-pressure-aware
 * chunks, which is the whole point of streaming for very large
 * reports.
 */
async function* renderLines(input: RenderInput): AsyncGenerator<string> {
  yield `#title,${csvEscape(input.title)}\r\n`;
  yield `#kind,${csvEscape(input.kind)}\r\n`;
  yield `#format,${csvEscape(input.format)}\r\n`;
  yield `#generatedAt,${csvEscape(input.generatedAt)}\r\n`;
  yield `#scope,${csvEscape(input.scope)}\r\n`;
  yield `panelId,panelTitle,widgetType,resolvedAt,payload\r\n`;
  for (const panel of input.panels) {
    const row = [
      csvEscape(panel.id),
      csvEscape(panel.title),
      csvEscape(panel.data.widgetType),
      csvEscape(panel.data.resolvedAt),
      csvEscape(panel.data.payload),
    ].join(',');
    yield `${row}\r\n`;
  }
}

export class CsvReportRenderer implements ReportRenderer {
  supports(format: Format): boolean {
    return format === 'csv';
  }

  async render(input: RenderInput): Promise<RenderResult> {
    return {
      contentType: 'text/csv; charset=utf-8',
      extension: 'csv',
      stream(): Readable {
        // Convert string iterator to Buffer chunks so the consumer can
        // treat the stream as binary if needed.
        async function* asBuffers(): AsyncGenerator<Buffer> {
          for await (const line of renderLines(input)) {
            yield Buffer.from(line, 'utf8');
          }
        }
        return Readable.from(asBuffers());
      },
      async buffer(): Promise<Uint8Array> {
        const chunks: Buffer[] = [];
        for await (const line of renderLines(input)) {
          chunks.push(Buffer.from(line, 'utf8'));
        }
        return new Uint8Array(Buffer.concat(chunks));
      },
    };
  }
}
