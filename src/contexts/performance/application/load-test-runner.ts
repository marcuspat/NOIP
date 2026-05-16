// LoadTestRunner — application service that dispatches a load test to
// the right engine (autocannon / k6 / stub), waits for the engine
// summary, and completes the `LoadTest` aggregate.
//
// Engine selection is done by name; the composition root supplies the
// registered engines map. When the requested engine is missing the
// runner falls back to the first available engine; if none is
// available it fails the aggregate with `NOT_CONFIGURED`.

import type { Clock, EventBus } from '../../../shared/kernel';
import {
  NotConfiguredError,
  ProviderError,
  ValidationError,
} from '../../../shared/errors';
import type { LoadTestEngine } from '../domain/ports/load-test-engine';
import { LoadTest, type LoadTestSubmitSpec } from '../domain/load-test';
import type { LoadTestRepository } from '../infrastructure/persistence/load-test.repository';

export interface LoadTestRunnerDeps {
  engines: ReadonlyArray<LoadTestEngine>;
  loadTests: LoadTestRepository;
  bus: EventBus;
  clock: Clock;
}

export class LoadTestRunner {
  constructor(private readonly deps: LoadTestRunnerDeps) {}

  /** Submit + run + persist a load test. Returns the completed aggregate. */
  async run(spec: LoadTestSubmitSpec): Promise<LoadTest> {
    const engine = this.pickEngine(spec.engine);
    const test = LoadTest.submit(spec, this.deps.clock);
    await this.deps.loadTests.save(test);

    try {
      const summary = await engine.run({
        script: spec.script,
        target: spec.target,
        profile: spec.profile,
      });
      test.complete(summary, this.deps.clock);
    } catch (err) {
      if (err instanceof ValidationError) {
        test.fail(
          { code: 'VALIDATION_ERROR', message: err.message },
          this.deps.clock
        );
      } else if (err instanceof NotConfiguredError) {
        test.fail(
          { code: 'NOT_CONFIGURED', message: err.message },
          this.deps.clock
        );
      } else if (err instanceof ProviderError) {
        test.fail(
          { code: 'PROVIDER_ERROR', message: err.message },
          this.deps.clock
        );
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        test.fail({ code: 'INTERNAL_ERROR', message: msg }, this.deps.clock);
      }
    }

    await this.deps.loadTests.save(test);
    const events = test.drainEvents();
    if (events.length > 0) this.deps.bus.publishMany(events);
    return test;
  }

  private pickEngine(name: string): LoadTestEngine {
    const exact = this.deps.engines.find(e => e.id === name);
    if (exact) return exact;
    const first = this.deps.engines[0];
    if (!first) {
      throw new NotConfiguredError(
        'no load-test engine registered; cannot run load tests'
      );
    }
    return first;
  }
}
