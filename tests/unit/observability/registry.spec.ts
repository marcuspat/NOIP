// Tests for src/observability/registry.ts — ADR-0023.
//
// We deliberately use unique metric names per test (suffixing with
// the test index) so this spec is order-independent with other
// suites that may have already populated the shared registry on
// import. A bulk `register.clear()` would tear down the typed
// metrics registered by `src/observability/metrics.ts` and break
// any sibling spec that depends on them.

import { Counter, Gauge, Histogram, Registry } from 'prom-client';

import {
  DEFAULT_HISTOGRAM_BUCKETS,
  counter,
  gauge,
  histogram,
  register,
} from '../../../src/observability/registry';

describe('observability/registry', () => {
  it('exports a singleton Registry', () => {
    expect(register).toBeInstanceOf(Registry);
  });

  it('idempotently returns the same counter for repeated calls', () => {
    const a = counter('noip_test_idem_counter', 'help', ['label']);
    const b = counter('noip_test_idem_counter', 'help', ['label']);
    expect(a).toBeInstanceOf(Counter);
    expect(a).toBe(b);
  });

  it('idempotently returns the same gauge for repeated calls', () => {
    const a = gauge('noip_test_idem_gauge', 'help', ['label']);
    const b = gauge('noip_test_idem_gauge', 'help', ['label']);
    expect(a).toBeInstanceOf(Gauge);
    expect(a).toBe(b);
  });

  it('idempotently returns the same histogram for repeated calls', () => {
    const a = histogram('noip_test_idem_histogram', 'help', ['label']);
    const b = histogram('noip_test_idem_histogram', 'help', ['label']);
    expect(a).toBeInstanceOf(Histogram);
    expect(a).toBe(b);
  });

  it('exposes the ADR-0023 default histogram bucket schedule', () => {
    expect(DEFAULT_HISTOGRAM_BUCKETS).toEqual([
      0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
    ]);
  });

  it('stamps default labels (service, env, version) onto emitted metrics', async () => {
    const c = counter('noip_test_default_labels', 'help', ['outcome']);
    c.labels({ outcome: 'ok' }).inc();
    const text = await register.metrics();
    // The default labels are merged into the line for noip_test_default_labels.
    const line = text
      .split('\n')
      .find(
        l =>
          l.startsWith('noip_test_default_labels{') &&
          l.includes('outcome="ok"')
      );
    expect(line).toBeDefined();
    expect(line).toContain('service="noip"');
    expect(line).toContain('env="');
    expect(line).toContain('version="');
  });

  it('increments are observable in the registry JSON snapshot', async () => {
    const c = counter('noip_test_inc_snapshot', 'help', ['outcome']);
    c.labels({ outcome: 'ok' }).inc();
    c.labels({ outcome: 'ok' }).inc(2);
    c.labels({ outcome: 'err' }).inc();

    const json = await register.getMetricsAsJSON();
    const entry = json.find(m => m.name === 'noip_test_inc_snapshot');
    expect(entry).toBeDefined();
    const values = (
      entry as { values: Array<{ value: number; labels: Record<string, string> }> }
    ).values;
    const ok = values.find(v => v.labels['outcome'] === 'ok');
    const err = values.find(v => v.labels['outcome'] === 'err');
    expect(ok?.value).toBe(3);
    expect(err?.value).toBe(1);
  });
});
