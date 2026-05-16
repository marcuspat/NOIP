// Domain port for the report renderer. Implementations live under
// `infrastructure/renderer/`. The application service treats this as an
// opaque pipeline that turns a `RenderInput` into a serialised body
// plus metadata; the chosen `Format` selects which adapter the
// composite uses.
//
// Streaming: `RenderResult.stream()` is the canonical entry point so
// CSV / HTML can stream large reports without buffering the whole body
// in memory. `RenderResult.buffer()` is a convenience for tests and
// small bodies — it `for await`-collects the stream into one
// `Uint8Array`.

import type { Readable } from 'node:stream';
import type { Instant } from '../../../../shared/kernel';
import type { Format, ReportKind, Scope, WidgetData } from '../value-objects';

/**
 * Input bundle handed to the renderer. The widget-data payloads have
 * already been resolved by the application service — the renderer is a
 * pure transformer from data to bytes.
 */
export interface RenderInput {
  kind: ReportKind;
  scope: Scope;
  format: Format;
  generatedAt: Instant;
  /** Title shown in the artifact header (HTML / PDF). */
  title: string;
  /** Datasets keyed by panel id. */
  panels: ReadonlyArray<RenderPanel>;
}

export interface RenderPanel {
  id: string;
  title: string;
  data: WidgetData;
}

export interface RenderResult {
  /** MIME type for the artifact. */
  contentType: string;
  /** Suggested file extension *without* the dot. */
  extension: string;
  /** Stream the rendered body — single-use; consume immediately. */
  stream(): Readable;
  /** Materialise the full body in memory. Returns the same bytes the
   * stream would yield, useful for tests + small reports. */
  buffer(): Promise<Uint8Array>;
}

export interface ReportRenderer {
  /** Set of formats this renderer can produce. */
  supports(format: Format): boolean;
  render(input: RenderInput): Promise<RenderResult>;
}
