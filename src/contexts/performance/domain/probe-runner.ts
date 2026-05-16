// ProbeRunner — domain service that executes a single `Probe` and
// returns a `ProbeResult`. Pure orchestration: the runner picks an
// adapter by `probe.kind`, drives it, and translates the adapter
// response into a domain `ProbeResult`. Persistence and event
// publication live in the application service.
//
// Today only `http` is implemented end-to-end; the other kinds
// (`tcp`, `dns`, `grpc`) fall through to a stub that records a failed
// result with a clear "not implemented" reason. The runner never
// throws — adapter failures surface as `success === false` results so
// the aggregate's `performance.probe.failed` event fires uniformly.

import type { Clock, SLOId } from '../../../shared/kernel';
import type { HttpProbeClient } from './ports/http-probe-client';
import { Probe } from './probe';
import { ProbeResult } from './probe-result';
import type { HttpProbeConfig, ProbeMeasurements } from './value-objects';

export interface ProbeRunnerDeps {
  http: HttpProbeClient;
  clock: Clock;
}

export class ProbeRunner {
  constructor(private readonly deps: ProbeRunnerDeps) {}

  /**
   * Execute the probe. Always resolves with a `ProbeResult` — adapter
   * exceptions are caught and translated into a failed result.
   */
  async run(probe: Probe): Promise<ProbeResult> {
    const sloId = (probe.sloId ?? null) as SLOId | null;
    const timeoutMs = probe.schedule.timeoutMs ?? 5_000;

    try {
      switch (probe.kind) {
        case 'http': {
          const cfg = probe.config as HttpProbeConfig;
          const resp = await this.deps.http.execute({
            target: probe.target,
            config: cfg ?? {},
            timeoutMs,
          });
          const spec: Parameters<typeof ProbeResult.record>[0] = {
            probeId: probe.id,
            target: probe.target,
            latencyMs: resp.latencyMs,
            success: resp.success,
            measurements: resp.measurements,
            sloId,
          };
          if (!resp.success) {
            spec.failureReason = resp.failureReason ?? 'http probe failed';
          }
          return ProbeResult.record(spec, this.deps.clock);
        }
        // The other probe kinds are reserved for Phase-2 adapters; we
        // record a failed result so dashboards highlight the gap.
        case 'tcp':
        case 'dns':
        case 'grpc': {
          return ProbeResult.record(
            {
              probeId: probe.id,
              target: probe.target,
              latencyMs: 0,
              success: false,
              failureReason: `probe kind '${probe.kind}' not implemented`,
              measurements: {} as ProbeMeasurements,
              sloId,
            },
            this.deps.clock
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return ProbeResult.record(
        {
          probeId: probe.id,
          target: probe.target,
          latencyMs: 0,
          success: false,
          failureReason: msg,
          measurements: {} as ProbeMeasurements,
          sloId,
        },
        this.deps.clock
      );
    }
  }
}
