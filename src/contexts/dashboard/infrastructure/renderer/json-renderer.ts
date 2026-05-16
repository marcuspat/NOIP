// JSON renderer — emits a single JSON document containing the input
// envelope plus each panel's resolved payload. Suitable for machine
// consumers; the HTML renderer wraps the same data for humans.

import { Readable } from 'node:stream';
import type {
  RenderInput,
  RenderResult,
  ReportRenderer,
} from '../../domain/ports/report-renderer';
import type { Format } from '../../domain/value-objects';

export class JsonReportRenderer implements ReportRenderer {
  supports(format: Format): boolean {
    return format === 'json';
  }

  async render(input: RenderInput): Promise<RenderResult> {
    const body = JSON.stringify(
      {
        title: input.title,
        kind: input.kind,
        scope: input.scope,
        format: input.format,
        generatedAt: input.generatedAt,
        panels: input.panels.map(p => ({
          id: p.id,
          title: p.title,
          data: p.data,
        })),
      },
      null,
      2
    );
    const bytes = new TextEncoder().encode(body);
    return {
      contentType: 'application/json; charset=utf-8',
      extension: 'json',
      stream(): Readable {
        return Readable.from([Buffer.from(bytes)]);
      },
      async buffer(): Promise<Uint8Array> {
        return bytes;
      },
    };
  }
}
