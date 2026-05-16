// HTTP probe client port — domain-side interface that the
// `HttpProbeAdapter` (native fetch) and test fakes implement.

import type { HttpProbeConfig, ProbeMeasurements } from '../value-objects';

export interface HttpProbeRequest {
  target: string;
  config: HttpProbeConfig;
  /** Timeout in milliseconds. */
  timeoutMs: number;
}

export interface HttpProbeResponse {
  latencyMs: number;
  success: boolean;
  failureReason?: string;
  measurements: ProbeMeasurements;
}

export interface HttpProbeClient {
  execute(req: HttpProbeRequest): Promise<HttpProbeResponse>;
}
